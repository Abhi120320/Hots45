"""FireLedger API — serves the harmonized FIRMS data contract written by data_prep/fire_harmonize.py.

Run from the repo root: uvicorn backend.main:app
"""
import csv
import io
import json
import os
import re
import sys
from functools import lru_cache
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "data_prep"))
from fire_harmonize import all_months, anomalies  # noqa: E402  same analytics as the offline pipeline

DATA = Path(os.environ.get("APP_DATA", ROOT / "backend" / "app_data"))
META = json.loads((DATA / "meta.json").read_text())
CELLS = str(DATA / "cells.parquet")
COARSE_DEG = META.get("coarse_grid_deg")
COARSE = str(DATA / f"cells_{COARSE_DEG}.parquet") if COARSE_DEG else None
if COARSE and not Path(COARSE).exists():
    COARSE = None
_pts = DATA / "points.parquet"
POINTS_PARTITIONED = _pts.is_dir()  # fire_harmonize writes points.parquet/year=YYYY/*.parquet
POINTS = (f"read_parquet('{_pts}/*/*.parquet', hive_partitioning=true)" if POINTS_PARTITIONED
          else f"read_parquet('{_pts}')")
MONTHS = list(all_months(META["first_month"], META["last_month"]))
LAST_COMPLETE = META.get("last_complete_month", META["last_month"])
GAP_MONTHS = META.get("gap_months", [])
NOTES = META.get("month_notes", {})
MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")

db = duckdb.connect()

# Harmonization factors from meta.json, for the "MODIS x k" series: tile factor, else calendar-month, else global.
TILE_DEG = META.get("tile_deg", 360)
_tiles = pd.DataFrame([(int(float(key.split(",")[0]) // TILE_DEG), int(float(key.split(",")[1]) // TILE_DEG), int(c), k)
                       for key, t in META.get("factor_by_tile", {}).items() for c, k in t["k"].items()],
                      columns=["tx", "ty", "cal", "k"]).astype({"tx": "int32", "ty": "int32", "cal": "int32", "k": "float64"})
_cal = pd.DataFrame([(int(c), k) for c, k in META.get("factor_by_month", {}).items()], columns=["cal", "k"]
                    ).astype({"cal": "int32", "k": "float64"})
db.execute("CREATE TABLE tile_k AS SELECT * FROM _tiles")
db.execute("CREATE TABLE cal_k AS SELECT * FROM _cal")
K_GLOBAL = float(META.get("factor_global", 1.0))

app = FastAPI(title="FireLedger API")
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
                   allow_methods=["GET"], allow_headers=["*"])


# ---------- validation ----------
def parse_month(v, default, name):
    if v is None:
        return default
    if not MONTH_RE.match(v):
        raise HTTPException(400, f"{name} must be YYYY-MM, got {v!r}")
    return v


def parse_range(start, end):
    s = parse_month(start, META["first_month"], "start")
    e = parse_month(end, META["last_month"], "end")
    if s > e:
        raise HTTPException(400, f"start {s} is after end {e}")
    return s, e


def parse_bbox(bbox):
    """'lon0,lat0,lon1,lat1' -> tuple, or None for the whole dataset."""
    if not bbox:
        return None
    try:
        lon0, lat0, lon1, lat1 = (float(x) for x in bbox.split(","))
    except ValueError:
        raise HTTPException(400, "bbox must be four numbers: lon0,lat0,lon1,lat1")
    if not (-180 <= lon0 < lon1 <= 180 and -90 <= lat0 < lat1 <= 90):
        raise HTTPException(400, "bbox needs -180<=lon0<lon1<=180 and -90<=lat0<lat1<=90")
    return lon0, lat0, lon1, lat1


def where(bbox, start=None, end=None):
    sql, params = ["TRUE"], []
    if bbox:
        sql.append("lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?")
        params += [bbox[0], bbox[2], bbox[1], bbox[3]]
    if start:
        sql.append("month BETWEEN ? AND ?")
        params += [start, end]
    return " AND ".join(sql), params


def q(sql, params):
    return db.cursor().execute(sql, params).df()


def records(df):
    return json.loads(df.to_json(orient="records"))  # NaN -> null


# ---------- analytics ----------
@lru_cache(maxsize=256)  # data is immutable while the process runs
def series(bbox):
    w, p = where(bbox)
    df = q(f"""SELECT month, sum(hotspots) hotspots, sum(modis)::BIGINT modis, sum(viirs)::BIGINT viirs,
                      sum(modis * coalesce(t.k, m.k, ?)) modis_scaled
               FROM read_parquet('{CELLS}') c
               LEFT JOIN tile_k t ON t.tx = floor(c.lon / {TILE_DEG})::INT AND t.ty = floor(c.lat / {TILE_DEG})::INT
                                 AND t.cal = substr(c.month, 6, 2)::INT
               LEFT JOIN cal_k m ON m.cal = substr(c.month, 6, 2)::INT
               WHERE {w} GROUP BY month""", [K_GLOBAL] + p).set_index("month")
    df = df.reindex(MONTHS, fill_value=0)
    out = anomalies(df.hotspots.astype(float), GAP_MONTHS)  # months with a sensor outage are never flagged
    out["modis"], out["viirs"], out["modis_scaled"] = df.modis, df.viirs, df.modis_scaled.astype(float).round(1)
    out["note"] = out.index.map(lambda m: NOTES.get(m, ""))
    out["source"] = np.where(out.index < META["viirs_start"], "MODIS-scaled", "VIIRS")
    return out.drop(columns="cal").rename_axis("month").reset_index()


# ---------- endpoints ----------
@app.get("/api/meta")
def meta():
    return META


@app.get("/api/map")
def map_(start: str = None, end: str = None, grid: float = Query(0.05, ge=0.05, le=5), bbox: str = None):
    s, e = parse_range(start, end)
    b = parse_bbox(bbox)
    w, p = where(b, s, e)
    src, g = (COARSE, COARSE_DEG) if COARSE and grid >= COARSE_DEG - 1e-9 else (CELLS, META["grid_deg"])
    if grid <= g + 1e-9:
        sql = (f"SELECT lon, lat, sum(hotspots) hotspots, sum(modis)::BIGINT modis, sum(viirs)::BIGINT viirs "
               f"FROM read_parquet('{src}') WHERE {w} GROUP BY lon, lat")
        params = p
    else:
        sql = (f"SELECT (floor(lon / ?) + 0.5) * ? lon, (floor(lat / ?) + 0.5) * ? lat, sum(hotspots) hotspots, "
               f"sum(modis)::BIGINT modis, sum(viirs)::BIGINT viirs FROM read_parquet('{src}') WHERE {w} "
               f"GROUP BY 1, 2")
        params = [grid, grid, grid, grid] + p
    df = q(sql, params)
    df["lon"], df["lat"], df["hotspots"] = df.lon.round(4), df.lat.round(4), df.hotspots.round(2)
    return records(df)


@app.get("/api/series")
def series_(bbox: str = None):
    return records(series(parse_bbox(bbox)))


@app.get("/api/summary")
def summary(bbox: str = None, start: str = None, end: str = None):
    s, e = parse_range(start, end)
    df = series(parse_bbox(bbox))
    r = df[(df.month >= s) & (df.month <= e)]
    total = float(r.hotspots.sum())
    by_year = r.groupby(r.month.str[:4]).hotspots.sum()
    by_cal = r.groupby(r.month.str[5:7]).hotspots.mean()
    complete = r[r.month <= LAST_COMPLETE]
    last = (complete if len(complete) else r).iloc[-1]  # latest COMPLETE month in the range
    return {
        "start": s, "end": e, "total": round(total, 2),
        "peak_month": r.loc[r.hotspots.idxmax(), "month"] if total > 0 else None,
        "peak_month_hotspots": round(float(r.hotspots.max()), 2),
        "peak_year": by_year.idxmax() if total > 0 else None,
        "peak_year_hotspots": round(float(by_year.max()), 2),
        "busiest_calendar_month": int(by_cal.idxmax()) if total > 0 else None,
        "busiest_calendar_month_mean": round(float(by_cal.max()), 2),
        "latest_month": last.month,
        "latest_hotspots": round(float(last.hotspots), 2),
        "latest_hist_median": round(float(last.hist_median), 2),
        "latest_pct_vs_median": None if pd.isna(last.pct_vs_median) else round(float(last.pct_vs_median), 1),
        "anomalous_months": int((r.flag != "").sum()),
    }


@app.get("/api/download")
def download(bbox: str = None, start: str = None, end: str = None):
    s, e = parse_range(start, end)
    w, p = where(parse_bbox(bbox), s, e)
    if POINTS_PARTITIONED:  # lets DuckDB skip whole year folders
        w, p = f"{w} AND year BETWEEN ? AND ?", p + [int(s[:4]), int(e[:4])]
    cur = db.cursor()
    cur.execute(f"SELECT lat, lon, strftime(acq_date, '%Y-%m-%d') acq_date, sensor, confidence, frp "
                f"FROM {POINTS} WHERE {w} ORDER BY acq_date", p)

    def rows():
        buf = io.StringIO()
        out = csv.writer(buf)
        out.writerow(["lat", "lon", "acq_date", "sensor", "confidence", "frp"])
        while chunk := cur.fetchmany(50_000):
            out.writerows(chunk)
            yield buf.getvalue()
            buf.seek(0)
            buf.truncate()
        if buf.tell():
            yield buf.getvalue()

    name = f"fireledger_hotspots_{s}_{e}.csv"
    return StreamingResponse(rows(), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/api/download/series")
def download_series(bbox: str = None):
    csv_text = series(parse_bbox(bbox)).to_csv(index=False, float_format="%.4g")
    return StreamingResponse(iter([csv_text]), media_type="text/csv",
                             headers={"Content-Disposition": 'attachment; filename="fireledger_series.csv"'})


# Serve the built frontend when present, so `uvicorn backend.main:app` runs the whole app locally.
DIST = ROOT / "frontend" / "dist"
if DIST.is_dir():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="frontend")

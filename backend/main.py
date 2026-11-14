"""Hots45 API — serves the harmonized FIRMS data contract written by data_prep/fire_harmonize.py.

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
import shapely
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))  # serverless entrypoints import this file directly, not as backend.main
sys.path.insert(0, str(ROOT / "data_prep"))
from fire_harmonize import all_months, anomalies  # noqa: E402  same analytics as the offline pipeline
from backend.admin import Admin, circle, geocode  # noqa: E402
from backend import alerts as alerts_engine  # noqa: E402

DATA = Path(os.environ.get("APP_DATA", ROOT / "backend" / "app_data"))
# Serverless (Vercel): DATA_URL is a base URL holding flat files (meta.json, cells*.parquet, admin*.parquet,
# points_YYYY.parquet). Small files are cached in /tmp per instance; raw points are read over HTTP by DuckDB.
DATA_URL = os.environ.get("DATA_URL", "").rstrip("/")
if DATA_URL:
    import urllib.request
    DATA = Path("/tmp/app_data")
    DATA.mkdir(parents=True, exist_ok=True)

    def _fetch(name, required=True):
        dst = DATA / name
        if not dst.exists():
            try:
                urllib.request.urlretrieve(f"{DATA_URL}/{name}", f"{dst}.part")
                os.replace(f"{dst}.part", dst)  # never leave a half-written file that later looks complete
            except Exception:
                if required:
                    raise
    _fetch("meta.json")
META = json.loads((DATA / "meta.json").read_text())
COARSE_DEG = META.get("coarse_grid_deg")
if DATA_URL:
    for _n in ["cells.parquet", "admin.parquet", "cell_admin.parquet"] + ([f"cells_{COARSE_DEG}.parquet"] if COARSE_DEG else []):
        _fetch(_n, required=_n == "cells.parquet")
CELLS = str(DATA / "cells.parquet")
COARSE = str(DATA / f"cells_{COARSE_DEG}.parquet") if COARSE_DEG else None
if COARSE and not Path(COARSE).exists():
    COARSE = None
_pts = DATA / "points.parquet"
POINTS_PARTITIONED = not DATA_URL and _pts.is_dir()  # fire_harmonize writes points.parquet/year=YYYY/*.parquet
if DATA_URL:
    _urls = [f"'{DATA_URL}/points_{y}.parquet'" for y in range(int(META["first_month"][:4]), int(META["last_month"][:4]) + 1)]
    POINTS = f"read_parquet([{', '.join(_urls)}])"
else:
    POINTS = (f"read_parquet('{_pts}/*/*.parquet', hive_partitioning=true)" if POINTS_PARTITIONED
              else f"read_parquet('{_pts}')")
MONTHS = list(all_months(META["first_month"], META["last_month"]))
LAST_COMPLETE = META.get("last_complete_month", META["last_month"])
GAP_MONTHS = META.get("gap_months", [])
NOTES = META.get("month_notes", {})
MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")

db = duckdb.connect()
if DATA_URL:  # read-only home on serverless: keep DuckDB's extension cache in /tmp
    db.execute("SET home_directory='/tmp'; SET extension_directory='/tmp/duckdb_ext'; INSTALL httpfs; LOAD httpfs")
    # DuckDB sizes itself from the host's RAM, not the function's 2 GB cap, and full-record scans got OOM-killed
    db.execute("SET memory_limit='900MB'; SET threads=2; SET preserve_insertion_order=false; SET temp_directory='/tmp/duckdb_tmp'")

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

ADMIN = Admin(DATA)
if ADMIN.ok and ADMIN.cell_admin.exists():
    db.execute(f"CREATE TABLE cell_admin AS SELECT * FROM read_parquet('{ADMIN.cell_admin}')")
HAS_CELL_ADMIN = ADMIN.ok and ADMIN.cell_admin.exists()
# data coverage, so the UI can say "outside our data" instead of drawing empty charts
_cov = db.execute(f"SELECT min(lon), min(lat), max(lon), max(lat) FROM read_parquet('{COARSE or CELLS}')").fetchall()[0]
META = {**META, "coverage_bbox": [round(float(v), 2) for v in _cov], "has_boundaries": HAS_CELL_ADMIN}

app = FastAPI(title="Hots45 API")
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


def parse_region(region):
    """'a<id>' = admin unit (country/state/district), 'c<lon>,<lat>,<km>' = circle. Returns a hashable spec."""
    if not region:
        return None
    try:
        if region[0] == "a" and HAS_CELL_ADMIN:
            i = int(region[1:])
            if 0 <= i < len(ADMIN.df):
                return ("a", i, int(ADMIN.df.level.iat[i]))
        if region[0] == "c":
            lon, lat, km = (float(x) for x in region[1:].split(","))
            if -180 <= lon <= 180 and -90 <= lat <= 90 and 0 < km <= 500:
                return ("c", lon, lat, km)
    except ValueError:
        pass
    raise HTTPException(400, f"unknown region {region!r}")


def region_sql(reg, alias=""):
    """WHERE fragment restricting cells (or points) to a region."""
    if reg[0] == "a":  # cell centre inside the polygon, precomputed by build_boundaries.py
        return (f"EXISTS (SELECT 1 FROM cell_admin ca WHERE ca.lat = {alias}lat AND ca.lon = {alias}lon "
                f"AND ca.adm{reg[2]}_id = ?)", [reg[1]])
    _, lon, lat, km = reg
    dlat, dlon = km / 111.32, km / (111.32 * max(0.01, np.cos(np.radians(lat))))
    return (f"{alias}lon BETWEEN ? AND ? AND {alias}lat BETWEEN ? AND ? AND "
            f"2 * 6371 * asin(sqrt(sin(radians({alias}lat - ?) / 2) ^ 2 + cos(radians(?)) * cos(radians({alias}lat)) "
            f"* sin(radians({alias}lon - ?) / 2) ^ 2)) <= ?", [lon - dlon, lon + dlon, lat - dlat, lat + dlat, lat, lat, lon, km])


def where(bbox, start=None, end=None, reg=None, alias=""):
    """alias: outer table prefix (e.g. "c."), needed so the region subquery compares with the outer row."""
    sql, params = ["TRUE"], []
    if reg:
        f, p = region_sql(reg, alias)
        sql.append(f)
        params += p
    if bbox:
        sql.append(f"{alias}lon BETWEEN ? AND ? AND {alias}lat BETWEEN ? AND ?")
        params += [bbox[0], bbox[2], bbox[1], bbox[3]]
    if start:
        sql.append(f"{alias}month BETWEEN ? AND ?")
        params += [start, end]
    return " AND ".join(sql), params


def q(sql, params):
    return db.cursor().execute(sql, params).df()


def records(df):
    return json.loads(df.to_json(orient="records"))  # NaN -> null


# ---------- analytics ----------
@lru_cache(maxsize=256)  # data is immutable while the process runs
def series(bbox, reg=None):
    w, p = where(bbox, reg=reg, alias="c.")
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


def month_idx(m):
    return int(m[:4]) * 12 + int(m[5:7]) - 1


@app.get("/api/anomaly")
def anomaly(start: str = None, end: str = None, grid: float = Query(0.25, ge=0.05, le=5), bbox: str = None,
            min_z: float = Query(2.0, ge=0), min_diff: float = Query(5.0, ge=0)):
    """Per cell: hotspots in [start, end] vs the median of the same calendar window in every other year
    (missing years count as 0). Returns only cells with |robust z| >= min_z and |diff| >= min_diff."""
    s, e = parse_range(start, end)
    b = parse_bbox(bbox)
    S, L = month_idx(s), month_idx(e) - month_idx(s) + 1
    if L > 12:
        raise HTTPException(400, "anomaly needs a period of 12 months or less")
    F, Lr = month_idx(META["first_month"]), month_idx(META["last_month"])
    kmin, kmax = -((S - F) // 12), (Lr - (S + L - 1)) // 12  # shifts whose window lies fully inside the record
    if kmax - kmin < 3:
        raise HTTPException(400, "anomaly needs at least 3 other years with this calendar window")
    out = window_stats(s, e, grid, b)
    if out.empty:
        return []
    keep = (out.z.abs() >= min_z) & (out["diff"].abs() >= min_diff)
    return records(out[keep])


def window_stats(s, e, grid, b):
    """Per cell: hotspots in [s, e] vs the median of the same window in every other year (missing = 0)."""
    S, L = month_idx(s), month_idx(e) - month_idx(s) + 1
    F, Lr = month_idx(META["first_month"]), month_idx(META["last_month"])
    kmin, kmax = -((S - F) // 12), (Lr - (S + L - 1)) // 12  # shifts whose window lies fully inside the record
    src, g = (COARSE, COARSE_DEG) if COARSE and grid >= COARSE_DEG - 1e-9 else (CELLS, META["grid_deg"])
    w, p = where(b)
    df = q(f"""WITH c AS (
                 SELECT (floor(lon / ?) + 0.5) * ? lon, (floor(lat / ?) + 0.5) * ? lat, hotspots,
                        floor((substr(month, 1, 4)::INT * 12 + substr(month, 6, 2)::INT - 1 - ?) / 12)::INT k,
                        substr(month, 1, 4)::INT * 12 + substr(month, 6, 2)::INT - 1 - ? AS off0
                 FROM read_parquet('{src}') WHERE {w})
               SELECT lon, lat, k, sum(hotspots) h FROM c
               WHERE off0 - 12 * k < ? AND k BETWEEN ? AND ? GROUP BY ALL""",
           [max(grid, g)] * 4 + [S, S] + p + [L, kmin, kmax])
    if df.empty:
        return pd.DataFrame()
    m = df.pivot_table(index=["lon", "lat"], columns="k", values="h", aggfunc="sum", fill_value=0.0)
    m = m.reindex(columns=range(kmin, kmax + 1), fill_value=0.0)
    cur = m[0].to_numpy()
    other = m.drop(columns=0).to_numpy()
    med = np.median(other, axis=1)
    mad = np.median(np.abs(other - med[:, None]), axis=1)
    z = (cur - med) / (1.4826 * np.maximum(mad, 1.0))  # MAD floored at 1 hotspot so near-empty cells don't explode
    return pd.DataFrame({"lon": m.index.get_level_values(0).round(4), "lat": m.index.get_level_values(1).round(4),
                         "current": cur.round(1), "baseline": med.round(1), "diff": (cur - med).round(1), "z": z.round(2)})


SCALE_Q = [i / 100 for i in range(0, 100, 5)] + [0.99, 0.995]


@app.get("/api/scale")
def scale(grid: float = Query(..., ge=0.05, le=5)):
    """Fixed colour scale: quantiles of every non-zero monthly cell value in the full record at this grid,
    so a quiet month looks pale and a peak season looks red whatever period is shown."""
    return _scale(round(grid, 4))


@lru_cache(maxsize=16)
def _scale(grid):
    src, g = (COARSE, COARSE_DEG) if COARSE and grid >= COARSE_DEG - 1e-9 else (CELLS, META["grid_deg"])
    vals = (f"SELECT hotspots h FROM read_parquet('{src}')" if grid <= g + 1e-9 else
            f"SELECT sum(hotspots) h FROM read_parquet('{src}') GROUP BY month, floor(lon / {grid}), floor(lat / {grid})")
    qs = db.cursor().execute(f"SELECT quantile_cont(h, {SCALE_Q}) FROM ({vals}) WHERE h > 0").fetchall()[0][0]
    return {"grid": grid, "q": {f"{k:g}": round(float(v), 2) for k, v in zip(SCALE_Q, qs)}}


@app.get("/api/series")
def series_(bbox: str = None, region: str = None):
    return records(series(parse_bbox(bbox), parse_region(region)))


@app.get("/api/summary")
def summary(bbox: str = None, start: str = None, end: str = None, region: str = None):
    s, e = parse_range(start, end)
    df = series(parse_bbox(bbox), parse_region(region))
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
def download(bbox: str = None, start: str = None, end: str = None, region: str = None):
    s, e = parse_range(start, end)
    reg = parse_region(region)
    poly = None
    if reg and reg[0] == "a":  # exact point-in-polygon for raw points: bbox prefilter in SQL, test in Python
        poly = ADMIN.geoms[reg[1]]
        w, p = where(tuple(poly.bounds), s, e)
    else:
        w, p = where(parse_bbox(bbox), s, e, reg)
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
            if poly is not None:
                xy = np.array([(r[1], r[0]) for r in chunk])
                chunk = [r for r, inside in zip(chunk, shapely.contains_xy(poly, xy[:, 0], xy[:, 1])) if inside]
            out.writerows(chunk)
            yield buf.getvalue()
            buf.seek(0)
            buf.truncate()
        if buf.tell():
            yield buf.getvalue()

    name = f"hots45_hotspots_{s}_{e}.csv"
    return StreamingResponse(rows(), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/api/download/series")
def download_series(bbox: str = None, region: str = None):
    csv_text = series(parse_bbox(bbox), parse_region(region)).to_csv(index=False, float_format="%.4g")
    return StreamingResponse(iter([csv_text]), media_type="text/csv",
                             headers={"Content-Disposition": 'attachment; filename="hots45_series.csv"'})


# ---------- daily counts (timeline zoomed to a season or month) ----------
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FIRST_DAY = pd.Timestamp(f"{META['first_month']}-01")
LAST_DAY = pd.Timestamp(f"{META['last_month']}-01") + pd.offsets.MonthEnd(0)


def points_where(bbox, reg):
    """WHERE fragment for raw points (alias pt) restricted to a bbox or region (cell-centre membership)."""
    sql, params = ["TRUE"], []
    if bbox:
        sql.append("pt.lon BETWEEN ? AND ? AND pt.lat BETWEEN ? AND ?")
        params += [bbox[0], bbox[2], bbox[1], bbox[3]]
    if reg and reg[0] == "a":
        g = META["grid_deg"]
        # the unit's bbox (padded one cell) lets DuckDB skip parquet row groups before the per-point lookup
        r = ADMIN.df.iloc[reg[1]]
        sql.append("pt.lon BETWEEN ? AND ? AND pt.lat BETWEEN ? AND ?")
        params += [float(r.minx) - g, float(r.maxx) + g, float(r.miny) - g, float(r.maxy) + g]
        sql.append(f"EXISTS (SELECT 1 FROM cell_admin a WHERE a.lat = round((floor(pt.lat / {g}) + 0.5) * {g}, 4) "
                   f"AND a.lon = round((floor(pt.lon / {g}) + 0.5) * {g}, 4) AND a.adm{reg[2]}_id = ?)")
        params.append(reg[1])
    elif reg:
        f, p = region_sql(reg, "pt.")
        sql.append(f)
        params += p
    return " AND ".join(sql), params


@lru_cache(maxsize=64)
def daily_all(bbox, reg):
    """Harmonized hotspots per day for the whole record (zero-filled): VIIRS from viirs_start, MODIS x k before."""
    w, p = points_where(bbox, reg)
    vs = META["viirs_start"]
    df = q(f"""SELECT pt.acq_date::DATE d,
                      sum(CASE WHEN pt.sensor = 'VIIRS' AND pt.month >= ? THEN 1.0
                               WHEN pt.sensor = 'MODIS' AND pt.month < ? THEN coalesce(t.k, m.k, ?) ELSE 0 END) h
               FROM {POINTS} pt
               LEFT JOIN tile_k t ON t.tx = floor(pt.lon / {TILE_DEG})::INT AND t.ty = floor(pt.lat / {TILE_DEG})::INT
                                 AND t.cal = substr(pt.month, 6, 2)::INT
               LEFT JOIN cal_k m ON m.cal = substr(pt.month, 6, 2)::INT
               WHERE {w} GROUP BY 1""", [vs, vs, K_GLOBAL] + p)
    s = df.set_index(pd.to_datetime(df.d)).h.astype(float)
    return s.reindex(pd.date_range(FIRST_DAY, LAST_DAY), fill_value=0.0)


@lru_cache(maxsize=64)
def daily_normal(bbox, reg):
    """Median across years of the 7-day centred mean, per calendar day (MM-DD)."""
    s = daily_all(bbox, reg).rolling(7, center=True, min_periods=1).mean()
    return s.groupby(s.index.strftime("%m-%d")).median()


def parse_day(v, name):
    if not v or not DATE_RE.match(v):
        raise HTTPException(400, f"{name} must be YYYY-MM-DD")
    return pd.Timestamp(v)


@app.get("/api/daily")
def daily(start: str, end: str, bbox: str = None, region: str = None):
    """Daily hotspots in [start, end] (max 400 days) with the normal for each calendar day."""
    s, e = parse_day(start, "start"), parse_day(end, "end")
    if e < s or (e - s).days > 400:
        raise HTTPException(400, "daily range must be 1-400 days")
    b, reg = parse_bbox(bbox), parse_region(region)
    d = daily_all(b, reg)[max(s, FIRST_DAY):min(e, LAST_DAY)]
    norm = daily_normal(b, reg)
    med = norm.reindex(d.index.strftime("%m-%d")).to_numpy()
    out = pd.DataFrame({"date": d.index.strftime("%Y-%m-%d"), "hotspots": d.round(1).to_numpy(), "median": np.round(med, 1)})
    out["pct_vs_median"] = np.where(out["median"] > 0, ((out.hotspots - out["median"]) / out["median"].where(out["median"] > 0) * 100).round(1), np.nan)
    out["note"] = out.date.str[:7].map(lambda m: NOTES.get(m, ""))
    return records(out)


def _when(ts):
    part = "early" if ts.day <= 10 else "mid" if ts.day <= 20 else "late"
    return f"{part}-{ts.strftime('%b')}"


@app.get("/api/season")
def season(bbox: str = None, region: str = None):
    """Plain-language fire season for an area: typical start, peak week and end, plus the latest season vs normal."""
    b, reg = parse_bbox(bbox), parse_region(region)
    d = daily_all(b, reg)
    if d.sum() == 0:
        return {"text": "No fires recorded in this area.", "start": None, "peak": None, "end": None}
    clim = d.groupby(d.index.strftime("%m-%d")).mean().drop("02-29", errors="ignore")
    smooth = pd.concat([clim, clim, clim]).rolling(15, center=True).mean().iloc[len(clim):2 * len(clim)]  # wrap the year
    vals, days = smooth.to_numpy(), list(smooth.index)
    pk = int(np.argmax(vals))
    lo, hi = pk, pk
    while vals[(lo - 1) % len(vals)] >= 0.25 * vals[pk] and pk - lo < 150:
        lo -= 1
    while vals[(hi + 1) % len(vals)] >= 0.25 * vals[pk] and hi - pk < 150:
        hi += 1
    md = lambda i: pd.Timestamp(f"2001-{days[i % len(days)]}")  # noqa: E731  (non-leap reference year)
    t_start, t_peak, t_end = md(lo), md(pk), md(hi)
    nth = ["first", "second", "third", "fourth", "last"][min(4, (t_peak.day - 1) // 7)]
    text = f"Fires usually start {_when(t_start)}, peak in the {nth} week of {t_peak.strftime('%b')}, and end by {_when(t_end)}."
    # latest season: the most recent window [start, end] that has begun within the record
    length = (hi - lo)
    y = LAST_DAY.year
    s0 = pd.Timestamp(f"{y}-{t_start.strftime('%m-%d')}")
    if s0 > LAST_DAY:
        s0 = pd.Timestamp(f"{y - 1}-{t_start.strftime('%m-%d')}")
    e0 = s0 + pd.Timedelta(days=length)
    so_far = e0 > LAST_DAY
    e_cut = min(e0, LAST_DAY)
    cur = float(d[s0:e_cut].sum())
    others = [float(d[s0.replace(year=yy):e_cut.replace(year=yy + (e_cut.year - s0.year))].sum())
              for yy in range(FIRST_DAY.year, s0.year) if s0.replace(year=yy) >= FIRST_DAY]
    pct = None
    if len(others) >= 3 and np.median(others) > 0:
        pct = (cur - np.median(others)) / np.median(others) * 100
        how = "about normal" if abs(pct) < 10 else f"{abs(round(pct))}% {'below' if pct < 0 else 'above'} normal"
        label = f"{s0.year}–{str(e0.year)[2:]}" if e0.year != s0.year else str(s0.year)
        text += f" {label} season{' so far' if so_far else ''}: {how}."
    return {"text": text, "start": t_start.strftime("%m-%d"), "peak": t_peak.strftime("%m-%d"), "end": t_end.strftime("%m-%d"),
            "latest": {"start": s0.strftime("%Y-%m-%d"), "end": e_cut.strftime("%Y-%m-%d"), "so_far": so_far,
                       "hotspots": round(cur, 1), "pct_vs_median": None if pct is None else round(pct, 1)},
            "data_through": LAST_DAY.strftime("%Y-%m-%d")}


@app.get("/api/alerts")
def alerts(asof: str, bbox: str = None, region: str = None):
    """Alerts lite for one area as of a date (inclusive; a simulated date never sees later data)."""
    d = parse_day(asof, "asof")
    if not (FIRST_DAY <= d <= LAST_DAY):
        raise HTTPException(400, f"asof must be within {FIRST_DAY.date()}..{LAST_DAY.date()}")
    gaps = [(g["start"], g["end"]) for g in META.get("data_gaps", []) if g.get("sensor") == "VIIRS"]
    return alerts_engine.evaluate(daily_all(parse_bbox(bbox), parse_region(region)), d, gaps, META.get("provisional_months", []))


def need_boundaries():
    if not HAS_CELL_ADMIN:
        raise HTTPException(404, "boundaries not built; run data_prep/build_boundaries.py")


@app.get("/api/search")
def search(q: str = Query(..., min_length=1, max_length=80), limit: int = Query(12, ge=1, le=50)):
    """Offline, typo-tolerant search over countries, states/provinces and districts."""
    need_boundaries()
    return ADMIN.search(q, limit)


PLACE_TYPES = {"city", "town", "village", "hamlet", "suburb", "locality", "neighbourhood", "quarter", "borough",
               "municipality", "island", "islet", "park", "national park", "nature reserve", "protected area", "forest",
               "wood", "farm", "farmland", "farmyard", "peak", "volcano", "valley", "plateau", "wetland"}


@app.get("/api/places")
def places(q: str = Query(..., min_length=3, max_length=80)):
    """Cities, towns, villages, parks via the Photon geocoder (cached, <= 1 request/s), with the district that
    contains each place. Places outside the data coverage are returned with in_coverage = false."""
    need_boundaries()
    try:
        found = [json.loads(x) for x in geocode(q.strip().lower(), (-180, -90, 180, 90))]
    except Exception as ex:
        raise HTTPException(502, f"place search unavailable: {ex}")
    c = META["coverage_bbox"]
    out, seen = [], set()
    for f in found:
        if f["type"] not in PLACE_TYPES:  # admin units come from the offline index; skip roads, shops, stations
            continue
        key = (f["name"].lower(), round(f["lon"], 1), round(f["lat"], 1))
        if key in seen:
            continue
        seen.add(key)
        f["in_coverage"] = c[0] <= f["lon"] <= c[2] and c[1] <= f["lat"] <= c[3]
        f.update(ADMIN.at(f["lon"], f["lat"]) if f["in_coverage"] else {})
        out.append(f)
    return out


@app.get("/api/region/{rid}")
def region_info(rid: str):
    """Name, hierarchy, bbox and outline rings of a region."""
    reg = parse_region(rid)
    if not reg:
        raise HTTPException(400, "region required")
    if reg[0] == "a":
        u = ADMIN.unit(reg[1])
        u["rings"] = ADMIN.outline(reg[1])
    else:
        _, lon, lat, km = reg
        g = circle(lon, lat, km)
        u = {"id": rid, "name": f"{km:g} km around {lat:.3f}°, {lon:.3f}°", "kind": "Radius", "level": 3, "parent": "",
             "bbox": [round(v, 4) for v in g.bounds], "label": [lon, lat],
             "rings": [np.round(np.asarray(g.exterior.coords), 4).tolist()]}
    c = META["coverage_bbox"]
    b = u["bbox"]
    u["in_coverage"] = not (b[2] < c[0] or b[0] > c[2] or b[3] < c[1] or b[1] > c[3])
    return u


@app.get("/api/boundaries")
def boundaries(level: int = Query(..., ge=1, le=2), bbox: str = Query(...), zoom: float = Query(..., ge=0, le=22)):
    need_boundaries()
    b = parse_bbox(bbox)
    return _boundaries(level, b, round(zoom))


@lru_cache(maxsize=512)
def _boundaries(level, b, zoom):
    return ADMIN.boundaries(level, b, zoom)


@app.get("/api/cell")
def cell(lon: float, lat: float, grid: float = Query(..., ge=0.05, le=5), start: str = None, end: str = None):
    """Hover details for one map cell: admin names at its centre, hotspots, and % vs the median of the same months."""
    s, e = parse_range(start, end)
    out = {"lon": lon, "lat": lat, **(ADMIN.at(lon, lat) if ADMIN.ok else {})}
    out.update(current=None, median=None, pct_vs_median=None)
    if month_idx(e) - month_idx(s) < 12:
        h = grid / 2
        st = window_stats(s, e, grid, (lon - h + 1e-6, lat - h + 1e-6, lon + h - 1e-6, lat + h - 1e-6))
        if not st.empty:
            r = st.iloc[0]
            out.update(current=float(r.current), median=float(r.baseline),
                       pct_vs_median=None if r.baseline <= 0 else round((r.current - r.baseline) / r.baseline * 100, 1))
    return out


@app.get("/api/top")
def top(start: str = None, end: str = None, bbox: str = None, region: str = None, n: int = Query(10, ge=1, le=50)):
    """Top districts (or states where a country has no districts) by hotspots in the period, within a bbox or region."""
    need_boundaries()
    s, e = parse_range(start, end)
    w, p = where(parse_bbox(bbox), s, e, parse_region(region), alias="c.")
    df = q(f"""SELECT CASE WHEN a.adm2_id >= 0 THEN a.adm2_id ELSE a.adm1_id END uid, sum(c.hotspots) h
               FROM read_parquet('{CELLS}') c JOIN cell_admin a ON a.lat = c.lat AND a.lon = c.lon
               WHERE {w}
               GROUP BY 1 HAVING uid >= 0 ORDER BY h DESC""", p)
    total = float(df.h.sum()) if len(df) else 0.0
    return [{**ADMIN.unit(int(r.uid)), "hotspots": round(float(r.h), 1), "share": round(float(r.h) / total * 100, 1) if total else 0}
            for r in df.head(n).itertuples()]


# Serve the built frontend when present, so `uvicorn backend.main:app` runs the whole app locally.
DIST = ROOT / "frontend" / "dist"
if DIST.is_dir():
    @app.get("/view/{rest:path}", include_in_schema=False)
    def spa_view(rest: str):
        """Expanded-chart URLs (/view/calendar?...) are client routes: serve the app shell."""
        return FileResponse(DIST / "index.html")

    app.mount("/", StaticFiles(directory=DIST, html=True), name="frontend")

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
from backend import outlook as outlook_model  # noqa: E402

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
# ~60k rows keeps the CSV under the ~4.5 MB serverless response cap
MAX_DOWNLOAD_ROWS = int(os.environ.get("MAX_DOWNLOAD_ROWS", 60_000 if DATA_URL else 2_000_000))
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


def _factor_tables(m, name):
    """k per tile x calendar month and per calendar month, from a meta factor block, as DuckDB tables <name>_tile/_cal."""
    t = pd.DataFrame([(int(float(key.split(",")[0]) // TILE_DEG), int(float(key.split(",")[1]) // TILE_DEG), int(c), k)
                      for key, v in m.get("factor_by_tile", {}).items() for c, k in v["k"].items()], columns=["tx", "ty", "cal", "k"])
    c = pd.DataFrame([(int(cc), k) for cc, k in m.get("factor_by_month", {}).items()], columns=["cal", "k"])
    db.register(f"_{name}_t", t.astype({"tx": "int32", "ty": "int32", "cal": "int32", "k": "float64"}))
    db.register(f"_{name}_c", c.astype({"cal": "int32", "k": "float64"}))
    db.execute(f"CREATE TABLE {name}_tile AS SELECT * FROM _{name}_t; CREATE TABLE {name}_cal AS SELECT * FROM _{name}_c")


FRP = META.get("frp")  # written by data_prep/fire_intensity.py
if FRP:
    _factor_tables(FRP, "frp")
K_FRP = float(FRP["factor_global"]) if FRP else 1.0

ADMIN = Admin(DATA)
if ADMIN.ok and ADMIN.cell_admin.exists():
    db.execute(f"CREATE TABLE cell_admin AS SELECT * FROM read_parquet('{ADMIN.cell_admin}')")
HAS_CELL_ADMIN = ADMIN.ok and ADMIN.cell_admin.exists()
# data coverage, so the UI can say "outside our data" instead of drawing empty charts
_cov = db.execute(f"SELECT min(lon), min(lat), max(lon), max(lat) FROM read_parquet('{COARSE or CELLS}')").fetchall()[0]
META = {**META, "coverage_bbox": [round(float(v), 2) for v in _cov], "has_boundaries": HAS_CELL_ADMIN}
# "What is burning": data_prep/land_cover.py label adds lc_<group> columns to the cells files and lc_group to points
_cell_cols = set(db.execute(f"DESCRIBE SELECT * FROM read_parquet('{CELLS}')").df().column_name)
HAS_FRP = bool(FRP) and {"frp", "frp_modis", "frp_viirs"} <= _cell_cols
LC = META.get("land_cover")
LC_KEYS = [g["key"] for g in LC["groups"]] if LC else []
HAS_LC = bool(LC_KEYS) and all(f"lc_{k}" in db.execute(f"DESCRIBE SELECT * FROM read_parquet('{f}')").df().column_name.values
                                for k in LC_KEYS for f in [CELLS] + ([COARSE] if COARSE else []))

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


def parse_metric(metric, group=None):
    """'hotspots' (counts) or 'frp' (Fire Radiative Power, MW). FRP is not split by land cover."""
    if metric in (None, "", "hotspots"):
        return "hotspots"
    if metric != "frp" or not HAS_FRP:
        ok = "'hotspots' or 'frp'" if HAS_FRP else "'hotspots' (FRP not built)"
        raise HTTPException(400, f"metric must be {ok}, got {metric!r}")
    if group:
        raise HTTPException(400, "the fire-type filter applies to hotspot counts only, not to FRP")
    return "frp"


def parse_group(group):
    """Land-cover group key (e.g. 'crop') or None for all fires."""
    if not group or group == "all":
        return None
    if group not in LC_KEYS:
        raise HTTPException(400, f"group must be one of {LC_KEYS or '(land cover not built)'}, got {group!r}")
    return group


# ---------- analytics ----------
@lru_cache(maxsize=256)  # data is immutable while the process runs
def series(bbox, reg=None, group=None, metric="hotspots"):
    """Monthly series. metric 'frp': 'hotspots' holds harmonized total FRP (MW), modis/viirs the raw FRP sums."""
    w, p = where(bbox, reg=reg, alias="c.")
    frp = metric == "frp"
    val = "frp" if frp else f"lc_{group}" if group else "hotspots"
    m_col, v_col, cast, kt, kc = ("frp_modis", "frp_viirs", "", "frp_tile", "frp_cal") if frp else ("modis", "viirs", "::BIGINT", "tile_k", "cal_k")
    df = q(f"""SELECT month, sum({val}) hotspots, sum({m_col}){cast} modis, sum({v_col}){cast} viirs,
                      sum({m_col} * coalesce(t.k, m.k, ?)) modis_scaled
               FROM read_parquet('{CELLS}') c
               LEFT JOIN {kt} t ON t.tx = floor(c.lon / {TILE_DEG})::INT AND t.ty = floor(c.lat / {TILE_DEG})::INT
                                 AND t.cal = substr(c.month, 6, 2)::INT
               LEFT JOIN {kc} m ON m.cal = substr(c.month, 6, 2)::INT
               WHERE {w} GROUP BY month""", [K_FRP if frp else K_GLOBAL] + p).set_index("month")
    df = df.reindex(MONTHS, fill_value=0)
    out = anomalies(df.hotspots.astype(float), GAP_MONTHS)  # months with a sensor outage are never flagged
    out["modis"], out["viirs"], out["modis_scaled"] = df.modis, df.viirs, df.modis_scaled.astype(float).round(1)
    if group:  # raw sensor counts are not split by land cover; don't pass off the area's totals as the group's
        out[["modis", "viirs", "modis_scaled"]] = np.nan
    out["note"] = out.index.map(lambda m: NOTES.get(m, ""))
    out["source"] = np.where(out.index < META["viirs_start"], "MODIS-scaled", "VIIRS")
    return out.drop(columns="cal").rename_axis("month").reset_index()


# ---------- endpoints ----------
@app.get("/api/meta")
def meta():
    return META


@app.get("/api/map")
def map_(start: str = None, end: str = None, grid: float = Query(0.05, ge=0.05, le=5), bbox: str = None, lc: bool = False,
         metric: str = None):
    """lc=1 adds the dominant land-cover group per cell: lc (index into meta land_cover.groups) and lc_share (0-1).
    metric=frp adds frp: harmonized total Fire Radiative Power (MW) per cell."""
    s, e = parse_range(start, end)
    lc = lc and HAS_LC
    extra = "".join(f", sum(lc_{k}) lc_{k}" for k in LC_KEYS) if lc else ""
    if parse_metric(metric) == "frp":
        extra += ", round(sum(frp), 1) frp"
    b = parse_bbox(bbox)
    w, p = where(b, s, e)
    src, g = (COARSE, COARSE_DEG) if COARSE and grid >= COARSE_DEG - 1e-9 else (CELLS, META["grid_deg"])
    if grid <= g + 1e-9:
        sql = (f"SELECT lon, lat, sum(hotspots) hotspots, sum(modis)::BIGINT modis, sum(viirs)::BIGINT viirs{extra} "
               f"FROM read_parquet('{src}') WHERE {w} GROUP BY lon, lat")
        params = p
    else:
        sql = (f"SELECT (floor(lon / ?) + 0.5) * ? lon, (floor(lat / ?) + 0.5) * ? lat, sum(hotspots) hotspots, "
               f"sum(modis)::BIGINT modis, sum(viirs)::BIGINT viirs{extra} FROM read_parquet('{src}') WHERE {w} "
               f"GROUP BY 1, 2")
        params = [grid, grid, grid, grid] + p
    df = q(sql, params)
    df["lon"], df["lat"], df["hotspots"] = df.lon.round(4), df.lat.round(4), df.hotspots.round(2)
    if lc:
        g = df[[f"lc_{k}" for k in LC_KEYS]].to_numpy(dtype=float)
        df = df.drop(columns=[f"lc_{k}" for k in LC_KEYS])
        df["lc"] = g.argmax(axis=1)
        df["lc_share"] = np.round(g.max(axis=1) / np.maximum(g.sum(axis=1), 1e-9), 3)
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


def window_stats(s, e, grid, b, col="hotspots"):
    """Per cell: hotspots in [s, e] vs the median of the same window in every other year (missing = 0)."""
    S, L = month_idx(s), month_idx(e) - month_idx(s) + 1
    F, Lr = month_idx(META["first_month"]), month_idx(META["last_month"])
    kmin, kmax = -((S - F) // 12), (Lr - (S + L - 1)) // 12  # shifts whose window lies fully inside the record
    src, g = (COARSE, COARSE_DEG) if COARSE and grid >= COARSE_DEG - 1e-9 else (CELLS, META["grid_deg"])
    w, p = where(b)
    df = q(f"""WITH c AS (
                 SELECT (floor(lon / ?) + 0.5) * ? lon, (floor(lat / ?) + 0.5) * ? lat, {col} hotspots,
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
def scale(grid: float = Query(..., ge=0.05, le=5), metric: str = None):
    """Fixed colour scale: quantiles of every non-zero monthly cell value in the full record at this grid,
    so a quiet month looks pale and a peak season looks red whatever period is shown."""
    return _scale(round(grid, 4), parse_metric(metric))


@lru_cache(maxsize=16)
def _scale(grid, metric="hotspots"):
    src, g = (COARSE, COARSE_DEG) if COARSE and grid >= COARSE_DEG - 1e-9 else (CELLS, META["grid_deg"])
    col = "frp" if metric == "frp" else "hotspots"
    vals = (f"SELECT {col} h FROM read_parquet('{src}')" if grid <= g + 1e-9 else
            f"SELECT sum({col}) h FROM read_parquet('{src}') GROUP BY month, floor(lon / {grid}), floor(lat / {grid})")
    qs = db.cursor().execute(f"SELECT quantile_cont(h, {SCALE_Q}) FROM ({vals}) WHERE h > 0").fetchall()[0][0]
    return {"grid": grid, "q": {f"{k:g}": round(float(v), 2) for k, v in zip(SCALE_Q, qs)}}


@app.get("/api/series")
def series_(bbox: str = None, region: str = None, group: str = None, metric: str = None):
    """group: land-cover group key (meta land_cover.groups) to count only those fires. metric=frp: total FRP (MW)."""
    g = parse_group(group)
    return records(series(parse_bbox(bbox), parse_region(region), g, parse_metric(metric, g)))


def landcover_text(groups):
    """Plain-language summary computed from the shares, e.g. '86% cropland fires (likely crop-residue burning)'."""
    g = sorted((x for x in groups if x["hotspots"] > 0), key=lambda x: -x["share"])
    if not g:
        return "No hotspots in this area and period."
    name = lambda x: x["label"].lower()  # noqa: E731
    top = g[0]
    if top["share"] < 50:
        return "Mixed: " + ", ".join(f"{round(x['share'])}% {name(x)}" for x in g[:3]) + " fires."
    text = f"{round(top['share'])}% {name(top)} fires" + (" (likely crop-residue burning)" if top["key"] == "crop" else "")
    rest = [f"{round(x['share'])}% {name(x)}" for x in g[1:3] if x["share"] >= 5]
    return text + (f"; {', '.join(rest)}." if rest else ".")


@app.get("/api/landcover")
def landcover(bbox: str = None, region: str = None, start: str = None, end: str = None):
    """'What is burning': harmonized hotspots per land-cover group (MCD12Q1, previous year's map) in an area and period."""
    if not HAS_LC:
        raise HTTPException(404, "land cover not built; run data_prep/land_cover.py label")
    s, e = parse_range(start, end)
    w, p = where(parse_bbox(bbox), s, e, parse_region(region), alias="c.")
    v = db.cursor().execute(f"SELECT {', '.join(f'coalesce(sum(c.lc_{k}), 0)' for k in LC_KEYS)} "
                            f"FROM read_parquet('{CELLS}') c WHERE {w}", p).fetchall()[0]
    total = float(sum(v))
    groups = [{**{k: g[k] for k in ("key", "label", "classes")}, "hotspots": round(float(x), 1),
               "share": round(float(x) / total * 100, 1) if total else 0.0} for g, x in zip(LC["groups"], v)]
    return {"start": s, "end": e, "total": round(total, 1), "groups": groups, "text": landcover_text(groups), "note": LC["note"]}


@app.get("/api/summary")
def summary(bbox: str = None, start: str = None, end: str = None, region: str = None, metric: str = None):
    s, e = parse_range(start, end)
    df = series(parse_bbox(bbox), parse_region(region), None, parse_metric(metric))
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


@app.get("/api/intensity")
def intensity(bbox: str = None, region: str = None, start: str = None, end: str = None):
    """Per-sensor FRP per hotspot (mean and 90th percentile, MW) in an area and period. NOT harmonized: MODIS (1 km)
    and VIIRS (375 m) pixels see different fire sizes, so the two sensors are reported side by side, never merged."""
    if not HAS_FRP:
        raise HTTPException(404, "FRP not built; run data_prep/fire_intensity.py")
    s, e = parse_range(start, end)
    reg = parse_region(region)
    w, p = points_where(parse_bbox(bbox), reg)
    w, p = f"{w} AND pt.month BETWEEN ? AND ? AND pt.frp IS NOT NULL", p + [s, e]
    if POINTS_PARTITIONED:
        w, p = f"{w} AND pt.year BETWEEN ? AND ?", p + [int(s[:4]), int(e[:4])]
    rows = db.cursor().execute(f"""SELECT sensor, count(*), avg(frp), approx_quantile(frp, 0.9), sum(frp)
                                   FROM {POINTS} pt WHERE {w} GROUP BY sensor""", p).fetchall()
    out = {x: None for x in ("MODIS", "VIIRS")}
    for sensor, n, mean, p90, tot in rows:
        out[sensor] = {"n": int(n), "mean": round(float(mean), 2), "p90": round(float(p90), 2), "total": round(float(tot), 1)}
    return {"start": s, "end": e, "unit": "MW", "sensors": out,
            "note": "Per-hotspot FRP is not comparable across sensors (375 m VIIRS pixels detect smaller fires than 1 km MODIS)."}


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
    # Refuse oversized exports up front (cheap count from the cell table): a whole-record CSV is ~46 M rows, which
    # fills /tmp and, on serverless, exceeds the response size limit, so the browser just shows a cancelled download.
    cw, cp = where(None if reg else parse_bbox(bbox), s, e, reg, alias="c.")
    n = int(db.cursor().execute(f"SELECT coalesce(sum(c.modis + c.viirs), 0) FROM read_parquet('{CELLS}') c WHERE {cw}", cp).fetchall()[0][0])
    if n > MAX_DOWNLOAD_ROWS:
        raise HTTPException(413, f"This selection has about {n:,} hotspots; the download limit is {MAX_DOWNLOAD_ROWS:,}. "
                                 "Pick a smaller area or a shorter period.")
    if POINTS_PARTITIONED:  # lets DuckDB skip whole year folders
        w, p = f"{w} AND year BETWEEN ? AND ?", p + [int(s[:4]), int(e[:4])]
    cur = db.cursor()
    lc_cols = ["land_cover", "lc_group"] if HAS_LC else []
    cur.execute(f"SELECT lat, lon, strftime(acq_date, '%Y-%m-%d') acq_date, sensor, confidence, frp{''.join(', ' + c for c in lc_cols)} "
                f"FROM {POINTS} WHERE {w} ORDER BY acq_date", p)

    def rows():
        buf = io.StringIO()
        out = csv.writer(buf)
        out.writerow(["lat", "lon", "acq_date", "sensor", "confidence", "frp"] + lc_cols)
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
def daily_all(bbox, reg, group=None, metric="hotspots"):
    """Harmonized hotspots (or total FRP, MW) per day for the whole record (zero-filled): VIIRS from viirs_start, MODIS x k before."""
    w, p = points_where(bbox, reg)
    if group:
        w, p = f"{w} AND pt.lc_group = ?", p + [group]
    vs = META["viirs_start"]
    frp = metric == "frp"
    v, kt, kc = ("coalesce(pt.frp, 0)", "frp_tile", "frp_cal") if frp else ("1.0", "tile_k", "cal_k")
    df = q(f"""SELECT pt.acq_date::DATE d,
                      sum(CASE WHEN pt.sensor = 'VIIRS' AND pt.month >= ? THEN {v}
                               WHEN pt.sensor = 'MODIS' AND pt.month < ? THEN {v} * coalesce(t.k, m.k, ?) ELSE 0 END) h
               FROM {POINTS} pt
               LEFT JOIN {kt} t ON t.tx = floor(pt.lon / {TILE_DEG})::INT AND t.ty = floor(pt.lat / {TILE_DEG})::INT
                                 AND t.cal = substr(pt.month, 6, 2)::INT
               LEFT JOIN {kc} m ON m.cal = substr(pt.month, 6, 2)::INT
               WHERE {w} GROUP BY 1""", [vs, vs, K_FRP if frp else K_GLOBAL] + p)
    s = df.set_index(pd.to_datetime(df.d)).h.astype(float)
    return s.reindex(pd.date_range(FIRST_DAY, LAST_DAY), fill_value=0.0)


@lru_cache(maxsize=64)
def daily_normal(bbox, reg, group=None, metric="hotspots"):
    """Median across years of the 7-day centred mean, per calendar day (MM-DD)."""
    s = daily_all(bbox, reg, group, metric).rolling(7, center=True, min_periods=1).mean()
    return s.groupby(s.index.strftime("%m-%d")).median()


def parse_day(v, name):
    if not v or not DATE_RE.match(v):
        raise HTTPException(400, f"{name} must be YYYY-MM-DD")
    return pd.Timestamp(v)


@app.get("/api/daily")
def daily(start: str, end: str, bbox: str = None, region: str = None, group: str = None, metric: str = None):
    """Daily hotspots in [start, end] (max 400 days) with the normal for each calendar day."""
    s, e = parse_day(start, "start"), parse_day(end, "end")
    if e < s or (e - s).days > 400:
        raise HTTPException(400, "daily range must be 1-400 days")
    b, reg, grp = parse_bbox(bbox), parse_region(region), parse_group(group)
    met = parse_metric(metric, grp)
    d = daily_all(b, reg, grp, met)[max(s, FIRST_DAY):min(e, LAST_DAY)]
    norm = daily_normal(b, reg, grp, met)
    med = norm.reindex(d.index.strftime("%m-%d")).to_numpy()
    out = pd.DataFrame({"date": d.index.strftime("%Y-%m-%d"), "hotspots": d.round(1).to_numpy(), "median": np.round(med, 1)})
    out["pct_vs_median"] = np.where(out["median"] > 0, ((out.hotspots - out["median"]) / out["median"].where(out["median"] > 0) * 100).round(1), np.nan)
    out["note"] = out.date.str[:7].map(lambda m: NOTES.get(m, ""))
    return records(out)


def _when(ts):
    part = "early" if ts.day <= 10 else "mid" if ts.day <= 20 else "late"
    return f"{part}-{ts.strftime('%b')}"


@app.get("/api/season")
def season(bbox: str = None, region: str = None, group: str = None, metric: str = None):
    """Plain-language fire season for an area: typical start, peak week and end, plus the latest season vs normal."""
    b, reg, grp = parse_bbox(bbox), parse_region(region), parse_group(group)
    d = daily_all(b, reg, grp, parse_metric(metric, grp))
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


@lru_cache(maxsize=64)
def _outlook(bbox, reg, cutoff):
    """Outlook for cutoff+1..+3 from months <= cutoff, with the leak-free backtest and next-season dates."""
    vs = META["viirs_start"]
    s = series(bbox, reg).set_index("month").hotspots
    s = s[s.index <= cutoff]
    bt = outlook_model.backtest(s, vs, outlook_model.BACKTEST[0], min(outlook_model.BACKTEST[1], cutoff))
    o = outlook_model.outlook(s, cutoff, vs, bt)
    cut_day = pd.Timestamp(f"{cutoff}-01") + pd.offsets.MonthEnd(0)
    o["season"] = outlook_model.season_dates(daily_all(bbox, reg)[:cut_day], cut_day, int(vs[:4]))
    recent = [outlook_model.add_months(cutoff, -k) for k in range(3)]
    o["provisional_inputs"] = [m for m in recent if m in META.get("provisional_months", [])]
    o["gap_inputs"] = [m for m in recent if m in GAP_MONTHS]
    # normal for each calendar month (VIIRS-era median before the cutoff), to tell fire-season months from quiet ones
    v = s[s.index >= vs]
    o["monthly_normals"] = {f"{c:02d}": float(v[v.index.str[5:] == f"{c:02d}"].median()) for c in range(1, 13)}
    return o


def cutoff_for(day):
    """Latest complete month on or before a day."""
    m = day.strftime("%Y-%m")
    return min(m if (day + pd.Timedelta(days=1)).day == 1 else outlook_model.add_months(m, -1), LAST_COMPLETE)


@app.get("/api/outlook")
def outlook(bbox: str = None, region: str = None):
    """Fire outlook for the next 1-3 months after the latest complete month (statistical; see backend/outlook.py)."""
    return _outlook(parse_bbox(bbox), parse_region(region), LAST_COMPLETE)


def outlook_alert(o, asof):
    """'Outlook: above-normal season likely' when, for a fire-season month in the next 3, the 80% range lies mostly
    above normal (P(above normal) >= 0.8)."""
    norms = sorted(o["monthly_normals"].values())
    season_level = norms[len(norms) // 2]  # a fire-season month has a normal at or above the median month
    hits = [m for m in o["months"] if m["p_above"] >= 0.8 and m["normal"] >= max(season_level, alerts_engine.MIN_HOTSPOTS)]
    if not hits:
        return None
    m = hits[0]
    return {"kind": "outlook", "severity": "Watch", "asof": str(asof.date()), "provisional": bool(o["provisional_inputs"]),
            "message": f"Outlook: above-normal season likely. {pd.Period(m['month'], 'M').strftime('%b %Y')}: {m['lo']:,.0f}–{m['hi']:,.0f} "
                       f"hotspots expected (80% range) vs normal {m['normal']:,.0f}. {outlook_model.DISCLAIMER}"}


@app.get("/api/alerts")
def alerts(asof: str, bbox: str = None, region: str = None):
    """Alerts lite for one area as of a date (inclusive; a simulated date never sees later data)."""
    d = parse_day(asof, "asof")
    if not (FIRST_DAY <= d <= LAST_DAY):
        raise HTTPException(400, f"asof must be within {FIRST_DAY.date()}..{LAST_DAY.date()}")
    gaps = [(g["start"], g["end"]) for g in META.get("data_gaps", []) if g.get("sensor") == "VIIRS"]
    b, reg = parse_bbox(bbox), parse_region(region)
    out = alerts_engine.evaluate(daily_all(b, reg), d, gaps, META.get("provisional_months", []))
    try:
        a = outlook_alert(_outlook(b, reg, cutoff_for(d)), d)
    except (ValueError, KeyError, IndexError):  # too little history before a simulated date for an outlook
        a = None
    return out + ([a] if a else [])


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
def cell(lon: float, lat: float, grid: float = Query(..., ge=0.05, le=5), start: str = None, end: str = None, metric: str = None):
    """Hover details for one map cell: admin names at its centre, hotspots (or FRP), and % vs the median of the same months."""
    s, e = parse_range(start, end)
    col = "frp" if parse_metric(metric) == "frp" else "hotspots"
    out = {"lon": lon, "lat": lat, **(ADMIN.at(lon, lat) if ADMIN.ok else {})}
    out.update(current=None, median=None, pct_vs_median=None)
    if month_idx(e) - month_idx(s) < 12:
        h = grid / 2
        st = window_stats(s, e, grid, (lon - h + 1e-6, lat - h + 1e-6, lon + h - 1e-6, lat + h - 1e-6), col)
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

""""What is burning": label every hotspot with MODIS MCD12Q1 C6.1 land cover (IGBP, LC_Type1, 500 m, yearly).

  python land_cover.py fetch    # AppEEARS area extraction -> data_landcover/*.tif (cached; resumes a submitted task)
  python land_cover.py label    # adds land_cover + lc_group to points.parquet, lc_<group> columns to cells*.parquet
  python land_cover.py report --report "Punjab-Haryana:73.8,28.4,77.6,32.6" --report "Riau:100.0,-1.2,103.9,2.95"
  python land_cover.py spotcheck  # 20 random points vs an independent AppEEARS point extraction (native grid)

Credentials: EARTHDATA_USER / EARTHDATA_PASS in the repo-root .env (never in code).
Each hotspot uses the PREVIOUS year's map (a fire changes the land cover it burns), clamped to the years available.
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
API = "https://appeears.earthdatacloud.nasa.gov/api"
PRODUCT, LAYER = "MCD12Q1.061", "LC_Type1"
ASIA = (60.0, -11.0, 150.0, 55.0)  # lon0, lat0, lon1, lat1
IGBP = {1: "Evergreen needleleaf forest", 2: "Evergreen broadleaf forest", 3: "Deciduous needleleaf forest",
        4: "Deciduous broadleaf forest", 5: "Mixed forest", 6: "Closed shrubland", 7: "Open shrubland",
        8: "Woody savanna", 9: "Savanna", 10: "Grassland", 11: "Permanent wetland", 12: "Cropland",
        13: "Urban and built-up", 14: "Cropland/natural vegetation mosaic", 15: "Permanent snow and ice",
        16: "Barren", 17: "Water bodies"}
# responder-friendly groups; anything unmapped (fill 255, outside the map) falls into "other"
GROUPS = [("forest", "Forest", [1, 2, 3, 4, 5]), ("shrub", "Shrubland/Savanna", [6, 7, 8, 9]),
          ("grass", "Grassland", [10]), ("wetland", "Wetland", [11]), ("crop", "Cropland", [12, 14]),
          ("other", "Other", [13, 15, 16, 17])]
KEYS = [g[0] for g in GROUPS]
GROUP_OF = np.full(256, KEYS.index("other"), np.int8)
for _i, (_k, _l, _codes) in enumerate(GROUPS):
    GROUP_OF[_codes] = _i
NOTE = "Land cover: MODIS MCD12Q1 IGBP, 500 m; peatland is not a separate class."


# ---------- AppEEARS ----------
def client():
    import httpx
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    user, pw = os.environ.get("EARTHDATA_USER"), os.environ.get("EARTHDATA_PASS")
    if not user or not pw:
        sys.exit("Set EARTHDATA_USER and EARTHDATA_PASS in .env (free account: https://urs.earthdata.nasa.gov)")
    c = httpx.Client(timeout=300, follow_redirects=True)  # httpx drops the token on the cross-host S3 redirect
    r = c.post(f"{API}/login", auth=(user, pw))
    if r.status_code != 200:
        sys.exit(f"Earthdata login failed ({r.status_code}): {r.text[:200]}")
    c.headers["Authorization"] = f"Bearer {r.json()['token']}"
    return c


def run_task(c, task, state_file):
    """Submit once (task id cached in state_file so a re-run resumes), wait until done, return the bundle file list."""
    tid = json.loads(state_file.read_text())["task_id"] if state_file.exists() else None
    if not tid:
        r = c.post(f"{API}/task", json=task)
        r.raise_for_status()
        tid = r.json()["task_id"]
        state_file.write_text(json.dumps({"task_id": tid}))
        print(f"submitted AppEEARS task {tid}")
    while (st := c.get(f"{API}/task/{tid}").raise_for_status().json()["status"]) != "done":
        if st == "error":
            state_file.unlink()
            sys.exit(f"AppEEARS task {tid} failed; re-run to resubmit")
        print(f"  task {tid}: {st} ({time.strftime('%H:%M')})", flush=True)
        time.sleep(60)
    return tid, c.get(f"{API}/bundle/{tid}").raise_for_status().json()["files"]


def download(c, tid, f, dst):
    tmp = dst.with_suffix(dst.suffix + ".part")
    with c.stream("GET", f"{API}/bundle/{tid}/{f['file_id']}") as r, open(tmp, "wb") as out:
        r.raise_for_status()
        for chunk in r.iter_bytes(1 << 20):
            out.write(chunk)
    compress(tmp, dst)


GEO_TAGS = (33550, 33922, 34735, 34736, 34737)  # pixel scale, tie point, GeoKey directory, double and ASCII params


def compress(src, dst):
    """Re-save a downloaded GeoTIFF zlib-compressed and tiled (land cover shrinks ~10x; AppEEARS estimates the
    uncompressed Asia stack at ~29 GB), keeping its georeferencing tags, then delete the original."""
    import tifffile
    with tifffile.TiffFile(src) as t:
        page = t.pages[0]
        arr = page.asarray()
        extratags = [(tag.code, tag.dtype, tag.count, tag.value) for tag in page.tags.values() if tag.code in GEO_TAGS]
    part = dst.with_suffix(dst.suffix + ".zpart")
    tifffile.imwrite(part, arr, compression="zlib", tile=(512, 512), extratags=extratags)
    os.replace(part, dst)  # never leave a half-written file that later looks complete
    os.remove(src)


def tif_years(lc_dir):
    out = {}
    for p in Path(lc_dir).glob(f"*{LAYER}*.tif"):
        m = re.search(r"doy(\d{4})", p.name)
        if m:
            out[int(m.group(1))] = p
    return dict(sorted(out.items()))


def fetch(lc_dir, first_year, last_year, bbox):
    lc_dir.mkdir(parents=True, exist_ok=True)
    want = set(range(first_year, last_year + 1))
    if want <= set(tif_years(lc_dir)):
        print(f"cached: {sorted(want)} in {lc_dir}")
        return
    lon0, lat0, lon1, lat1 = bbox
    task = {"task_type": "area", "task_name": f"hots45_{PRODUCT}_{first_year}_{last_year}",
            "params": {"dates": [{"startDate": f"01-01-{first_year}", "endDate": f"12-31-{last_year}"}],
                       "layers": [{"product": PRODUCT, "layer": LAYER}],
                       "output": {"format": {"type": "geotiff"}, "projection": "geographic"},
                       "geo": {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": {
                           "type": "Polygon", "coordinates": [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]]}}]}}}
    c = client()
    tid, files = run_task(c, task, lc_dir / "task.json")
    for f in files:
        name = Path(f["file_name"]).name
        if LAYER in name and name.endswith(".tif") and not (lc_dir / name).exists():
            print(f"  downloading {name} ({f['file_size'] / 1e6:.0f} MB)", flush=True)
            download(c, tid, f, lc_dir / name)
    got = tif_years(lc_dir)
    print(f"land cover years available: {list(got)}; missing from request: {sorted(want - set(got))}")


# ---------- lookup ----------
def load_map(path):
    """Returns (uint8 array, (x0, y0, dx, dy)) for a north-up geographic GeoTIFF; x0, y0 = outer corner of pixel (0, 0)."""
    import tifffile
    with tifffile.TiffFile(path) as t:
        page = t.pages[0]
        dx, dy = page.tags["ModelPixelScaleTag"].value[:2]
        x0, y0 = page.tags["ModelTiepointTag"].value[3:5]
        if (t.geotiff_metadata or {}).get("GTRasterTypeGeoKey") in (2, "RasterPixelIsPoint"):
            x0, y0 = x0 - dx / 2, y0 + dy / 2  # tie point is a pixel centre
        return page.asarray(), (x0, y0, dx, dy)


def lookup(arr, gt, lon, lat):
    """IGBP class at each lon/lat; 255 outside the map."""
    x0, y0, dx, dy = gt
    col = np.floor((np.asarray(lon) - x0) / dx).astype(np.int64)
    row = np.floor((y0 - np.asarray(lat)) / dy).astype(np.int64)
    ok = (col >= 0) & (col < arr.shape[1]) & (row >= 0) & (row < arr.shape[0])
    out = np.full(len(col), 255, np.uint8)
    out[ok] = arr[row[ok], col[ok]]
    return out


def map_year(year, years):
    """Previous year's map (or the latest available before it), else the earliest map."""
    return max((y for y in years if y <= year - 1), default=min(years))


def label_file(path, arr, gt):
    """Rewrite one points parquet file with land_cover (IGBP, null when unknown) and lc_group, batch by batch."""
    pf = pq.ParquetFile(path)
    cols = [c for c in pf.schema_arrow.names if c not in ("land_cover", "lc_group")]
    tmp = path.with_suffix(".tmp")
    writer = None
    counts = np.zeros(len(KEYS), np.int64)
    for batch in pf.iter_batches(batch_size=1_000_000, columns=cols):
        lc = lookup(arr, gt, batch.column("lon").to_numpy(), batch.column("lat").to_numpy())
        g = GROUP_OF[lc]
        counts += np.bincount(g, minlength=len(KEYS))
        t = pa.Table.from_batches([batch])
        t = t.append_column("land_cover", pa.array(lc, mask=(lc == 0) | (lc > 17)))
        t = t.append_column("lc_group", pa.DictionaryArray.from_arrays(pa.array(g), pa.array(KEYS)))
        if writer is None:
            writer = pq.ParquetWriter(tmp, t.schema, compression="zstd")
        writer.write_table(t)
    if writer is None:
        return counts
    writer.close()
    os.replace(tmp, path)
    return counts


def group_columns(con, app, grid):
    """Per-group harmonized hotspots for every cells.parquet row, harmonized the same way as the total:
    before viirs_start hotspots = k x MODIS, so a group's share is its MODIS share; from it, its VIIRS share."""
    meta = json.loads((app / "meta.json").read_text())
    pts = f"read_parquet('{app}/points.parquet/*/*.parquet', hive_partitioning=true)"
    piv = ", ".join(f"count(*) FILTER (WHERE sensor = 'MODIS' AND lc_group = '{k}') m_{k}, "
                    f"count(*) FILTER (WHERE sensor = 'VIIRS' AND lc_group = '{k}') v_{k}" for k in KEYS)
    con.execute(f"""CREATE OR REPLACE TABLE grp AS
        SELECT month, round((floor(lat / {grid}) + 0.5) * {grid}, 4) lat, round((floor(lon / {grid}) + 0.5) * {grid}, 4) lon, {piv}
        FROM {pts} GROUP BY ALL""")
    cells = app / "cells.parquet"
    old = [c for c in pq.ParquetFile(cells).schema_arrow.names if not c.startswith("lc_")]
    share = ", ".join(f"coalesce(c.hotspots * CASE WHEN c.month < '{meta['viirs_start']}' THEN g.m_{k} / nullif(c.modis, 0) "
                      f"ELSE g.v_{k} / nullif(c.viirs, 0) END, 0)::DOUBLE lc_{k}" for k in KEYS)
    con.execute(f"""COPY (SELECT {', '.join('c.' + c for c in old)}, {share}
                          FROM read_parquet('{cells}') c LEFT JOIN grp g USING (month, lat, lon) ORDER BY month, lat, lon)
                    TO '{app}/cells.tmp.parquet' (FORMAT parquet, COMPRESSION zstd)""")
    lc = " + ".join(f"lc_{k}" for k in KEYS)
    bad, = con.execute(f"SELECT count(*) FROM '{app}/cells.tmp.parquet' WHERE abs(({lc}) - hotspots) > 1e-6 * greatest(1, hotspots)").fetchall()[0]
    if bad:
        sys.exit(f"{bad} cells: group sums differ from hotspots (points and cells out of sync?) — cells.parquet left unchanged")
    os.replace(app / "cells.tmp.parquet", cells)
    coarse_deg = meta.get("coarse_grid_deg")
    if coarse_deg:  # rebuild the globe file from cells, exactly as fire_harmonize.py does, plus the group columns
        # every additive column (counts, hotspots, lc_*, frp sums); percentiles do not aggregate
        add = [c for c in pq.ParquetFile(cells).schema_arrow.names if c not in ("month", "lat", "lon") and "_p90" not in c]
        sums = ", ".join(f"sum({c})" + ("::BIGINT" if c in ("modis", "viirs") else "") + f" {c}" for c in add)
        con.execute(f"""COPY (SELECT month, (floor(lat / {coarse_deg}) + 0.5) * {coarse_deg} lat, (floor(lon / {coarse_deg}) + 0.5) * {coarse_deg} lon,
                                     {sums}
                              FROM read_parquet('{cells}') GROUP BY ALL ORDER BY month, lat, lon)
                        TO '{app}/cells_{coarse_deg}.parquet' (FORMAT parquet, COMPRESSION zstd)""")


def label(app, lc_dir):
    years = tif_years(lc_dir)
    if not years:
        sys.exit(f"No {LAYER} GeoTIFFs in {lc_dir}; run `python land_cover.py fetch` first")
    parts = sorted((app / "points.parquet").glob("year=*"))
    total, cur = np.zeros(len(KEYS), np.int64), None
    for d in parts:
        y = int(d.name.split("=")[1])
        my = map_year(y, years)
        if cur is None or cur[0] != my:
            cur = (my, *load_map(years[my]))
        n = sum(label_file(f, cur[1], cur[2]) for f in sorted(d.glob("*.parquet")))
        total += n
        print(f"{y}: map {my}  " + "  ".join(f"{k} {v / max(1, n.sum()):.0%}" for k, v in zip(KEYS, n)), flush=True)
    con = duckdb.connect()
    con.execute("SET memory_limit='4GB'; SET preserve_insertion_order=false")
    meta_path = app / "meta.json"
    meta = json.loads(meta_path.read_text())
    group_columns(con, app, meta["grid_deg"])
    unknown, = con.execute(f"SELECT count(*) FROM read_parquet('{app}/points.parquet/*/*.parquet') WHERE land_cover IS NULL").fetchall()[0]
    meta["land_cover"] = {
        "product": f"MODIS {PRODUCT} (Collection 6.1) {LAYER}, IGBP, 500 m, yearly",
        "map_years": list(years), "rule": "each hotspot uses the previous year's map, clamped to the available years",
        "groups": [{"key": k, "label": lab, "classes": codes} for k, lab, codes in GROUPS],
        "classes": {str(k): v for k, v in IGBP.items()},
        "unknown_points": int(unknown), "note": NOTE,
    }
    meta_path.write_text(json.dumps(meta, indent=2, allow_nan=False))
    print(f"labelled {total.sum():,} points ({unknown:,} with no land-cover value -> other); cells updated")


# ---------- validation ----------
def shares(con, cells, bbox=None):
    w = "TRUE" if not bbox else f"lon BETWEEN {bbox[0]} AND {bbox[2]} AND lat BETWEEN {bbox[1]} AND {bbox[3]}"
    row = con.execute(f"SELECT {', '.join(f'sum(lc_{k})' for k in KEYS)} FROM read_parquet('{cells}') WHERE {w}").fetchall()[0]
    v = np.array([float(x or 0) for x in row])
    return v, v / v.sum() if v.sum() else v


def report(app, regions):
    con = duckdb.connect()
    cells = app / "cells.parquet"
    labels = dict((k, lab) for k, lab, _ in GROUPS)
    print(f"{'region':<16}{'hotspots':>12}  " + "".join(f"{labels[k]:>19}" for k in KEYS))
    for name, b in [("Asia", None)] + regions:
        v, s = shares(con, cells, b)
        print(f"{name:<16}{v.sum():>12,.0f}  " + "".join(f"{x:>19.1%}" for x in s))


def spotcheck(app, lc_dir, n=20, seed=46):
    """n random hotspots: stored label vs the local map (same lookup), and vs AppEEARS' own point extraction on the
    native sinusoidal grid — an independent check of georeferencing and of the previous-year rule."""
    years = tif_years(lc_dir)
    con = duckdb.connect()
    # hash order = a deterministic pseudo-random draw across every year partition (DuckDB's reservoir sample
    # over the partitioned files returned only the first year)
    pts = con.execute(f"""SELECT lat, lon, acq_date::DATE d, land_cover, lc_group
        FROM read_parquet('{app}/points.parquet/*/*.parquet')
        ORDER BY hash(lat, lon, acq_date, {seed}) LIMIT {n}""").fetchall()
    c = client()
    first, last = min(years), max(years)
    task = {"task_type": "point", "task_name": f"hots45_spotcheck_{seed}",
            "params": {"dates": [{"startDate": f"01-01-{first}", "endDate": f"12-31-{last}"}],
                       "layers": [{"product": PRODUCT, "layer": LAYER}],
                       "coordinates": [{"id": str(i), "latitude": p[0], "longitude": p[1]} for i, p in enumerate(pts)]}}
    tid, files = run_task(c, task, lc_dir / f"spotcheck_{seed}.json")
    f = next(f for f in files if f["file_name"].endswith("results.csv"))
    import io
    import pandas as pd
    res = pd.read_csv(io.BytesIO(c.get(f"{API}/bundle/{tid}/{f['file_id']}").raise_for_status().content))
    col = next(x for x in res.columns if x.endswith(LAYER))
    agree = 0
    print(f"{'#':>2} {'lat':>9} {'lon':>10} {'date':>10} {'map':>4}  {'stored':<38}{'native grid (AppEEARS point)':<38}")
    for i, (lat, lon, d, lc, grp) in enumerate(pts):
        my = map_year(d.year, years)
        nat = res[(res.ID.astype(str) == str(i)) & (res.Date.astype(str).str[:4] == str(my))][col]
        nat = int(nat.iloc[0]) if len(nat) else None
        ok = nat == (lc if lc is not None else 255)
        agree += ok
        name = lambda v: f"{v} {IGBP.get(v, 'no data')}"  # noqa: E731
        print(f"{i:>2} {lat:>9.4f} {lon:>10.4f} {d} {my}  {name(lc if lc is not None else 255):<38}"
              f"{name(nat) if nat is not None else '—':<38}{'' if ok else '  ✗'}")
    print(f"{agree}/{len(pts)} agree with the native-grid value")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=["fetch", "label", "report", "spotcheck"])
    ap.add_argument("--app", default=str(ROOT / "backend" / "app_data"))
    ap.add_argument("--lc-dir", default=str(HERE / "data_landcover"))
    ap.add_argument("--bbox", type=float, nargs=4, default=ASIA, metavar=("LON0", "LAT0", "LON1", "LAT1"))
    ap.add_argument("--report", action="append", default=[], metavar="NAME:lon0,lat0,lon1,lat1")
    a = ap.parse_args(argv)
    app, lc_dir = Path(a.app), Path(a.lc_dir)
    if a.step == "fetch":
        meta = json.loads((app / "meta.json").read_text())
        fetch(lc_dir, int(meta["first_month"][:4]) - 1, int(meta["last_month"][:4]) - 1, a.bbox)
    elif a.step == "label":
        label(app, lc_dir)
    elif a.step == "report":
        regions = []
        for r in a.report:
            name, _, b = r.rpartition(":")
            regions.append((name, [float(x) for x in b.split(",")]))
        report(app, regions)
    else:
        spotcheck(app, lc_dir)


if __name__ == "__main__":
    main()

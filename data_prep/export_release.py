"""Write the flat files the serverless backend reads from DATA_URL (e.g. a GitHub Release).

Points are re-sorted by 2-degree tile with small row groups, so a region query over HTTP fetches only the
row groups whose lat/lon range overlaps it (date-ordered files would make every query read all of Asia).
Same columns and values as points.parquet; only the row order differs.

usage: python data_prep/export_release.py backend/app_data OUT_DIR
"""
import json
import shutil
import sys
from pathlib import Path

import duckdb

src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
for name in ["meta.json", "admin.parquet", "cell_admin.parquet"]:
    if (src / name).exists():
        shutil.copy(src / name, out / name)
db = duckdb.connect()
# cells files are downloaded on every serverless cold start, so the release copy is slimmed: per-cell FRP p90 is not
# served by the API (dropped), FRP sums are rounded to 0.1 MW (FIRMS reports FRP to 0.1-0.01 MW), and FRP / land-cover
# group columns are stored as 4-byte floats; hotspots stay exact doubles.
for f in [src / "cells.parquet", *sorted(src.glob("cells_*.parquet"))]:
    cols = [r[0] for r in db.execute(f"DESCRIBE SELECT * FROM read_parquet('{f}')").fetchall()]
    sel = ", ".join(f"round({c}, 1)::FLOAT {c}" if c.startswith("frp") else f"{c}::FLOAT {c}" if c.startswith("lc_") else c
                    for c in cols if "_p90" not in c)  # 4-byte floats: ~7 significant digits, far finer than shown
    db.execute(f"COPY (SELECT {sel} FROM read_parquet('{f}')) TO '{out / f.name}' (FORMAT parquet, COMPRESSION zstd)")
for d in sorted((src / "points.parquet").glob("year=*")):
    y = d.name.split("=")[1]
    db.execute(f"""COPY (SELECT * EXCLUDE (year), {int(y)}::BIGINT AS year
                        FROM read_parquet('{d}/*.parquet', hive_partitioning=true)
                        ORDER BY floor(lat / 2), floor(lon / 2), acq_date)
                   TO '{out}/points_{y}.parquet' (FORMAT parquet, ROW_GROUP_SIZE 20000, COMPRESSION zstd)""")
    print(y, end=" ", flush=True)
print()
# the backend requests points_<year> for every year in meta.json's range, so a year with no points still needs a file
meta = json.loads((src / "meta.json").read_text())
for y in range(int(meta["first_month"][:4]), int(meta["last_month"][:4]) + 1):
    if not (out / f"points_{y}.parquet").exists():
        any_year = next(out.glob("points_*.parquet"))
        db.execute(f"COPY (SELECT * FROM read_parquet('{any_year}') LIMIT 0) TO '{out}/points_{y}.parquet' (FORMAT parquet)")
        print(f"points_{y}.parquet: no points, wrote an empty file")

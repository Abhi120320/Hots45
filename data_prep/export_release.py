"""Write the flat files the serverless backend reads from DATA_URL (e.g. a GitHub Release).

Points are re-sorted by 2-degree tile with small row groups, so a region query over HTTP fetches only the
row groups whose lat/lon range overlaps it (date-ordered files would make every query read all of Asia).
Same columns and values as points.parquet; only the row order differs.

usage: python data_prep/export_release.py backend/app_data OUT_DIR
"""
import shutil
import sys
from pathlib import Path

import duckdb

src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
for name in ["meta.json", "cells.parquet", "admin.parquet", "cell_admin.parquet", *[p.name for p in src.glob("cells_*.parquet")]]:
    if (src / name).exists():
        shutil.copy(src / name, out / name)
db = duckdb.connect()
for d in sorted((src / "points.parquet").glob("year=*")):
    y = d.name.split("=")[1]
    db.execute(f"""COPY (SELECT lat, lon, acq_date, month, sensor, confidence, frp, {int(y)}::BIGINT AS year
                        FROM read_parquet('{d}/*.parquet')
                        ORDER BY floor(lat / 2), floor(lon / 2), acq_date)
                   TO '{out}/points_{y}.parquet' (FORMAT parquet, ROW_GROUP_SIZE 20000, COMPRESSION zstd)""")
    print(y, end=" ", flush=True)
print()

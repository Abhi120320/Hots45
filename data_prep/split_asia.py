import duckdb, glob, os

os.makedirs("data_asia", exist_ok=True)
for f in sorted(glob.glob("data/**/*.csv", recursive=True)):
    out = os.path.join("data_asia", os.path.basename(f))
    if os.path.exists(out):
        print("skip (already done):", os.path.basename(f))
        continue
    duckdb.sql(f"""
        COPY (
            SELECT * FROM read_csv('{f}', all_varchar=true)
            WHERE TRY_CAST(longitude AS DOUBLE) BETWEEN 60 AND 150
              AND TRY_CAST(latitude  AS DOUBLE) BETWEEN -11 AND 55
        ) TO '{out}' (HEADER)
    """)
    print("done:", os.path.basename(f))

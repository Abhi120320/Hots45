"""Clean NASA FIRMS MODIS + VIIRS hotspot CSVs, grid them, harmonize MODIS to the VIIRS scale,
and write the app data contract to backend/app_data/.

All row-level work (read, clean, de-duplicate, grid, aggregate) runs in DuckDB directly on the CSV globs;
only small aggregate tables (tile x month) come into pandas, so multi-GB inputs fit in memory.

Usage:
  python fire_harmonize.py --modis "data_asia/fire_*_M-C61_*.csv" --viirs "data_asia/fire_*_SV-C2_*.csv" \
      --start 2003-01 --region Asia --report "Punjab-Haryana:73.8,28.4,77.6,32.6"
  python fire_harmonize.py --modis "sample_data/modis*.csv" --viirs "sample_data/viirs*.csv" --sample
"""
import argparse
import datetime
import glob
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
GRID = 0.05
COARSE = 0.5  # globe-view cells file
TILE = 10  # degrees; harmonization factors are fitted per tile x calendar month
MIN_OVERLAP = 3  # overlap months needed for a per-tile (or per-calendar-month) factor
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
COLS = ["latitude", "longitude", "acq_date", "acq_time", "confidence", "frp"]
MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


# ---------- read + clean + de-duplicate (DuckDB) ----------
def files_for(pattern, sensor):
    files = sorted(glob.glob(pattern))
    if not files:
        sys.exit(f"No {sensor} files match {pattern!r}")
    for f in files:
        head = pd.read_csv(f, nrows=0).columns
        missing = [c for c in COLS if c not in head]
        if missing:
            sys.exit(f"{f}: missing columns {missing}")
    return files


def csv_scan(files, sensor):
    """SQL for one sensor's raw rows. NRT files lack `type`; union_by_name fills it with NULL."""
    lst = "[" + ",".join("'" + f.replace("'", "''") + "'" for f in files) + "]"
    return (f"SELECT '{sensor}' AS sensor, latitude, longitude, acq_date, acq_time, confidence, frp, type, "
            f"contains(lower(filename), 'nrt') AS is_nrt, filename "
            f"FROM read_csv({lst}, union_by_name=true, filename=true, header=true, "
            f"types={{'confidence':'VARCHAR','acq_time':'VARCHAR','acq_date':'DATE','type':'INTEGER'}})")


def load_points(con, modis_files, viirs_files, start=None, end=None, bbox=None):
    """Builds table `pts` (clean, de-duplicated points). Returns per-sensor row stats."""
    where = ["latitude IS NOT NULL", "longitude IS NOT NULL", "acq_date IS NOT NULL"]
    params = []
    if start:
        where.append("acq_date >= ?::DATE")
        params.append(f"{start}-01")
    if end:
        where.append("acq_date < ?::DATE + INTERVAL 1 MONTH")
        params.append(f"{end}-01")
    if bbox:
        where.append("longitude BETWEEN ? AND ? AND latitude BETWEEN ? AND ?")
        params += [bbox[0], bbox[2], bbox[1], bbox[3]]
    con.execute(f"""CREATE OR REPLACE TABLE raw AS
        SELECT * FROM ({csv_scan(modis_files, 'MODIS')} UNION ALL BY NAME {csv_scan(viirs_files, 'VIIRS')})
        WHERE {' AND '.join(where)}""", params)
    # NRT rows dated on/before the archive's last date are superseded by the archive, even when their
    # coordinates/times differ slightly (exact-duplicate matching below would miss them).
    con.execute("""CREATE OR REPLACE TABLE nrt_cut AS
        SELECT sensor, max(acq_date) AS archive_end FROM raw WHERE NOT is_nrt GROUP BY sensor""")
    nrt_overlap = dict(con.execute("""SELECT r.sensor, count(*) FROM raw r JOIN nrt_cut c USING (sensor)
        WHERE r.is_nrt AND r.acq_date <= c.archive_end GROUP BY r.sensor""").fetchall())
    con.execute("""DELETE FROM raw WHERE is_nrt AND acq_date <= (
        SELECT archive_end FROM nrt_cut c WHERE c.sensor = raw.sensor)""")
    # Same detection in two files (archive chunk boundaries, archive vs NRT): keep the archive copy.
    con.execute("""CREATE OR REPLACE TABLE dedup AS
        SELECT * FROM raw QUALIFY row_number() OVER (
            PARTITION BY latitude, longitude, acq_date, acq_time, sensor ORDER BY is_nrt, filename) = 1""")
    con.execute("""CREATE OR REPLACE TABLE pts AS
        SELECT latitude::DOUBLE AS lat, longitude::DOUBLE AS lon, acq_date, strftime(acq_date, '%Y-%m') AS month,
               sensor, trim(confidence) AS confidence, frp::DOUBLE AS frp, is_nrt
        FROM dedup
        WHERE coalesce(type, 0) = 0
          AND CASE sensor WHEN 'MODIS' THEN TRY_CAST(trim(confidence) AS DOUBLE) >= 30
                          ELSE lower(trim(confidence)) IN ('n', 'h') END""")
    stats = {}
    for s in ("MODIS", "VIIRS"):
        raw, = con.execute("SELECT count(*) FROM raw WHERE sensor = ?", [s]).fetchall()[0]
        ded, = con.execute("SELECT count(*) FROM dedup WHERE sensor = ?", [s]).fetchall()[0]
        cln, = con.execute("SELECT count(*) FROM pts WHERE sensor = ?", [s]).fetchall()[0]
        ov = nrt_overlap.get(s, 0)
        stats[s] = {"raw": raw + ov, "nrt_overlap": ov, "duplicates": raw - ded, "clean": cln}
        print(f"{s}: {raw + ov:,} rows, {ov:,} NRT rows inside archive dates dropped, "
              f"{raw - ded:,} duplicates removed, {cln:,} after cleaning")
    for s, f, l in con.execute("""SELECT sensor, CASE WHEN is_nrt THEN 'nrt' ELSE 'archive' END, min(acq_date) || ' .. ' || max(acq_date)
                                  FROM dedup GROUP BY ALL ORDER BY ALL""").fetchall():
        print(f"  {s} {f}: {l}")
    con.execute("DROP TABLE raw; DROP TABLE dedup; DROP TABLE nrt_cut")
    return stats


# ---------- harmonize ----------
def fit_ratio(m, v):
    """VIIRS = k * MODIS, least squares through the origin."""
    den = float((m * m).sum())
    return float((m * v).sum()) / den if den > 0 else float("nan")


def r2(pred, obs):
    ss_tot = float(((obs - obs.mean()) ** 2).sum())
    return 1 - float(((obs - pred) ** 2).sum()) / ss_tot if ss_tot > 0 else float("nan")


def fit_factors(monthly):
    """Domain-wide fit. monthly: DataFrame indexed by 'YYYY-MM' with modis, viirs totals."""
    ov = monthly[(monthly.modis > 0) & (monthly.viirs > 0)]
    if ov.empty:
        sys.exit("No overlap months with both MODIS and VIIRS > 0; cannot fit a factor.")
    k_global = fit_ratio(ov.modis, ov.viirs)
    cal = ov.index.str[5:7].astype(int)
    k_by = {}
    for mo in range(1, 13):
        sub = ov[cal == mo]
        k_by[mo] = fit_ratio(sub.modis, sub.viirs) if len(sub) >= MIN_OVERLAP else k_global
    return k_global, k_by, len(ov)


def fit_tiles(tm, k_by, all_tiles):
    """tm: tile x month totals (tx, ty, month, modis, viirs) over the fit window; all_tiles: every (tx, ty).
    Returns DataFrame tx, ty, cal, k, n, fallback."""
    tm = tm.assign(cal=tm.month.str[5:7].astype(int))
    ov = tm[(tm.modis > 0) & (tm.viirs > 0)]
    rows = []
    for tx, ty in all_tiles.itertuples(index=False):
        sub_t = ov[(ov.tx == tx) & (ov.ty == ty)]
        for cal in range(1, 13):
            sub = sub_t[sub_t.cal == cal]
            fallback = len(sub) < MIN_OVERLAP
            k = k_by[cal] if fallback else fit_ratio(sub.modis, sub.viirs)
            rows.append((tx, ty, cal, k, len(sub), fallback))
    return pd.DataFrame(rows, columns=["tx", "ty", "cal", "k", "n", "fallback"])


# ---------- analytics ----------
def all_months(first, last):
    return pd.period_range(first, last, freq="M").strftime("%Y-%m")


def anomalies(series, exclude=()):
    """series: Series of hotspots indexed by 'YYYY-MM' (zero-filled). Per-calendar-month stats.
    Months in `exclude` (known data gaps) are never flagged."""
    df = series.rename("hotspots").to_frame()
    df["cal"] = df.index.str[5:7].astype(int)
    g = df.groupby("cal").hotspots
    df["hist_median"] = g.transform("median")
    df["mean"] = g.transform("mean")
    df["std"] = g.transform(lambda s: s.std(ddof=0))
    df["pct_vs_median"] = np.where(df.hist_median > 0,
                                   (df.hotspots - df.hist_median) / df.hist_median.where(df.hist_median > 0) * 100,
                                   np.nan)
    df["z"] = np.where(df["std"] > 0, (df.hotspots - df["mean"]) / df["std"].where(df["std"] > 0), 0.0)
    df["flag"] = np.select([df.z > 2, df.z < -2], ["unusually high", "unusually low"], "")
    df.loc[df.index.isin(list(exclude)), "flag"] = ""
    return df


GAP_FRACTION = 0.10  # a day is a gap when its domain-wide count is < 10% of the 31-day centred median


def detect_gaps(daily):
    """daily: DataFrame sensor, d (date), n. Returns [{sensor, start, end}] runs of gap days.
    shortcut: needs a large domain so daily counts are never truly near zero; for a small --bbox it will
    flag quiet days — pass a sensor-outage list instead if you harmonize small areas."""
    out = []
    for sensor, g in daily.groupby("sensor"):
        n = g.set_index(pd.to_datetime(g.d)).n
        n = n.reindex(pd.date_range(n.index.min(), n.index.max()), fill_value=0)
        gap = n < GAP_FRACTION * n.rolling(31, center=True, min_periods=10).median()
        for _, run in gap[gap].groupby((gap != gap.shift()).cumsum()[gap]):
            out.append({"sensor": sensor, "start": f"{run.index[0]:%Y-%m-%d}", "end": f"{run.index[-1]:%Y-%m-%d}"})
    return out


def month_notes(months, viirs_start, gaps, nrt_months):
    """Per-month notes for the sensor the harmonized series uses that month (MODIS before viirs_start, else VIIRS).
    Returns (notes {month: text}, gap_months [..], provisional_months [..])."""
    in_use = lambda m: "MODIS" if m < viirs_start else "VIIRS"  # noqa: E731
    days = {}
    for gp in gaps:
        for d in pd.date_range(gp["start"], gp["end"]):
            m = f"{d:%Y-%m}"
            if m in months and gp["sensor"] == in_use(m):
                days.setdefault(m, []).append(d.day)
    notes, gap_months = {}, sorted(days)
    for m, ds in days.items():
        runs, start = [], ds[0]
        for a, b in zip(ds, ds[1:] + [None]):
            if b != a + 1:
                runs.append(f"{start}" if start == a else f"{start}–{a}")
                start = b
        notes[m] = f"{in_use(m)} data gap ({', '.join(runs)} {MONTHS[int(m[5:7]) - 1]})"
    prov = sorted(m for m, sensor in nrt_months if m in months and sensor == in_use(m))
    for m in prov:
        notes[m] = "; ".join(filter(None, ["provisional (NRT data)", notes.get(m)]))
    return notes, gap_months, prov


def region_monthly(con, months, bbox=None):
    """Monthly modis, viirs, hotspots and modis_k (= sum MODIS x tile k) for a bbox, zero-filled."""
    w, p = "TRUE", []
    if bbox:
        w, p = "lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?", [bbox[0], bbox[2], bbox[1], bbox[3]]
    df = con.execute(f"""SELECT month, sum(modis) modis, sum(viirs) viirs, sum(hotspots) hotspots,
                                sum(modis * k) modis_k FROM cells_k WHERE {w} GROUP BY month""", p).df()
    return df.set_index("month").reindex(months, fill_value=0).astype(float)


# ---------- charts ----------
def plot_before_after(monthly, viirs_start, path, title):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    x = pd.PeriodIndex(monthly.index, freq="M").to_timestamp()
    fig, ax = plt.subplots(figsize=(12, 4.5))
    ax.plot(x, monthly.modis, color="#7a7a7a", lw=1, label="MODIS raw")
    ax.plot(x, monthly.viirs.where(monthly.index >= viirs_start), color="#e8743b", lw=1, label="VIIRS S-NPP raw")
    ax.plot(x, monthly.modis_k, color="#2a5d9f", lw=1, ls="--", label="MODIS × k (VIIRS-equivalent)")
    ax.plot(x, monthly.hotspots, color="black", lw=1.4, label="Harmonized", zorder=1)
    ax.axvline(pd.Period(viirs_start, "M").to_timestamp(), color="#999", lw=0.8, ls=":")
    ax.set_ylabel("Hotspots per month")
    ax.set_title(f"Before vs after harmonization — {title}")
    ax.legend(frameon=False, fontsize=8)
    ax.grid(alpha=0.2)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def plot_calendar(an, path, title):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    years = sorted({m[:4] for m in an.index})
    mat = np.full((len(years), 12), np.nan)
    for m, row in an.iterrows():
        mat[years.index(m[:4]), int(m[5:7]) - 1] = row.hotspots
    fig, ax = plt.subplots(figsize=(10, 1.2 + 0.32 * len(years)))
    im = ax.imshow(mat, cmap="cividis", aspect="auto")
    for m, row in an.iterrows():
        if row.flag:
            ax.text(int(m[5:7]) - 1, years.index(m[:4]), "★", ha="center", va="center",
                    color="white" if row.flag == "unusually low" else "black", fontsize=10)
    ax.set_xticks(range(12), MONTHS)
    ax.set_yticks(range(len(years)), years)
    ax.set_title(f"Burning calendar — {title} (★ = |z| > 2)")
    fig.colorbar(im, ax=ax, label="Hotspots (VIIRS-equivalent)")
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def report(con, months, viirs_start, fit_end, gap_months, charts, name, bbox=None):
    m = region_monthly(con, months, bbox)
    ov = m[(m.modis > 0) & (m.viirs > 0) & (m.index >= viirs_start)]
    fit, after = ov[ov.index <= fit_end], ov[ov.index > fit_end]
    r = r2(fit.modis_k, fit.viirs)
    r_after = r2(after.modis_k, after.viirs) if len(after) > 1 else float("nan")
    bias_after = after.modis_k.sum() / after.viirs.sum() - 1 if len(after) else float("nan")
    an = anomalies(m.hotspots, gap_months)
    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    plot_before_after(m, viirs_start, charts / f"before_after_{slug}.png", name)
    plot_calendar(an, charts / f"burning_calendar_{slug}.png", name)
    flagged = an[an.flag != ""]
    print(f"\n[{name}] R² fit window ({len(fit)} months) = {r:.3f}   after {fit_end} ({len(after)} months) = {r_after:.3f}, "
          f"k×MODIS vs VIIRS {bias_after:+.1%}   anomalous months: {len(flagged)}")
    for mo, row in flagged.iterrows():
        print(f"  {mo} {row.flag} (z={row.z:.2f}, {row.hotspots:,.0f} vs median {row.hist_median:,.0f})")
    return r


def parse_bbox(s):
    v = [float(x) for x in s.split(",")]
    if len(v) != 4 or not (v[0] < v[2] and v[1] < v[3]):
        raise argparse.ArgumentTypeError("bbox must be lon0,lat0,lon1,lat1 with lon0<lon1, lat0<lat1")
    return v


# ---------- main ----------
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--modis", required=True, help="glob for MODIS CSVs")
    ap.add_argument("--viirs", required=True, help="glob for VIIRS S-NPP CSVs")
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("LON0", "LAT0", "LON1", "LAT1"))
    ap.add_argument("--start", help="first month to keep, YYYY-MM (e.g. 2003-01: MODIS before mid-2002 is Terra-only)")
    ap.add_argument("--end", help="last month to keep, YYYY-MM (drop a trailing partial month)")
    ap.add_argument("--fit-end", help="last month used to fit k, YYYY-MM (e.g. 2021-12, before Aqua's orbit drift)")
    ap.add_argument("--region", help="name shown in the app, e.g. Asia")
    ap.add_argument("--report", action="append", default=[], metavar="NAME:lon0,lat0,lon1,lat1",
                    help="extra region for R² and charts (repeatable)")
    ap.add_argument("--sample", action="store_true", help="mark output as synthetic sample data")
    ap.add_argument("--out", default=str(HERE.parent / "backend" / "app_data"))
    ap.add_argument("--charts", default=str(HERE))
    a = ap.parse_args(argv)
    for name in ("start", "end", "fit_end"):
        v = getattr(a, name)
        if v and not MONTH_RE.match(v):
            sys.exit(f"--{name.replace('_', '-')} must be YYYY-MM, got {v!r}")
    reports = []
    for r in a.report:
        name, _, b = r.rpartition(":")
        reports.append((name, parse_bbox(b)))

    out, charts = Path(a.out), Path(a.charts)
    out.mkdir(parents=True, exist_ok=True)
    charts.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="hots45_"))
    con = duckdb.connect(str(work / "work.duckdb"))  # file-backed so large joins spill to disk
    con.execute(f"SET temp_directory='{work}'; SET preserve_insertion_order=false; SET memory_limit='4GB'")
    try:
        stats = load_points(con, files_for(a.modis, "MODIS"), files_for(a.viirs, "VIIRS"), a.start, a.end, a.bbox)
        first, last = con.execute("SELECT min(month), max(month) FROM pts").fetchall()[0]
        months = list(all_months(first, last))

        print("\nRows per sensor and year (clean, de-duplicated):")
        yr = con.execute("SELECT year(acq_date) AS year, sensor, count(*) n FROM pts GROUP BY ALL").df()
        print(yr.pivot(index="year", columns="sensor", values="n").fillna(0).astype(int).to_string())

        # grid: cell x month counts; tile from cell centre so every cell sits in exactly one tile
        con.execute(f"""CREATE TABLE cm AS
            SELECT month, ix, iy, floor((ix + 0.5) * {GRID} / {TILE})::INT tx, floor((iy + 0.5) * {GRID} / {TILE})::INT ty,
                   modis, viirs FROM (
              SELECT month, floor(lon / {GRID})::INT ix, floor(lat / {GRID})::INT iy,
                     count(*) FILTER (WHERE sensor = 'MODIS') modis, count(*) FILTER (WHERE sensor = 'VIIRS') viirs
              FROM pts GROUP BY ALL)""")

        tm = con.execute("SELECT tx, ty, month, sum(modis) modis, sum(viirs) viirs FROM cm GROUP BY ALL").df()
        monthly = tm.groupby("month")[["modis", "viirs"]].sum().reindex(months, fill_value=0)
        # VIIRS takes over from its first COMPLETE month; a partial first month (S-NPP starts 2012-01-20)
        # stays k x MODIS and is left out of the fits.
        # shortcut: "complete" = first VIIRS detection falls on the 1st; in a sparse bbox this can start one month
        # late, which only matters if you harmonize a tiny area — upgrade to a sensor-start date if needed.
        v0, = con.execute("SELECT min(acq_date) FROM pts WHERE sensor = 'VIIRS'").fetchall()[0]
        viirs_start = (pd.Period(v0, "M") + (0 if v0.day == 1 else 1)).strftime("%Y-%m")
        fit_end = a.fit_end or months[-1]
        in_fit = lambda m: (m >= viirs_start) & (m <= fit_end)  # noqa: E731
        k_global, k_by, n_ov = fit_factors(monthly[in_fit(monthly.index)])
        tiles = fit_tiles(tm[in_fit(tm.month)], k_by, tm[["tx", "ty"]].drop_duplicates())
        gaps = detect_gaps(con.execute("SELECT sensor, acq_date d, count(*) n FROM pts GROUP BY ALL").df())
        nrt_months = con.execute("SELECT DISTINCT month, sensor FROM pts WHERE is_nrt").fetchall()
        notes, gap_months, prov_months = month_notes(months, viirs_start, gaps, nrt_months)
        # latest month covered by both sensors to its last day
        d_end, = con.execute("SELECT min(d) FROM (SELECT max(acq_date) d FROM pts GROUP BY sensor)").fetchall()[0]
        last_complete = (pd.Period(d_end, "M") - (0 if (d_end + datetime.timedelta(days=1)).day == 1 else 1)).strftime("%Y-%m")
        con.register("tiles_df", tiles)

        con.execute(f"""CREATE VIEW cells_k AS
            SELECT cm.month, round((iy + 0.5) * {GRID}, 4) lat, round((ix + 0.5) * {GRID}, 4) lon,
                   modis::BIGINT modis, viirs::BIGINT viirs, t.k,
                   CASE WHEN cm.month < '{viirs_start}' THEN modis * t.k ELSE viirs END::DOUBLE hotspots
            FROM cm JOIN tiles_df t ON t.tx = cm.tx AND t.ty = cm.ty AND t.cal = substr(cm.month, 6, 2)::INT""")

        cells_path, coarse_path, points_path = out / "cells.parquet", out / f"cells_{COARSE}.parquet", out / "points.parquet"
        con.execute(f"COPY (SELECT month, lat, lon, modis, viirs, hotspots FROM cells_k ORDER BY month, lat, lon) "
                    f"TO '{cells_path}' (FORMAT parquet, COMPRESSION zstd)")
        con.execute(f"""COPY (SELECT month, (floor(lat / {COARSE}) + 0.5) * {COARSE} lat, (floor(lon / {COARSE}) + 0.5) * {COARSE} lon,
                                     sum(modis)::BIGINT modis, sum(viirs)::BIGINT viirs, sum(hotspots) hotspots
                              FROM cells_k GROUP BY ALL ORDER BY month, lat, lon)
                        TO '{coarse_path}' (FORMAT parquet, COMPRESSION zstd)""")
        if points_path.is_dir():
            shutil.rmtree(points_path)
        elif points_path.exists():
            points_path.unlink()
        con.execute(f"""COPY (SELECT lat, lon, acq_date::TIMESTAMP acq_date, month, sensor, confidence, frp,
                                     year(acq_date) AS year FROM pts ORDER BY acq_date)
                        TO '{points_path}' (FORMAT parquet, PARTITION_BY (year), COMPRESSION zstd)""")

        r2_main = report(con, months, viirs_start, fit_end, gap_months, charts, a.region or "domain")
        for name, b in reports:
            report(con, months, viirs_start, fit_end, gap_months, charts, name, b)
        n_cells, = con.execute(f"SELECT count(*) FROM '{cells_path}'").fetchall()[0]
        n_coarse, = con.execute(f"SELECT count(*) FROM '{coarse_path}'").fetchall()[0]
    finally:
        con.close()
        shutil.rmtree(work, ignore_errors=True)

    n_fb = int(tiles.fallback.sum())
    meta = {
        "grid_deg": GRID,
        "coarse_grid_deg": COARSE,
        "first_month": months[0],
        "last_month": months[-1],
        "last_complete_month": min(last_complete, months[-1]),
        "viirs_start": viirs_start,
        "region": a.region,
        "factor_global": round(k_global, 4),
        "factor_by_month": {f"{m:02d}": round(k, 4) for m, k in k_by.items()},
        "tile_deg": TILE,
        "factor_by_tile": {
            f"{tx * TILE},{ty * TILE}": {
                "k": {f"{r.cal:02d}": round(r.k, 4) for r in g.itertuples()},
                "n": {f"{r.cal:02d}": int(r.n) for r in g.itertuples()},
            } for (tx, ty), g in tiles.groupby(["tx", "ty"])},
        "tile_months_fallback": n_fb,
        "r2_overlap": round(r2_main, 4),
        "fit_window": [viirs_start, fit_end],
        "data_gaps": gaps,
        "gap_months": gap_months,
        "provisional_months": prov_months,
        "month_notes": notes,
        "rows": stats,
        "method": (f"Hotspots gridded to {GRID}° cells. For each {TILE}°×{TILE}° tile and calendar month, VIIRS = k × MODIS "
                   f"is fitted by least squares through the origin on monthly counts over overlap months {viirs_start} to {fit_end}; tile-months "
                   f"with fewer than {MIN_OVERLAP} overlap months ({n_fb} of {len(tiles)}) use the domain-wide k for that "
                   f"calendar month. Before {viirs_start} hotspots = k × MODIS; from {viirs_start} hotspots = VIIRS."),
        "data_source": "synthetic_sample" if a.sample else "nasa_firms",
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2))

    print(f"\nMonths {months[0]} .. {months[-1]}  |  VIIRS from {viirs_start}  |  domain overlap months: {n_ov}")
    print(f"domain k global = {k_global:.3f}")
    print("domain k by month: " + "  ".join(f"{MONTHS[m-1]} {k:.2f}" for m, k in k_by.items()))
    print(f"tiles: {tiles[['tx', 'ty']].drop_duplicates().shape[0]}, tile-months on fallback: {n_fb}/{len(tiles)}")
    print(f"fit window: {viirs_start} .. {fit_end}")
    print(f"data gaps detected: {len(gaps)}; months noted:")
    for m, t in notes.items():
        print(f"  {m}: {t}")
    print(f"cells: {n_cells:,} rows  coarse {COARSE}° cells: {n_coarse:,} rows  points: "
          f"{sum(s['clean'] for s in stats.values()):,} rows -> {out}")
    return meta


if __name__ == "__main__":
    main()

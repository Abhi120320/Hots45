"""Fire intensity from Fire Radiative Power (FRP, MW) in the FIRMS points already written by fire_harmonize.py.

  python fire_intensity.py --report "Punjab-Haryana:73.8,28.4,77.6,32.6"

Adds to cells.parquet / cells_0.5.parquet: frp_modis, frp_viirs (sum of FRP over detections, MW), frp (harmonized
total), and per cell-month frp_p90_modis / frp_p90_viirs. Writes frp_tiles.parquet (tile x month x sensor: n, sum,
mean, p90) and meta.json "frp" (k_FRP per tile x calendar month, R², per-tile diagnostics).

Harmonization is the counts method applied to totals: VIIRS_FRP = k_FRP x MODIS_FRP per 10° tile and calendar month,
least squares through the origin on the count fit window, same fallbacks. Mean FRP per hotspot is NOT harmonized:
MODIS (1 km) and VIIRS (375 m) pixels see different fire sizes, so it is only reported per sensor.
"""
import argparse
import json
import os
import sys
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

import fire_harmonize as fh

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
UNRELIABLE_R2 = 0.6  # tile flagged when k_FRP x MODIS explains less than this share of VIIRS monthly variance
UNRELIABLE_CV = 0.2  # ...or when its yearly VIIRS/MODIS FRP ratio in the fit window varies by more than 20% (CV):
# then k_FRP x MODIS for any single pre-2012 year is uncertain by about that much, however good the monthly R²


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--app", default=str(ROOT / "backend" / "app_data"))
    ap.add_argument("--report", action="append", default=[], metavar="NAME:lon0,lat0,lon1,lat1")
    a = ap.parse_args(argv)
    app = Path(a.app)
    meta = json.loads((app / "meta.json").read_text())
    g, tile, vs = meta["grid_deg"], meta["tile_deg"], meta["viirs_start"]
    fit0, fit1 = meta.get("fit_window", [vs, meta["last_month"]])
    con = duckdb.connect()
    con.execute("SET memory_limit='4GB'; SET preserve_insertion_order=false")

    # cell x month x sensor: sum and p90 (cell centre exactly as fire_harmonize.py / cells.parquet). One year
    # partition at a time: exact percentiles hold every value of a group, and cell-months never cross a year.
    tile_sql = lambda c: f"floor(((floor({c} / {g}) + 0.5) * {g}) / {tile})::INT * {tile}"  # noqa: E731
    con.execute("CREATE TABLE cf (month VARCHAR, lat DOUBLE, lon DOUBLE, frp_modis DOUBLE, frp_viirs DOUBLE, frp_p90_modis DOUBLE, frp_p90_viirs DOUBLE)")
    con.execute("CREATE TABLE ts (tile_lon INT, tile_lat INT, month VARCHAR, sensor VARCHAR, n BIGINT, frp_sum DOUBLE, frp_mean DOUBLE, frp_p90 DOUBLE)")
    for d in sorted((app / "points.parquet").glob("year=*")):
        src = f"read_parquet('{d}/*.parquet')"
        con.execute(f"""INSERT INTO cf
            SELECT month, round((floor(lat / {g}) + 0.5) * {g}, 4), round((floor(lon / {g}) + 0.5) * {g}, 4),
                   coalesce(sum(frp) FILTER (WHERE sensor = 'MODIS'), 0), coalesce(sum(frp) FILTER (WHERE sensor = 'VIIRS'), 0),
                   quantile_cont(frp, 0.9) FILTER (WHERE sensor = 'MODIS'), quantile_cont(frp, 0.9) FILTER (WHERE sensor = 'VIIRS')
            FROM {src} WHERE frp IS NOT NULL GROUP BY ALL""")
        con.execute(f"""INSERT INTO ts SELECT {tile_sql('lon')}, {tile_sql('lat')}, month, sensor, count(*), sum(frp), avg(frp), quantile_cont(frp, 0.9)
                        FROM {src} WHERE frp IS NOT NULL GROUP BY ALL""")
        print(d.name, end=" ", flush=True)
    print()
    con.execute(f"COPY (SELECT * FROM ts ORDER BY ALL) TO '{app}/frp_tiles.parquet' (FORMAT parquet, COMPRESSION zstd)")
    tm = con.execute(f"""SELECT (tile_lon / {tile})::INT tx, (tile_lat / {tile})::INT ty, month,
                                coalesce(sum(frp_sum) FILTER (WHERE sensor = 'MODIS'), 0) modis,
                                coalesce(sum(frp_sum) FILTER (WHERE sensor = 'VIIRS'), 0) viirs
                         FROM '{app}/frp_tiles.parquet' GROUP BY ALL""").df()

    in_fit = (tm.month >= fit0) & (tm.month <= fit1)
    monthly = tm.groupby("month")[["modis", "viirs"]].sum()
    k_global, k_by, n_ov = fh.fit_factors(monthly[(monthly.index >= fit0) & (monthly.index <= fit1)])
    tiles = fh.fit_tiles(tm[in_fit], k_by, tm[["tx", "ty"]].drop_duplicates())
    con.register("tiles_df", tiles)

    cells = app / "cells.parquet"
    import pyarrow.parquet as pq
    old = [c for c in pq.ParquetFile(cells).schema_arrow.names if not c.startswith("frp")]
    con.execute(f"""COPY (SELECT {', '.join('c.' + x for x in old)},
                                 coalesce(f.frp_modis, 0)::DOUBLE frp_modis, coalesce(f.frp_viirs, 0)::DOUBLE frp_viirs,
                                 CASE WHEN c.month < '{vs}' THEN coalesce(f.frp_modis, 0) * t.k ELSE coalesce(f.frp_viirs, 0) END::DOUBLE frp,
                                 f.frp_p90_modis, f.frp_p90_viirs
                          FROM read_parquet('{cells}') c LEFT JOIN cf f USING (month, lat, lon)
                          JOIN tiles_df t ON t.tx = floor(c.lon / {tile})::INT AND t.ty = floor(c.lat / {tile})::INT
                                         AND t.cal = substr(c.month, 6, 2)::INT
                          ORDER BY c.month, c.lat, c.lon)
                    TO '{app}/cells.tmp.parquet' (FORMAT parquet, COMPRESSION zstd)""")
    n_old, = con.execute(f"SELECT count(*) FROM read_parquet('{cells}')").fetchall()[0]
    n_new, got, want = con.execute(f"""SELECT count(*), sum(frp_modis + frp_viirs), (SELECT sum(frp_modis + frp_viirs) FROM cf)
                                       FROM '{app}/cells.tmp.parquet'""").fetchall()[0]
    lost = (want or 0) - (got or 0)
    if n_new != n_old or abs(lost) > 1e-6 * max(1.0, want or 0):
        sys.exit(f"cells/points out of sync ({n_old} vs {n_new} rows, {lost:.1f} MW unmatched) — cells.parquet left unchanged")
    os.replace(app / "cells.tmp.parquet", cells)
    coarse = meta.get("coarse_grid_deg")
    if coarse:
        cols = [c for c in pq.ParquetFile(app / f"cells_{coarse}.parquet").schema_arrow.names if c not in ("month", "lat", "lon") and not c.startswith("frp")]
        con.execute(f"""COPY (SELECT month, (floor(lat / {coarse}) + 0.5) * {coarse} lat, (floor(lon / {coarse}) + 0.5) * {coarse} lon,
                                     {', '.join(f'sum({x})' + ('::BIGINT' if x in ('modis', 'viirs') else '') + f' {x}' for x in cols)},
                                     sum(frp_modis) frp_modis, sum(frp_viirs) frp_viirs, sum(frp) frp
                              FROM read_parquet('{cells}') GROUP BY ALL ORDER BY month, lat, lon)
                        TO '{app}/cells_{coarse}.parquet' (FORMAT parquet, COMPRESSION zstd)""")

    # ---------- diagnostics ----------
    tmk = tm.assign(cal=tm.month.str[5:7].astype(int)).merge(tiles[["tx", "ty", "cal", "k"]], on=["tx", "ty", "cal"])
    tmk["pred"] = tmk.modis * tmk.k
    ov = tmk[(tmk.modis > 0) & (tmk.viirs > 0) & (tmk.month >= vs)]
    share_all = tm[tm.month >= vs].groupby(["tx", "ty"]).viirs.sum() / tm[tm.month >= vs].viirs.sum()
    diag = []
    for (tx, ty), d in ov.groupby(["tx", "ty"]):
        f, af = d[d.month <= fit1], d[d.month > fit1]
        r = fh.r2(f.pred, f.viirs) if len(f) > 2 else float("nan")
        bias = f.pred.sum() / f.viirs.sum() - 1 if f.viirs.sum() else float("nan")
        bias_after = af.pred.sum() / af.viirs.sum() - 1 if af.viirs.sum() else float("nan")
        share = float(share_all.get((tx, ty), 0))
        yr = f.groupby(f.month.str[:4])[["modis", "viirs"]].sum()
        ratio = yr.viirs / yr.modis
        cv = float(ratio.std(ddof=0) / ratio.mean()) if len(ratio) > 2 else float("nan")
        flag = share >= 0.005 and (not r >= UNRELIABLE_R2 or not cv <= UNRELIABLE_CV)
        diag.append({"tile": f"{tx * tile},{ty * tile}", "share_of_viirs_frp": round(share, 4), "r2": round(r, 3) if np.isfinite(r) else None,
                     "bias_fit": round(bias, 3) if np.isfinite(bias) else None,
                     "bias_after": round(bias_after, 3) if np.isfinite(bias_after) else None,
                     "yearly_ratio_cv": round(cv, 3) if np.isfinite(cv) else None,
                     "yearly_ratio_range": [round(float(ratio.min()), 2), round(float(ratio.max()), 2)] if len(ratio) else None,
                     "unreliable": bool(flag)})
    diag.sort(key=lambda x: -x["share_of_viirs_frp"])

    def region(name, bbox=None):
        w, p = ("TRUE", []) if not bbox else ("lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?", [bbox[0], bbox[2], bbox[1], bbox[3]])
        m = con.execute(f"""SELECT c.month, sum(frp_modis) modis, sum(frp_viirs) viirs, sum(frp_modis * t.k) pred, sum(c.modis) n_m, sum(c.viirs) n_v
                            FROM read_parquet('{cells}') c JOIN tiles_df t ON t.tx = floor(c.lon / {tile})::INT AND t.ty = floor(c.lat / {tile})::INT
                                AND t.cal = substr(c.month, 6, 2)::INT WHERE {w} GROUP BY 1""", p).df().set_index("month").sort_index()
        o = m[(m.modis > 0) & (m.viirs > 0) & (m.index >= vs)]
        f, af = o[o.index <= fit1], o[o.index > fit1]
        out = {"r2_fit": fh.r2(f.pred, f.viirs), "r2_after": fh.r2(af.pred, af.viirs) if len(af) > 1 else float("nan"),
               "bias_fit": f.pred.sum() / f.viirs.sum() - 1, "bias_after": af.pred.sum() / af.viirs.sum() - 1 if len(af) else float("nan"),
               "k_effective": f.viirs.sum() / f.modis.sum(),
               "mean_frp_modis": f.modis.sum() / f.n_m.sum(), "mean_frp_viirs": f.viirs.sum() / f.n_v.sum()}
        yr = o.groupby(o.index.str[:4])[["modis", "viirs"]].sum()
        out["ratio_by_year"] = (yr.viirs / yr.modis).round(2).to_dict()
        fy = yr[(yr.index >= fit0[:4]) & (yr.index <= fit1[:4])]
        out["yearly_ratio_cv"] = float((fy.viirs / fy.modis).std(ddof=0) / (fy.viirs / fy.modis).mean())
        print(f"\n[{name}] FRP fit {fit0}..{fit1}: R² {out['r2_fit']:.3f}, bias {out['bias_fit']:+.1%} | after: R² {out['r2_after']:.3f}, "
              f"bias {out['bias_after']:+.1%} | effective k_FRP {out['k_effective']:.2f}, yearly-ratio CV {out['yearly_ratio_cv']:.2f}")
        print(f"  mean FRP per hotspot (fit window, NOT harmonized): MODIS {out['mean_frp_modis']:.1f} MW, VIIRS {out['mean_frp_viirs']:.1f} MW")
        print("  VIIRS/MODIS FRP ratio by year: " + "  ".join(f"{y} {v}" for y, v in out["ratio_by_year"].items()))
        return out

    regions = {"Asia" if not meta.get("region") else meta["region"]: region(meta.get("region") or "domain")}
    for r in a.report:
        name, _, b = r.rpartition(":")
        regions[name] = region(name, [float(x) for x in b.split(",")])

    n_fb = int(tiles.fallback.sum())
    meta["frp"] = {
        "unit": "MW",
        "factor_global": round(k_global, 4),
        "factor_by_month": {f"{m:02d}": round(k, 4) for m, k in k_by.items()},
        "factor_by_tile": {f"{tx * tile},{ty * tile}": {"k": {f"{r.cal:02d}": round(r.k, 4) for r in d.itertuples()},
                                                        "n": {f"{r.cal:02d}": int(r.n) for r in d.itertuples()}}
                           for (tx, ty), d in tiles.groupby(["tx", "ty"])},
        "tile_months_fallback": n_fb,
        "fit_window": [fit0, fit1],
        "r2_overlap": round(regions[next(iter(regions))]["r2_fit"], 4),
        "regions": {k: {kk: (round(vv, 4) if isinstance(vv, float) and np.isfinite(vv) else vv if not isinstance(vv, float) else None)
                        for kk, vv in v.items()} for k, v in regions.items()},
        "tiles": diag,
        "method": (f"Fire Radiative Power (FRP, MW) is the radiant power of each detection. Total FRP = sum over detections; harmonized "
                   f"like counts: for each {tile}°×{tile}° tile and calendar month, VIIRS_FRP = k_FRP × MODIS_FRP is fitted through the "
                   f"origin on monthly totals {fit0} to {fit1} ({n_fb} of {len(tiles)} tile-months fall back to the domain k for that "
                   f"month); before {vs} total FRP = k_FRP × MODIS, from {vs} VIIRS. Mean and 90th-percentile FRP per hotspot are "
                   f"not harmonized: VIIRS (375 m) detects many small fires MODIS (1 km) misses, so its per-hotspot FRP is lower."),
    }
    (app / "meta.json").write_text(json.dumps(meta, indent=2, allow_nan=False))
    print(f"\nk_FRP global {k_global:.3f} (overlap months {n_ov}); by month: " + "  ".join(f"{fh.MONTHS[m - 1]} {k:.2f}" for m, k in k_by.items()))
    print(f"tile-months on fallback: {n_fb}/{len(tiles)}")
    bad = [d for d in diag if d["unreliable"]]
    print(f"tiles with >=0.5% of VIIRS FRP flagged unreliable (R² < {UNRELIABLE_R2} or yearly-ratio CV > {UNRELIABLE_CV}): {len(bad)}")
    for d in diag[:25]:
        print(f"  tile {d['tile']:>7}  share {d['share_of_viirs_frp']:6.1%}  R² {d['r2']}  yearly ratio {d['yearly_ratio_range']} CV {d['yearly_ratio_cv']}"
              f"  bias after {fit1} {d['bias_after']}{'  UNRELIABLE' if d['unreliable'] else ''}")
    return meta


if __name__ == "__main__":
    main()

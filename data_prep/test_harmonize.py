import json
import math

import duckdb
import pandas as pd

import fire_harmonize as fh
import make_sample_data as msd

HDR = "latitude,longitude,acq_date,acq_time,satellite,confidence,frp"


def run(tmp_path, modis, viirs, *extra):
    return fh.main(["--modis", str(modis), "--viirs", str(viirs), "--out", str(tmp_path / "app"),
                    "--charts", str(tmp_path), *extra])


def test_recovers_factor_and_contract(tmp_path):
    msd.main(out=tmp_path / "s")
    meta = run(tmp_path, tmp_path / "s/modis*.csv", tmp_path / "s/viirs*.csv", "--sample")
    assert abs(meta["factor_global"] - msd.TRUE_K) < 0.4
    assert meta["data_source"] == "synthetic_sample"
    vs = meta["viirs_start"]
    assert vs in ("2012-01", "2012-02") and meta["first_month"] == "2008-01"
    cells = pd.read_parquet(tmp_path / "app/cells.parquet")
    assert list(cells.columns) == ["month", "lat", "lon", "modis", "viirs", "hotspots"]
    pre = cells[cells.month < vs]
    tile = (pre.lon // 10 * 10).astype(int).astype(str) + "," + (pre.lat // 10 * 10).astype(int).astype(str)
    k = [meta["factor_by_tile"][t]["k"][m[5:7]] for t, m in zip(tile, pre.month)]
    assert ((pre.hotspots - pre.modis * k).abs() <= 1e-4 * pre.modis).all()  # meta k rounded to 4 dp
    for t in meta["factor_by_tile"].values():  # each tile has 4 overlap years -> its own fit near TRUE_K
        assert all(abs(v - msd.TRUE_K) < 1.0 for v in t["k"].values())
    post = cells[cells.month >= vs]
    assert (post.hotspots == post.viirs).all()
    coarse = pd.read_parquet(tmp_path / "app/cells_0.5.parquet")
    assert math.isclose(coarse.hotspots.sum(), cells.hotspots.sum()) and coarse.modis.sum() == cells.modis.sum()
    n_pts = duckdb.execute(f"SELECT count(*) FROM read_parquet('{tmp_path}/app/points.parquet/*/*.parquet', "
                       f"hive_partitioning=true)").fetchall()[0][0]
    assert n_pts == sum(s["clean"] for s in meta["rows"].values())
    assert json.loads((tmp_path / "app/meta.json").read_text())["grid_deg"] == 0.05


def test_clean_dedup_and_start(tmp_path):
    d = tmp_path / "d"
    d.mkdir()
    (d / "fire_archive_M-C61_1.csv").write_text(f"{HDR},type\n"
        "30,75,2020-01-01,0100,Terra,29,5,0\n"       # conf < 30: drop
        "30,75,2020-01-01,0200,Terra,30,5,0\n"       # keep
        "30,75,2020-01-01,0300,Terra,80,5,2\n"       # type 2: drop
        "30,75,2019-12-31,0300,Terra,80,5,0\n")      # before --start: drop
    (d / "fire_archive_M-C61_2.csv").write_text(f"{HDR},type\n30,75,2020-01-01,0200,Terra,30,5,0\n")  # dup of archive
    (d / "fire_nrt_M-C61_3.csv").write_text(f"{HDR}\n"  # NRT has no `type` column
        "30,75,2020-01-01,0200,Terra,90,7\n"          # dup of archive: archive copy kept
        "30,75,2020-01-02,0200,Aqua,80,5\n")          # new: keep
    (d / "fire_archive_SV-C2_1.csv").write_text(f"{HDR},type\n"
        "30,75,2020-01-01,0100,N,l,1,0\n30,75,2020-01-01,0200,N,n,1,0\n30,75,2020-01-01,0300,N,h,1,0\n")
    (d / "fire_nrt_SV-C2_2.csv").write_text(f"{HDR}\n"
        "30.001,75.001,2020-01-01,0301,N,h,1\n"      # inside archive dates, not an exact dup: dropped
        "30,75,2020-01-02,0200,N,n,1\n"              # after archive end: keep
        "30,75,2020-02-01,0200,N,n,1\n")             # after --end: drop
    meta = run(tmp_path, d / "fire_*_M-C61_*.csv", d / "fire_*_SV-C2_*.csv", "--start", "2020-01", "--end", "2020-01")
    assert meta["rows"]["MODIS"] == {"raw": 6, "nrt_overlap": 1, "duplicates": 1, "clean": 2}
    assert meta["rows"]["VIIRS"] == {"raw": 5, "nrt_overlap": 1, "duplicates": 0, "clean": 3}
    assert meta["last_month"] == "2020-01" and meta["last_complete_month"] == "2019-12"  # data stops 2020-01-02
    pts = duckdb.sql(f"SELECT * FROM read_parquet('{tmp_path}/app/points.parquet/*/*.parquet')").df()
    assert sorted(pts[pts.sensor == "MODIS"].confidence) == ["30", "80"]  # archive copy (30), not NRT (90)
    assert meta["first_month"] == "2020-01" and meta["data_source"] == "nasa_firms"


def test_anomalies_zscore():
    s = pd.Series([10, 10, 10, 10, 10, 100], index=[f"{y}-01" for y in range(2001, 2007)], dtype=float)
    an = fh.anomalies(s)
    assert an.loc["2006-01", "flag"] == "unusually high"  # z = 2.24
    assert an.loc["2001-01", "hist_median"] == 10


def test_partial_first_viirs_month_stays_modis(tmp_path):
    msd.main(out=tmp_path / "s")
    for f in (tmp_path / "s").glob("viirs_2012.csv"):  # make VIIRS start mid-month, like S-NPP on 2012-01-20
        df = pd.read_csv(f)
        df[~((df.acq_date < "2012-01-20"))].to_csv(f, index=False)
    meta = run(tmp_path, tmp_path / "s/modis*.csv", tmp_path / "s/viirs*.csv")
    assert meta["viirs_start"] == "2012-02"
    cells = pd.read_parquet(tmp_path / "app/cells.parquet")
    jan = cells[cells.month == "2012-01"]
    assert jan.viirs.sum() > 0 and (jan.hotspots != jan.viirs).any()  # Jan 2012 = k x MODIS, not partial VIIRS


def test_gap_detection_and_notes():
    days = pd.date_range("2020-01-01", "2020-03-31")
    n = pd.Series(1000, index=days)
    n["2020-02-03":"2020-02-05"] = 0
    n["2020-02-06"] = 50  # partial day (5%)
    daily = pd.DataFrame({"sensor": "VIIRS", "d": n.index.date, "n": n.values})
    gaps = fh.detect_gaps(daily)
    assert gaps == [{"sensor": "VIIRS", "start": "2020-02-03", "end": "2020-02-06"}]
    months = ["2020-01", "2020-02", "2020-03"]
    notes, gap_months, prov = fh.month_notes(months, "2019-01", gaps, [("2020-03", "VIIRS"), ("2020-01", "MODIS")])
    assert notes == {"2020-02": "VIIRS data gap (3–6 Feb)", "2020-03": "provisional (NRT data)"}
    assert gap_months == ["2020-02"] and prov == ["2020-03"]  # MODIS NRT ignored: VIIRS is in use in 2020
    # a MODIS gap before viirs_start is the one that matters there
    _, gm, _ = fh.month_notes(months, "2021-01", gaps, [])
    assert gm == []


def test_gap_month_never_flagged():
    s = pd.Series([10, 10, 10, 10, 10, 100], index=[f"{y}-01" for y in range(2001, 2007)], dtype=float)
    assert fh.anomalies(s, exclude=["2006-01"]).loc["2006-01", "flag"] == ""


def test_fit_end_limits_fit_window(tmp_path):
    msd.main(out=tmp_path / "s")
    meta = run(tmp_path, tmp_path / "s/modis*.csv", tmp_path / "s/viirs*.csv", "--fit-end", "2013-12")
    assert meta["fit_window"][1] == "2013-12"
    # 2 overlap years per calendar month < MIN_OVERLAP -> every tile-month falls back to the domain k
    assert meta["tile_months_fallback"] == sum(len(t["k"]) for t in meta["factor_by_tile"].values())

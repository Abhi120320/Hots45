import json

import duckdb
import numpy as np
import pandas as pd
import tifffile

import fire_harmonize as fh
import land_cover as lc
import make_sample_data as msd

X0, Y0, D = 70.0, 35.0, 0.05  # synthetic geographic map: 70-95E, 15-35N


def write_map(path, arr):
    tifffile.imwrite(path, arr, extratags=[(33550, "d", 3, (D, D, 0.0)), (33922, "d", 6, (0, 0, 0, X0, Y0, 0))])


def test_label_points_and_cells(tmp_path):
    msd.main(out=tmp_path / "s")
    fh.main(["--modis", str(tmp_path / "s/modis*.csv"), "--viirs", str(tmp_path / "s/viirs*.csv"),
             "--out", str(tmp_path / "app"), "--charts", str(tmp_path), "--sample"])
    arr = np.full((400, 500), 10, np.uint8)  # grassland east of 85E
    arr[:, :140] = 12  # cropland west of 77E
    arr[:, 140:300] = 2  # forest 77-85E
    arr[90:100, :] = 255  # fill band 30.5-30.0N (a sample site): unknown
    d = tmp_path / "lc"
    d.mkdir()
    write_map(d / f"MCD12Q1.061_{lc.LAYER}_doy2010001_aid0001.tif", arr)
    write_map(d / f"MCD12Q1.061_{lc.LAYER}_doy2013001_aid0001.tif", np.full_like(arr, 11))  # all wetland
    app = tmp_path / "app"
    for _ in range(2):  # re-running must give the same result
        lc.main(["label", "--app", str(app), "--lc-dir", str(d)])

    pts = duckdb.sql(f"SELECT lon, lat, year, land_cover, lc_group FROM read_parquet('{app}/points.parquet/*/*.parquet', "
                     f"hive_partitioning=true)").df()
    early = pts[pts.year <= 2013]  # 2008-2011 clamp to the 2010 map; 2012-2013 use the latest map before them (2010)
    exp = np.where(early.lon < 77, 12, np.where(early.lon < 85, 2, 10))
    known = ~early.lat.between(30.0, 30.5, inclusive="left")
    assert (early.land_cover[known] == exp[known]).all()
    assert set(early.lc_group[known]) == {"crop", "forest", "grass"}
    assert (pts[pts.year >= 2014].land_cover == 11).all()  # previous-year rule: 2014 -> 2013 map
    assert pts.lc_group.notna().all() and (pts[pts.land_cover.isna()].lc_group == "other").all() and pts.land_cover.isna().any()

    cells = pd.read_parquet(app / "cells.parquet")
    groups = cells[[f"lc_{k}" for k in lc.KEYS]]
    assert np.allclose(groups.sum(axis=1), cells.hotspots)
    west = cells[(cells.lon < 76.5) & (cells.month < "2014") & ~cells.lat.between(30.0, 30.5)]
    assert len(west) and np.allclose(west.lc_crop, west.hotspots)
    coarse = pd.read_parquet(app / "cells_0.5.parquet")
    assert np.isclose(coarse.lc_forest.sum(), cells.lc_forest.sum()) and np.isclose(coarse.hotspots.sum(), cells.hotspots.sum())
    meta = json.loads((app / "meta.json").read_text())
    assert meta["land_cover"]["map_years"] == [2010, 2013] and [g["key"] for g in meta["land_cover"]["groups"]] == lc.KEYS


def test_lookup_and_groups():
    arr = np.array([[1, 12], [14, 255]], np.uint8)
    gt = (0.0, 2.0, 1.0, 1.0)
    out = lc.lookup(arr, gt, np.array([0.5, 1.5, 0.5, 1.5, 5.0]), np.array([1.5, 1.5, 0.5, 0.5, 0.5]))
    assert out.tolist() == [1, 12, 14, 255, 255]
    assert [lc.KEYS[g] for g in lc.GROUP_OF[out]] == ["forest", "crop", "crop", "other", "other"]
    assert lc.map_year(2003, {2002: 0, 2003: 0}) == 2002 and lc.map_year(2001, {2002: 0}) == 2002

import numpy as np
import pandas as pd

import fire_harmonize as fh
import fire_intensity as fi
import make_sample_data as msd


def test_frp_harmonized_like_counts(tmp_path):
    msd.main(out=tmp_path / "s")
    fh.main(["--modis", str(tmp_path / "s/modis*.csv"), "--viirs", str(tmp_path / "s/viirs*.csv"),
             "--out", str(tmp_path / "app"), "--charts", str(tmp_path), "--sample"])
    app = tmp_path / "app"
    before = pd.read_parquet(app / "cells.parquet")
    for _ in range(2):  # re-runnable
        meta = fi.main(["--app", str(app), "--report", "P:74,29,77,32"])["frp"]
    assert abs(meta["factor_global"] - msd.TRUE_K) < 0.6  # same FRP distribution per sensor, 4x the VIIRS detections
    cells = pd.read_parquet(app / "cells.parquet")
    assert len(cells) == len(before) and np.allclose(cells.hotspots, before.hotspots)  # counts untouched
    vs = "2012-01"
    post, pre = cells[cells.month >= "2012-02"], cells[cells.month < vs]
    assert np.allclose(post.frp, post.frp_viirs)
    tile = (pre.lon // 10 * 10).astype(int).astype(str) + "," + (pre.lat // 10 * 10).astype(int).astype(str)
    k = np.array([meta["factor_by_tile"][t]["k"][m[5:7]] for t, m in zip(tile, pre.month)])
    assert np.allclose(pre.frp, pre.frp_modis * k, rtol=1e-3)  # meta k rounded to 4 dp
    pts = pd.read_parquet(app / "points.parquet")
    assert np.isclose(cells.frp_modis.sum() + cells.frp_viirs.sum(), pts.frp.sum())
    assert (cells.frp_p90_modis.dropna() >= 0).all() and cells.frp_p90_viirs.notna().any()
    coarse = pd.read_parquet(app / "cells_0.5.parquet")
    assert np.isclose(coarse.frp.sum(), cells.frp.sum()) and np.isclose(coarse.hotspots.sum(), cells.hotspots.sum())
    t = pd.read_parquet(app / "frp_tiles.parquet")
    assert set(t.columns) >= {"tile_lon", "tile_lat", "month", "sensor", "n", "frp_sum", "frp_mean", "frp_p90"}
    assert meta["regions"]["P"]["r2_fit"] is not None and meta["tiles"]


def test_land_cover_label_keeps_frp_columns(tmp_path):
    import land_cover as lc
    from test_land_cover import write_map
    msd.main(out=tmp_path / "s")
    fh.main(["--modis", str(tmp_path / "s/modis*.csv"), "--viirs", str(tmp_path / "s/viirs*.csv"),
             "--out", str(tmp_path / "app"), "--charts", str(tmp_path), "--sample"])
    fi.main(["--app", str(tmp_path / "app")])
    (tmp_path / "lc").mkdir()
    write_map(tmp_path / "lc" / f"x_{lc.LAYER}_doy2010001.tif", np.full((400, 500), 12, np.uint8))
    lc.main(["label", "--app", str(tmp_path / "app"), "--lc-dir", str(tmp_path / "lc")])
    for f in ("cells.parquet", "cells_0.5.parquet"):
        c = pd.read_parquet(tmp_path / "app" / f)
        assert {"frp", "frp_modis", "lc_crop"} <= set(c.columns), f

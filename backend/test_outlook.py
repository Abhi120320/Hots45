import numpy as np
import pandas as pd

from backend import outlook as ol

SEASON = np.array([1, 1, 2, 4, 3, 1, 0.5, 0.5, 1, 6, 8, 2])


def monthly(first="2003-01", last="2026-10", growth=0.0, noise=0.0, seed=1):
    idx = pd.period_range(first, last, freq="M")
    rng = np.random.default_rng(seed)
    v = [100 * SEASON[p.month - 1] * (1 + growth) ** (p.year - 2003) * (1 + noise * rng.standard_normal()) for p in idx]
    return pd.Series(np.maximum(v, 0), index=idx.strftime("%Y-%m"))


def test_sen_slope_and_mann_kendall():
    assert ol.sen_slope([1, 3, 5, 7, 100]) == 2.0  # robust to the outlier
    assert ol.mann_kendall_p(np.arange(10.0)) < 0.001
    assert ol.mann_kendall_p([5, 3, 6, 2, 7, 4, 5, 3, 6, 4]) > 0.3
    assert ol.mann_kendall_p([1, 1, 1, 1, 1]) == 1.0


def test_backtest_and_outlook_never_see_the_future():
    s = monthly(noise=0.3)
    cut = "2019-06"
    bad = s.copy()
    bad[bad.index > cut] *= 50  # corrupt everything after the cutoff
    a, b = ol.backtest(s, "2012-02"), ol.backtest(bad, "2012-02")
    keys = ["h", "cutoff", "target", "w", "m_pred", "m_lo", "m_hi", "r_pred", "r_lo", "r_hi"]
    ka, kb = a[a.cutoff <= cut][keys].reset_index(drop=True), b[b.cutoff <= cut][keys].reset_index(drop=True)
    assert len(ka) > 100
    pd.testing.assert_frame_equal(ka, kb)  # every forecast made at or before the cutoff is unchanged
    oa, ob = ol.outlook(s, cut, "2012-02"), ol.outlook(bad, cut, "2012-02")
    assert oa["months"] == ob["months"] and [m["month"] for m in oa["months"]] == ["2019-07", "2019-08", "2019-09"]


def test_persistence_weight_learned_from_past_only():
    s = monthly(noise=0.2)
    bt = ol.backtest(s, "2012-02")
    first = bt[bt.h == 1].iloc[0]
    # Jan 2015 has only 2 VIIRS-era Januaries (2013, 2014) < MIN_YEARS, so the first target is Feb 2015
    assert first.target == "2015-02" and first.cutoff == "2015-01"
    assert set(bt.w) <= set(ol.WEIGHTS)


def test_trend_applied_only_when_significant():
    up = ol.components(monthly(growth=0.15), "2020-12", "2021-01", "2012-02")
    flat = ol.components(monthly(noise=0.3, seed=3), "2020-12", "2021-01", "2012-02")
    assert up["trend"]["applied"] and up["trend"]["p"] < 0.05 and up["trend"]["factor"] > 1
    assert not flat["trend"]["applied"] and flat["trend"]["factor"] == 1.0


def test_perfect_season_is_forecast_exactly():
    s = monthly()
    o = ol.outlook(s, "2026-10", "2012-02")
    nov = o["months"][0]
    assert nov["month"] == "2026-11" and abs(nov["pred"] - 800) < 1e-6 and nov["lo"] <= nov["pred"] <= nov["hi"]
    assert o["backtest"]["mae_model"] < 1e-6 and o["backtest"]["coverage_model"] == 100
    assert "not an official forecast" in o["disclaimer"]


def test_falls_back_to_reference_when_model_does_not_beat_it():
    s = monthly(noise=0.2)
    bt = ol.backtest(s, "2012-02")
    bt["m_pred"] = bt.actual * 3  # make the model terrible
    o = ol.outlook(s, "2026-10", "2012-02", bt=bt)
    assert o["using"] == "reference" and o["months"][0]["weight"] is None and o["months"][0]["using"] == "reference"
    ref = ol.reference(s, "2026-10", "2026-11")
    assert o["months"][0]["pred"] == round(ref["pred"], 1)


def test_probability_and_label():
    assert ol.p_above(200, 150, 260, 100) > 0.9
    assert ol.p_above(50, 30, 70, 100) < 0.1
    assert abs(ol.p_above(100, 50, 200, 100) - 0.5) < 0.01
    assert ol.label(0.7) == "likely above normal (60–80% chance)"
    assert ol.label(0.1) == "very likely below normal (over 80% chance)"
    assert ol.label(0.55).startswith("near normal")


def test_season_dates():
    days = pd.date_range("2012-01-01", "2026-10-31")
    doy = days.dayofyear.to_numpy()
    v = np.where((doy >= 290) & (doy <= 330), 100.0, 0.0)  # mid-Oct to late Nov, peak in the middle
    v = v * (1 + 0.5 * np.exp(-((doy - 309) / 6.0) ** 2))
    sd = ol.season_dates(pd.Series(v, index=days), pd.Timestamp("2026-10-31"), 2012)
    assert sd["start"]["date"][:7] == "2026-10" and sd["end"]["date"][:7] == "2026-11"
    assert sd["peak"]["date"][:7] == "2026-11" and sd["underway"] and sd["years"] >= 10

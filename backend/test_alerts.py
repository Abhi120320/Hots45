import numpy as np
import pandas as pd

from backend import alerts as A

days = pd.date_range("2003-01-01", "2024-12-31")


def series(fn):
    return pd.Series([float(fn(d)) for d in days], index=days)


def test_unusual_ratio_and_percentiles():
    s = series(lambda d: 10)  # 70 per week every year
    s["2021-11-01":"2021-11-07"] = 30  # 210 = 3x median -> Warning
    a = A.unusual(s, pd.Timestamp("2021-11-07"))
    assert a["severity"] == "Warning" and a["ratio"] == 3.0 and a["hotspots"] == 210
    assert A.unusual(series(lambda d: 10), pd.Timestamp("2021-11-07")) is None  # normal week: no alert
    assert A.unusual(series(lambda d: 1), pd.Timestamp("2021-11-07")) is None  # < 20 hotspots: no noise alerts


def test_season_start_peak_end():
    s = series(lambda d: 100 if 300 <= d.dayofyear <= 330 else 0)  # season = days 300..330
    st = A.season_stats(s, pd.Timestamp("2024-10-01"))
    assert 300 <= st["start"] <= 305 and 313 <= st["peak"] <= 317 and 326 <= st["end"] <= 330
    info = A.season(s, pd.Timestamp("2023-10-20"))  # day 293: start within 14 days
    assert info["severity"] == "Info"


def test_gap_downgrade_and_provisional():
    s = series(lambda d: 10)
    s["2021-11-01":"2021-11-07"] = 30
    a = A.evaluate(s, "2021-11-07", gaps=[("2021-11-03", "2021-11-04")], provisional=["2021-11"])
    u = next(x for x in a if x["kind"] == "unusual")
    assert u["severity"] == "Watch" and "down-graded" in u["message"] and u["provisional"]


def test_simulated_date_never_sees_future_data():
    s = series(lambda d: 10)
    s["2021-11-08":"2021-11-30"] = 10_000  # huge fires AFTER the simulated date
    assert [a for a in A.evaluate(s, "2021-11-07") if a["kind"] in ("unusual", "record")] == []
    assert any(a["kind"] == "record" for a in A.evaluate(s, "2021-11-30"))

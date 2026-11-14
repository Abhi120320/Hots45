"""API checks on a tiny hand-made dataset (run from repo root: pytest backend)."""
import csv
import io
import json
import os
import tempfile
from pathlib import Path

import pandas as pd

tmp = Path(tempfile.mkdtemp())
cells = [{"month": f"{y}-01", "lat": 30.025, "lon": 75.025, "modis": 2, "viirs": 0 if y < 2004 else 10,
          "hotspots": 10.0 if y < 2006 else 100.0} for y in range(2001, 2007)]
cells.append({"month": "2003-06", "lat": 20.025, "lon": 80.025, "modis": 5, "viirs": 0, "hotspots": 50.0})
cells.append({"month": "2003-06", "lat": 20.075, "lon": 80.075, "modis": 1, "viirs": 0, "hotspots": 10.0})
pd.DataFrame(cells).to_parquet(tmp / "cells.parquet", index=False)
pd.DataFrame({"lat": [30.01, 20.02], "lon": [75.01, 80.02],
              "acq_date": pd.to_datetime(["2006-01-05", "2003-06-10"]), "month": ["2006-01", "2003-06"],
              "sensor": ["VIIRS", "MODIS"], "confidence": ["n", "80"], "frp": [3.5, 9.1]}
             ).to_parquet(tmp / "points.parquet", index=False)
(tmp / "meta.json").write_text(json.dumps({"grid_deg": 0.05, "first_month": "2001-01", "last_month": "2006-12",
                                           "last_complete_month": "2006-11", "viirs_start": "2004-01",
                                           "data_source": "synthetic_sample", "factor_global": 3.0,
                                           "factor_by_month": {"06": 2.0}, "tile_deg": 10,
                                           "factor_by_tile": {"70,30": {"k": {"01": 5.0}, "n": {"01": 3}}},
                                           "gap_months": ["2005-01"],
                                           "month_notes": {"2005-01": "VIIRS data gap (3–6 Jan)", "2006-12": "provisional (NRT data)"}}))
import shapely  # noqa: E402

# tiny boundary set: India (country) > Punjab (state) > Ludhiana (district) around the 75.025, 30.025 cell
_units = [(0, "India", "Country", None, (68, 6, 97, 36)), (1, "Punjab", "State", None, (73.8, 29.5, 77, 32.6)),
          (2, "Ludhiana", "District", "Punjab", (74.9, 29.9, 75.2, 30.2))]
pd.DataFrame([{"id": i, "level": lvl, "name": n, "kind": k, "adm1": a, "country": "India", "iso": "IND",
               "geometry": shapely.to_wkb(shapely.box(*b)), "lx": (b[0] + b[2]) / 2, "ly": (b[1] + b[3]) / 2,
               "minx": b[0], "miny": b[1], "maxx": b[2], "maxy": b[3]} for i, (lvl, n, k, a, b) in enumerate(_units)]
             ).to_parquet(tmp / "admin.parquet", index=False)
pd.DataFrame({"lat": [30.025, 20.025, 20.075], "lon": [75.025, 80.025, 80.075],
              "adm0_id": [0, 0, 0], "adm1_id": [1, -1, -1], "adm2_id": [2, -1, -1]}).to_parquet(tmp / "cell_admin.parquet", index=False)
os.environ["APP_DATA"] = str(tmp)

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402

c = TestClient(app)
BBOX = "74,29,76,31"


def test_series_zero_filled_and_stats():
    s = c.get("/api/series", params={"bbox": BBOX}).json()
    assert len(s) == 72 and s[0]["month"] == "2001-01" and s[-1]["month"] == "2006-12"
    feb = next(r for r in s if r["month"] == "2003-02")
    assert feb["hotspots"] == 0 and feb["hist_median"] == 0 and feb["pct_vs_median"] is None and feb["flag"] == ""
    jan06 = next(r for r in s if r["month"] == "2006-01")
    assert jan06["hist_median"] == 10 and jan06["pct_vs_median"] == 900 and jan06["mean"] == 25
    assert abs(jan06["z"] - 2.236) < 0.01 and jan06["flag"] == "unusually high"
    assert jan06["source"] == "VIIRS" and s[0]["source"] == "MODIS-scaled"


def test_bbox_filtering():
    s = c.get("/api/series", params={"bbox": BBOX}).json()
    assert next(r for r in s if r["month"] == "2003-06")["hotspots"] == 0
    total = sum(r["hotspots"] for r in c.get("/api/series").json())
    assert total == 6 * 10 + 90 + 60


def test_summary():
    r = c.get("/api/summary", params={"bbox": BBOX, "start": "2001-01", "end": "2006-12"}).json()
    assert r["total"] == 150 and r["peak_month"] == "2006-01" and r["peak_year"] == "2006"
    assert r["busiest_calendar_month"] == 1 and r["anomalous_months"] == 1
    assert r["latest_month"] == "2006-11"  # last COMPLETE month, not the range end


def test_map_regrid():
    fine = c.get("/api/map", params={"start": "2003-06", "end": "2003-06"}).json()
    assert len(fine) == 2
    coarse = c.get("/api/map", params={"start": "2003-06", "end": "2003-06", "grid": 0.5}).json()
    assert coarse == [{"lon": 80.25, "lat": 20.25, "hotspots": 60.0, "modis": 6, "viirs": 0}]


def test_download_csv():
    r = c.get("/api/download", params={"bbox": BBOX})
    rows = list(csv.reader(io.StringIO(r.text)))
    assert rows == [["lat", "lon", "acq_date", "sensor", "confidence", "frp"],
                    ["30.01", "75.01", "2006-01-05", "VIIRS", "n", "3.5"]]
    assert "attachment" in r.headers["content-disposition"]
    s = c.get("/api/download/series", params={"bbox": BBOX}).text.splitlines()
    assert s[0].startswith("month,hotspots") and len(s) == 73


def test_download_too_large_gives_a_reason(monkeypatch):
    import backend.main as m
    monkeypatch.setattr(m, "MAX_DOWNLOAD_ROWS", 0)
    r = c.get("/api/download", params={"bbox": BBOX})
    assert r.status_code == 413 and "smaller area" in r.json()["detail"]


def test_validation_400():
    assert c.get("/api/map", params={"start": "2020-13"}).status_code == 400
    assert c.get("/api/series", params={"bbox": "1,2,3"}).status_code == 400
    assert c.get("/api/series", params={"bbox": "10,0,5,1"}).status_code == 400
    assert c.get("/api/summary", params={"start": "2005-01", "end": "2004-01"}).status_code == 400
    assert c.get("/api/map", params={"grid": 0.01}).status_code == 422
    assert c.get("/api/meta").json()["data_source"] == "synthetic_sample"


def test_modis_scaled_uses_tile_then_month_then_global_k():
    s = {r["month"]: r for r in c.get("/api/series").json()}
    assert s["2001-01"]["modis_scaled"] == 2 * 5.0        # tile 70,30 factor for January
    assert s["2003-06"]["modis_scaled"] == (5 + 1) * 2.0  # tile 80,20 not fitted -> calendar-month k


def test_gap_month_not_flagged_and_notes():
    s = {r["month"]: r for r in c.get("/api/series", params={"bbox": BBOX}).json()}
    assert s["2005-01"]["note"] == "VIIRS data gap (3–6 Jan)" and s["2005-01"]["flag"] == ""
    assert s["2006-12"]["note"] == "provisional (NRT data)" and s["2006-01"]["note"] == ""
    assert s["2006-01"]["flag"] == "unusually high"  # non-gap months still flagged


def test_anomaly_vs_same_window_other_years():
    r = c.get("/api/anomaly", params={"start": "2006-01", "end": "2006-01", "grid": 0.05, "bbox": BBOX}).json()
    assert len(r) == 1 and r[0]["current"] == 100 and r[0]["baseline"] == 10 and r[0]["diff"] == 90 and r[0]["z"] > 2
    # a normal year is not returned (diff 0)
    assert c.get("/api/anomaly", params={"start": "2003-01", "end": "2003-01", "grid": 0.05, "bbox": BBOX}).json() == []
    # years with no fire in the window count as 0 in the baseline: June 2003 is the only June with fire
    r = c.get("/api/anomaly", params={"start": "2003-06", "end": "2003-06", "grid": 0.5}).json()
    assert r == [{"lon": 80.25, "lat": 20.25, "current": 60.0, "baseline": 0.0, "diff": 60.0, "z": 40.47}]
    assert c.get("/api/anomaly", params={"start": "2001-01", "end": "2002-06"}).status_code == 400


def test_search_fuzzy_and_hierarchy():
    r = c.get("/api/search", params={"q": "pun"}).json()
    assert r[0]["name"] == "Punjab" and r[0]["kind"] == "State" and r[0]["parent"] == "India"
    assert c.get("/api/search", params={"q": "ludhiyana"}).json()[0]["name"] == "Ludhiana"  # typo-tolerant
    d = c.get("/api/search", params={"q": "ludhiana"}).json()[0]
    assert d["parent"] == "Punjab, India" and d["id"] == "a2"


def test_region_filters_series_and_summary():
    by_box = c.get("/api/series", params={"bbox": BBOX}).json()
    by_state = c.get("/api/series", params={"region": "a1"}).json()
    assert [r["hotspots"] for r in by_state] == [r["hotspots"] for r in by_box]  # same single cell
    country = c.get("/api/summary", params={"region": "a0"}).json()
    assert country["total"] == 6 * 10 + 90 + 60  # all three cells are in India
    circle = c.get("/api/summary", params={"region": "c75.0,30.0,10"}).json()
    assert circle["total"] == 150  # 75.025, 30.025 is ~3.6 km away
    assert c.get("/api/series", params={"region": "a99"}).status_code == 400


def test_region_info_top_and_cell():
    info = c.get("/api/region/a2").json()
    assert info["parent"] == "Punjab, India" and info["in_coverage"] and len(info["rings"][0]) == 5
    assert c.get("/api/region/c140,-40,25").json()["in_coverage"] is False
    top = c.get("/api/top").json()
    assert top[0]["name"] == "Ludhiana" and top[0]["share"] == 100.0  # the other cells have no district/state
    cell = c.get("/api/cell", params={"lon": 75.025, "lat": 30.025, "grid": 0.05, "start": "2006-01", "end": "2006-01"}).json()
    assert (cell["district"], cell["state"], cell["country"]) == ("Ludhiana", "Punjab", "India")
    assert cell["current"] == 100 and cell["median"] == 10 and cell["pct_vs_median"] == 900


def test_fixed_scale_quantiles():
    r = c.get("/api/scale", params={"grid": 0.05}).json()
    assert r["q"]["0"] == 10 and r["q"]["0.995"] <= 100 and list(r["q"])[-2:] == ["0.99", "0.995"]
    coarse = c.get("/api/scale", params={"grid": 1}).json()["q"]  # 1-degree cells merge the two June cells
    assert coarse["0.995"] > 50


def test_daily_counts_harmonized_and_zero_filled():
    d = c.get("/api/daily", params={"start": "2006-01-01", "end": "2006-01-10", "bbox": BBOX}).json()
    assert len(d) == 10 and [x["hotspots"] for x in d if x["date"] == "2006-01-05"] == [1.0]  # VIIRS point counts 1
    assert sum(x["hotspots"] for x in d) == 1.0
    m = c.get("/api/daily", params={"start": "2003-06-01", "end": "2003-06-30"}).json()
    assert sum(x["hotspots"] for x in m) == 2.0  # MODIS point before viirs_start x calendar-month k (2.0)
    assert c.get("/api/daily", params={"start": "2003-01-01", "end": "2005-01-01"}).status_code == 400  # > 400 days
    assert c.get("/api/daily", params={"start": "2006-01-01", "end": "2006-01-10", "region": "a2"}).json()[4]["hotspots"] == 1.0


def test_season_text():
    r = c.get("/api/season", params={"bbox": BBOX}).json()
    assert r["text"].startswith("Fires usually start") and r["peak"] is not None
    assert c.get("/api/season", params={"bbox": "0,0,1,1"}).json()["text"] == "No fires recorded in this area."


def test_top_within_selected_region():
    assert [x["name"] for x in c.get("/api/top", params={"region": "a1"}).json()] == ["Ludhiana"]
    assert c.get("/api/top", params={"bbox": "79,19,81,21"}).json() == []  # cells there have no admin unit

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

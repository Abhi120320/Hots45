"""Write small synthetic FIRMS-style CSVs to sample_data/ (for unit tests only — NOT real observations).

MODIS 2008-2015, VIIRS 2012-2015. VIIRS counts are drawn at TRUE_K × the MODIS rate so tests can
check that fire_harmonize.py recovers the factor.
"""
from pathlib import Path

import numpy as np
import pandas as pd

TRUE_K = 4.0
OUT = Path(__file__).resolve().parent / "sample_data"
SEASON = np.array([1, 1, 2, 4, 3, 1, 0.5, 0.5, 1, 6, 8, 2])  # relative monthly intensity
SITES = [(75.5, 30.5), (79.0, 22.0), (88.0, 25.0)]  # arbitrary centres


def rows(rng, sensor, year, scale):
    out = []
    for mo in range(1, 13):
        for lon, lat in SITES:
            n = rng.poisson(20 * SEASON[mo - 1] * scale)
            days = rng.integers(1, 29, n)
            for d, dx, dy in zip(days, rng.normal(0, 0.5, n), rng.normal(0, 0.5, n)):
                conf = str(rng.integers(30, 100)) if sensor == "MODIS" else rng.choice(["n", "h"])
                out.append({
                    "latitude": round(lat + dy, 4), "longitude": round(lon + dx, 4),
                    "brightness": 320.0, "scan": 1.0, "track": 1.0,
                    "acq_date": f"{year}-{mo:02d}-{d:02d}", "acq_time": "0830",
                    "satellite": "Terra" if sensor == "MODIS" else "N", "instrument": sensor,
                    "confidence": conf, "version": "sample", "bright_t31": 290.0,
                    "frp": round(float(rng.gamma(2, 8)), 2), "daynight": "D", "type": 0,
                })
    return out


def main(seed=0, out=OUT):
    rng = np.random.default_rng(seed)
    out.mkdir(exist_ok=True)
    for y in range(2008, 2016):
        pd.DataFrame(rows(rng, "MODIS", y, 1)).to_csv(out / f"modis_{y}.csv", index=False)
    for y in range(2012, 2016):
        pd.DataFrame(rows(rng, "VIIRS", y, TRUE_K)).to_csv(out / f"viirs_{y}.csv", index=False)
    print(f"wrote synthetic sample CSVs to {out}")


if __name__ == "__main__":
    main()

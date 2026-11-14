# FireLedger — harmonized MODIS + VIIRS burning activity calendar

NASA Space Apps 2026 · *Harmonization of MODIS and VIIRS Hot Spots*

FireLedger merges the long MODIS active-fire record (2000→) with VIIRS S-NPP (2012→) into one
**VIIRS-equivalent** monthly hotspot series, so the sensor of origin no longer matters. Pick a region and
period on a 3D globe/map and see a month × year burning calendar, the comparison with the historical median,
anomalies (|z| > 2), and before/after-harmonization charts. You can download the hotspots as CSV.

```
data_prep/   fire_harmonize.py (clean → grid → harmonize → app data), check_real_data.py, make_sample_data.py
backend/     FastAPI + DuckDB over Parquet (main.py); app_data/ is generated
frontend/    Vite + React + TypeScript, deck.gl globe/map, MapLibre, ECharts, Tailwind
```

## Run locally

Requires Python 3.10+ (tested with 3.12) and Node 20+.

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt -r data_prep/requirements.txt

# 1. Build the app data (real FIRMS CSVs in data_prep/data/)
cd data_prep
../.venv/bin/python check_real_data.py data_asia
../.venv/bin/python fire_harmonize.py --modis "data_asia/fire_*_M-C61_*.csv" --viirs "data_asia/fire_*_SV-C2_*.csv" \
    --start 2003-01 --end 2026-10 --fit-end 2021-12 --region Asia --report "Punjab-Haryana:73.8,28.4,77.6,32.6"
cd ..

# 2. Build the frontend once, then one process serves everything
cd frontend && npm install && npm run build && cd ..
.venv/bin/uvicorn backend.main:app          # http://127.0.0.1:8000
```

For frontend development, run `npm run dev` in `frontend/` while uvicorn runs. Vite proxies `/api` to port 8000.

Tests: `.venv/bin/python -m pytest backend data_prep`

### Configuration (.env)

There are no secrets. Each setting has a default, so `.env` files are optional.

| File | Variable | Default | Purpose |
|---|---|---|---|
| `.env` (copy from `.env.example`) | `APP_DATA` | `backend/app_data` | folder with `cells.parquet`, `points.parquet`, `meta.json` |
| | `CORS_ORIGINS` | `*` | comma-separated origins allowed to call the API |
| | `PORT` | `8000` | host port for docker compose |
| `frontend/.env` (copy from `frontend/.env.example`) | `VITE_API_URL` | empty (same origin) | API base URL when the frontend is hosted separately |

To run locally with the file: `.venv/bin/uvicorn backend.main:app --env-file .env`. Docker compose reads `.env` automatically.

### Docker

```bash
cp .env.example .env                       # optional
# build app data from the CSVs in data_prep/data/ (writes backend/app_data/)
docker compose run --rm prep --modis "data_asia/fire_*_M-C61_*.csv" --viirs "data_asia/fire_*_SV-C2_*.csv" --start 2003-01 --end 2026-10 --fit-end 2021-12 --region Asia
docker compose run --rm --entrypoint python prep check_real_data.py   # pre-flight check
docker compose up --build -d               # http://localhost:8000
```

The `app` image serves the API and the built frontend. `backend/app_data` is mounted read-only, so re-running
`prep` and then `docker compose restart app` switches datasets.

### Synthetic sample data (tests and offline demos only)

```bash
cd data_prep
../.venv/bin/python make_sample_data.py
../.venv/bin/python fire_harmonize.py --modis "sample_data/modis*.csv" --viirs "sample_data/viirs*.csv" --sample
```

`--sample` writes `"data_source": "synthetic_sample"` to `meta.json`. The UI then shows a permanent
**SAMPLE DATA — not real fire observations** banner. The banner disappears with real data (`"nasa_firms"`).

## Swapping in the full FIRMS archive (no code changes)

1. Put the FIRMS archive CSVs (MODIS C6.1 `fire_archive_M-C61_*.csv`, VIIRS S-NPP C2 `fire_archive_SV-C2_*.csv`,
   or the country files `modis_YYYY_*.csv` / `viirs-snpp_YYYY_*.csv`) in `data_prep/data/`.
2. `cd data_prep && ../.venv/bin/python check_real_data.py` checks the following:
   - every file has the columns `fire_harmonize.py` needs;
   - no NOAA-20 (`J1V`) or NOAA-21 (`J2V`) VIIRS files are present (we use S-NPP only, so no new sensor jump);
   - no `fire_nrt_*` file overlaps the archive dates (overlaps would double-count);
   - it prints row counts per sensor and year.
3. Run the harmonizer with globs that match your files, e.g.
   `../.venv/bin/python fire_harmonize.py --modis "data/*M-C61*.csv" --viirs "data/*SV-C2*.csv"`
4. Restart the backend.

The output files form the data contract: `cells.parquet`, `points.parquet` and `meta.json`.
The frontend reads everything from the API, including the record span, factors, R² and method text. Nothing is hard-coded.

## Method

- **Engine:** DuckDB SQL runs directly on the CSV globs (capped at 4 GB RAM; it spills to disk). Only tile × month
  aggregates enter pandas. Outputs: `cells.parquet` (0.05°), `cells_0.5.parquet` (globe), `points.parquet/year=YYYY/` (partitioned).
- **Period:** `--start 2003-01` (MODIS before mid-2002 is Terra-only, which would add a false jump). `--end` drops a trailing partial month.
- **De-duplicate:** NRT rows dated on or before the archive's last date are dropped. Then exact duplicates
  (same lat, lon, date, time and sensor, as at archive-file boundary days) are removed, keeping the archive copy.
- **Clean:** keep `type == 0` (vegetation fires, when the column exists). MODIS confidence ≥ 30; VIIRS confidence `n` or `h`.
  Optionally restrict to an area with `--bbox lon0 lat0 lon1 lat1`.
- **Grid:** 0.05° cells: `floor(lon/0.05)`, `floor(lat/0.05)`; cell centre = `(index + 0.5) × 0.05`.
- **Harmonize:** fit `VIIRS = k × MODIS` for each 10° × 10° tile and calendar month, by least squares through the origin
  on monthly counts over the overlap months where both sensors are > 0 (`k = Σ MV / Σ M²`).
  A tile-month with fewer than 3 overlap months uses the domain-wide k for that calendar month.
  VIIRS takes over from its first **complete** month: S-NPP starts on 2012-01-20, so Jan 2012 stays k × MODIS and is left out of the fits.
  Before that month, `hotspots = k × MODIS`; from it on, `hotspots = VIIRS`. All factors are saved in `meta.json`.
- **Fit window:** `--fit-end 2021-12`. After 2021, Aqua's overpass drifts later and Terra's earlier, which biases MODIS
  against VIIRS (over Punjab, the VIIRS/Aqua daytime ratio falls from about 5 to about 2 by 2025). So the factors are fitted on 2012-02 to 2021-12.
- **Data gaps:** a day is a gap when the domain-wide count for a sensor is below 10% of its 31-day median, which catches S-NPP outages
  such as 3–6 Nov 2024. Months with a gap in the sensor in use are noted in the app and never flagged as anomalies.
  Months containing NRT data are marked provisional. All of this is listed in `meta.json` (`data_gaps`, `month_notes`).
- **Latest vs median:** uses `last_complete_month` from `meta.json`.
- **Anomalies:** for each calendar month across all years: median, % vs median, mean, std (population), and z.
  The flag is "unusually high" if z > 2, "unusually low" if z < −2.

**Current record: Asia (60–150°E, 11°S–55°N), 2003-01 to 2026-10**
- 12.44 M MODIS and 33.82 M VIIRS hotspots after cleaning; 117,685 duplicates removed.
- VIIRS from 2012-02. Factors fitted on 2012-02 to 2021-12. Asia-wide k = 4.66. 60 tiles; 617 of 720 tile-months are fitted locally.
- R² (k × MODIS vs VIIRS) in the fit window: Asia 0.988, Punjab–Haryana 0.978.
  After 2021: Asia 0.966 (+0.2% bias), Punjab 0.813 (+8.7%, the orbit drift).
- Known limit: from 2022 Aqua's overpass drifts later (13:47 → 15:15 IST over Punjab by 2025) and Terra's drifts earlier.
  So recent k × MODIS overshoots VIIRS in Punjab. The harmonized series uses VIIRS for those years, so it is unaffected.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/meta` | `meta.json` |
| `GET /api/map?start=YYYY-MM&end=YYYY-MM&grid=0.05[&bbox=]` | `[{lon, lat, hotspots, modis, viirs}]`, summed over the range, re-gridded when `grid > 0.05` |
| `GET /api/series?bbox=lon0,lat0,lon1,lat1` | zero-filled monthly series with `hist_median, pct_vs_median, mean, std, z, flag, source` |
| `GET /api/summary?bbox=&start=&end=` | total, peak month/year, busiest calendar month, latest vs median, anomaly count |
| `GET /api/download?bbox=&start=&end=` | streamed CSV of cleaned hotspots |
| `GET /api/download/series?bbox=` | CSV of the monthly series |

All queries are parameterized DuckDB over Parquet. Invalid input returns a 400 error with a message.

## Deploy

- **Backend → Render:** `render.yaml` in the repo root. Set `CORS_ORIGINS` to your Vercel URL.
  `backend/app_data/` is gitignored. For a demo deploy of a small dataset, commit it with
  `git add -f backend/app_data`. For the full archive, which is too large for git, mount a Render disk and
  set `APP_DATA` to its path.
- **Frontend → Vercel:** set the project root to `frontend/` (`vercel.json` included). Set `VITE_API_URL` to the Render URL.

## Data sources and credits

- Active fires: NASA FIRMS. MODIS MCD14ML and VIIRS S-NPP VNP14IMGML (375 m), from https://firms.modaps.eosdis.nasa.gov/
- Imagery: NASA GIBS Blue Marble Shaded Relief + Bathymetry, VIIRS Black Marble (2016). Dark basemap: © CARTO, © OpenStreetMap contributors.
- This project is not endorsed by NASA. No NASA insignia are used.

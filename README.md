# Hots45 — harmonized MODIS + VIIRS burning activity calendar

NASA Space Apps 2026 · *Harmonization of MODIS and VIIRS Hot Spots*

Hots45 merges the long MODIS active-fire record (2000→) with VIIRS S-NPP (2012→) into one
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
../.venv/bin/python check_real_data.py data
../.venv/bin/python fire_harmonize.py --modis "data/fire_*_M-C61_*.csv" --viirs "data/fire_*_SV-C2_*.csv" \
    --start 2003-01 --end 2026-10 --fit-end 2021-12 --region Asia --report "Punjab-Haryana:73.8,28.4,77.6,32.6"
../.venv/bin/python build_boundaries.py   # states/districts for search, labels, polygon areas (~11 min first run)
../.venv/bin/python fire_intensity.py --report "Punjab-Haryana:73.8,28.4,77.6,32.6"   # FRP: k_FRP, R², diagnostics (~5 s)
../.venv/bin/python land_cover.py fetch   # MODIS land cover via AppEEARS (needs EARTHDATA_USER/PASS in .env; cached)
../.venv/bin/python land_cover.py label   # "What is burning": land cover per hotspot + per-group cell counts
cd ..

# 2. Build the frontend once, then one process serves everything
cd frontend && npm install && npm run build && cd ..
.venv/bin/uvicorn backend.main:app          # http://127.0.0.1:8000
```

For frontend development, run `npm run dev` in `frontend/` while uvicorn runs. Vite proxies `/api` to port 8000.

Tests: `.venv/bin/python -m pytest backend data_prep` and `cd frontend && npm test` (timeline state).

### Configuration (.env)

There are no secrets. Each setting has a default, so `.env` files are optional.

| File | Variable | Default | Purpose |
|---|---|---|---|
| `.env` (copy from `.env.example`) | `APP_DATA` | `backend/app_data` | folder with `cells.parquet`, `points.parquet`, `meta.json` |
| | `CORS_ORIGINS` | `*` | comma-separated origins allowed to call the API |
| | `PORT` | `8000` | host port for docker compose |
| | `EARTHDATA_USER`, `EARTHDATA_PASS` | none | NASA Earthdata login, only for `land_cover.py fetch`/`spotcheck` (the one secret; `.env` is gitignored) |
| `frontend/.env` (copy from `frontend/.env.example`) | `VITE_API_URL` | empty (same origin) | API base URL when the frontend is hosted separately |

To run locally with the file: `.venv/bin/uvicorn backend.main:app --env-file .env`. Docker compose reads `.env` automatically.

### Docker

```bash
cp .env.example .env                       # optional
# build app data from the CSVs in data_prep/data/ (writes backend/app_data/)
docker compose run --rm prep --modis "data/fire_*_M-C61_*.csv" --viirs "data/fire_*_SV-C2_*.csv" --start 2003-01 --end 2026-10 --fit-end 2021-12 --region Asia
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

## Fire intensity: Fire Radiative Power (FRP)

`data_prep/fire_intensity.py` works from the `frp` column (MW) of the cleaned points. Run it after `fire_harmonize.py`; it can be re-run.

- **Aggregates:** for each 0.05° cell and month, `frp_modis` and `frp_viirs` (sum of FRP over detections) and
  `frp_p90_modis` and `frp_p90_viirs` (90th percentile per hotspot) go into `cells.parquet`. The sums also go into the 0.5° globe file.
  `frp_tiles.parquet` holds the count, sum, mean and p90 per 10° tile, month and sensor.
  Mean FRP per hotspot is `frp_<sensor> / <sensor count>`.
- **Harmonized total FRP (`frp`):** computed the same way as counts. For each 10° tile and calendar month, VIIRS_FRP = k_FRP × MODIS_FRP
  is fitted through the origin on monthly totals from 2012-02 to 2021-12. Tile-months with fewer than 3 overlap months use the domain k_FRP for that calendar month.
  Before 2012-02 total FRP = k_FRP × MODIS; from 2012-02 it is VIIRS. Factors and diagnostics are written to `meta.json` → `frp`.
- **Not harmonized:** mean and p90 FRP per hotspot. A 375 m VIIRS pixel detects many small fires that a 1 km MODIS pixel misses, so
  VIIRS per-hotspot FRP is about 4× lower (Asia, 2012–2021: MODIS 39 MW, VIIRS 8 MW). The app shows these per sensor only.
- **"Fire energy"** in the app means ΣFRP, the sum of FRP (MW) over all detections. It is a proxy for the amount of burning, not
  energy in joules, because each fire is seen only at overpass times.
- **Result (Asia, fit window):** k_FRP = 0.93 domain-wide. R² is 0.993 for Asia and 0.979 for Punjab–Haryana, with bias −3.0% and −1.2%.
  The effective k_FRP depends on the kind of fire. It is 1.5–2.2 over South Asian cropland tiles (Punjab 1.73), where VIIRS sees more small
  fires, and 0.5–0.8 over boreal and steppe tiles, where VIIRS reports lower FRP than MODIS for large co-detected fires.
- **Reliability:** monthly R² is high everywhere, but it is dominated by the seasonal cycle. The script also checks how stable the yearly
  VIIRS/MODIS ratio is inside the fit window. It flags tiles holding ≥ 0.5% of VIIRS FRP whose R² is below 0.6 or whose yearly-ratio CV is above 0.2.
  Four tiles are flagged: Sumatra (100°E, 10°S; ratio 0.83–2.16), Borneo/Java (110°E, 10°S; 1.08–2.07), southern Siberia/Mongolia
  (100°E, 50°N; 0.58–1.11) and one small tile. In Riau the ratio falls from about 1.0 (2012–2017) to 0.6–0.84 (2018–2021).
  So pre-2012 FRP for the peat and forest regions of Indonesia is uncertain by about ±25% in a given year, compared with about ±10% for Asia and Punjab.
  After 2021 the drift of the Aqua and Terra overpass times also biases k_FRP × MODIS (Asia −14%), which is why those years are left out of the fit.

## Fire outlook (statistical forecast)

`backend/outlook.py` gives a forecast for the 1–3 months after the latest complete month, for any selected area,
using monthly harmonized hotspots. It is pure functions, served by `/api/outlook` and covered by `backend/test_outlook.py`.

- **Baseline:** the median, 10th and 90th percentile of the same calendar month in VIIRS-era years (2012 on) before the target month.
- **Trend:** Sen's slope on yearly totals of the last 10 complete years. It is applied only if Mann-Kendall p < 0.05, as a factor
  (clamped to ×⅓…×3) from the baseline's middle year to the target year.
- **Persistence:** the last 3 complete months compared with their normal, giving a ratio r. The forecast is multiplied by r^w,
  with a separate w for each horizon, chosen from {0, ¼, ½, ¾, 1} as the weight with the lowest error on earlier backtest forecasts only.
- **80% range:** the 10th–90th percentile of the model's own earlier log-errors at that horizon, once ≥ 24 verified forecasts exist.
  Before that it uses the baseline p10–p90, which turned out too narrow (about 35% coverage in 2015–2016).
- **Backtest:** every month 2015–2025, horizons 1–3, each forecast made only from data before it. A test corrupts every month after a
  cutoff and checks that all forecasts made at or before it are unchanged. Accuracy is compared with the plain historical median
  (same month, every earlier year). **At each horizon where the model does not beat that median, the app shows the median and says so.**
- **Next season dates:** each complete VIIRS-era season runs while the 15-day mean stays ≥ 25% of that season's peak. The app shows
  the median start, peak and end, with a 10–90% range.
- **Alert:** "Outlook: above-normal season likely" fires when a fire-season month in the next 3 has P(above normal) ≥ 0.8.
  A fire-season month is one whose normal is at or above the median month.
- **Limits:** it cannot foresee droughts or El Niño years that start from a quiet period. Before the 2015 and 2019 Riau seasons
  the preceding months were below normal, so neither was forecast. Recent months from NRT data are flagged as provisional inputs.
  *Statistical outlook based on past satellite data; does not include weather forecasts; not an official forecast.*

## Land cover: "What is burning"

`data_prep/land_cover.py` labels every hotspot with NASA MODIS **MCD12Q1 Collection 6.1** land cover
(500 m, yearly, IGBP classification `LC_Type1`).

1. **Download** (`land_cover.py fetch`): one AppEEARS area request for the Asia box (60–150°E, 11°S–55°N),
   `MCD12Q1.061` layer `LC_Type1`, GeoTIFF in geographic projection, for each year from the year before the record
   starts to the year before it ends. Credentials come from `EARTHDATA_USER`/`EARTHDATA_PASS` in `.env`
   (free account at urs.earthdata.nasa.gov; log in once at appeears.earthdatacloud.nasa.gov to approve the app).
   The task id is saved in `data_prep/data_landcover/task.json`, so a re-run resumes waiting instead of resubmitting.
   Files that are already downloaded are skipped. AppEEARS can take hours for an area this large.
2. **Label** (`land_cover.py label`, re-runnable): each hotspot gets the IGBP class at its location from the
   **previous year's** map, because a fire changes the land cover it burns. When that year is missing, it uses the
   latest earlier map, or else the earliest map. Points are processed in 1 M-row Arrow batches with NumPy, one yearly
   map in memory at a time. It adds `land_cover` (IGBP 1–17, null when there is no value) and `lc_group` to
   `points.parquet`, and `lc_forest … lc_other` to `cells.parquet` and `cells_0.5.parquet`. Groups are harmonized
   like the totals: before `viirs_start` a group's hotspots are its MODIS share × k × MODIS, and after it they are
   its VIIRS count. The groups sum to `hotspots` in every cell, which the script checks. Re-run `label` after
   `fire_harmonize.py`, which rewrites the points.
3. **Groups:** Forest (IGBP 1–5), Shrubland/Savanna (6–9), Grassland (10), Wetland (11), Cropland (12, and 14 =
   cropland/natural mosaic), Other (13, 15–17, and hotspots with no map value).
   Peatland is not a separate class: peat fires show up as forest, wetland or cropland.
4. **Validate:** `land_cover.py report --report "Punjab-Haryana:73.8,28.4,77.6,32.6" --report "Riau:100.0,-1.2,103.9,2.95"`
   prints the share per group. `land_cover.py spotcheck` draws 20 random hotspots and compares their stored class
   with an independent AppEEARS **point** extraction on the native sinusoidal grid, which checks the georeferencing
   and the previous-year rule.

- **Result (Asia record, 2003-01 to 2026-10):** 46,256,197 hotspots labelled with maps from 2002 to 2025. 40 had no map value.
  Share of harmonized hotspots by group:

  | Area | Forest | Shrubland/Savanna | Grassland | Wetland | Cropland | Other |
  |---|---|---|---|---|---|---|
  | Asia | 27.2% | 35.0% | 11.5% | 0.3% | 24.7% | 1.4% |
  | Punjab–Haryana (73.8–77.6°E, 28.4–32.6°N) | 0.6% | 2.3% | 0.3% | 0.0% | 96.1% | 0.7% |
  | Riau (province outline) | 43.0% | 52.6% | 2.0% | 0.5% | 1.8% | <0.5% |

  In Riau, 54% of hotspots fall on "woody savanna" and 38% on evergreen broadleaf forest. MODIS usually maps drained or degraded peat
  forest, acacia and young oil palm as woody savanna, so peat fires show up as Shrubland/Savanna and Forest, not Wetland.
- **Spot check:** 35 of 40 random hotspots (two draws, maps from 2002 to 2025) match AppEEARS' own point extraction on the native sinusoidal grid.
  At the group level 38 of 40 match. In all 5 mismatches the native class is one of the adjacent pixels, which comes from reprojecting
  to latitude/longitude at pixel edges, not from a georeferencing error.

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
| `GET /api/outlook?bbox=&region=` | outlook for the next 1–3 months, backtest scores, next season dates, disclaimer |
| `GET /api/landcover?bbox=&region=&start=&end=` | hotspots and share per land-cover group, plus a plain-language summary |

`/api/series`, `/api/summary`, `/api/daily`, `/api/season`, `/api/map`, `/api/scale` and `/api/cell` take `metric=frp`, which switches them
to harmonized total FRP (MW). `/api/intensity?bbox=&region=&start=&end=` returns the mean and p90 FRP per hotspot for each sensor separately.

`/api/series`, `/api/daily` and `/api/season` take `group=<key>` (`forest`, `crop`, …) to count only that fire type.
`/api/map?lc=1` adds the dominant group per cell (`lc`, an index into `meta.land_cover.groups`, and `lc_share`).
The hotspots CSV includes `land_cover` and `lc_group` once the points are labelled.

All queries are parameterized DuckDB over Parquet. Invalid input returns a 400 error with a message.

## Deploy

- **Vercel (one project, two services):** the root `vercel.json` runs the FastAPI backend (`/api/*`) and the
  Vite frontend (everything else). `backend/app_data/` is gitignored and too large for git, so publish it as a
  GitHub Release with `python data_prep/export_release.py backend/app_data OUT_DIR` and set `DATA_URL` to the
  release's download URL. The backend then reads points over HTTP and caches the small files in `/tmp`.
- **Docker:** `docker compose up --build` serves the app and the local `backend/app_data` on port 8000.

## Boundaries and search

`data_prep/build_boundaries.py` downloads geoBoundaries (gbOpen) states and districts for every country in the box.
India uses its official boundaries (Local Government Directory), and other countries' polygons have India's territory
subtracted, so the map follows India's point of view. The script writes `admin.parquet`, plus `cell_admin.parquet`,
which gives the district of every 0.05° cell. That makes polygon analytics and the district Top 10 a fast join.
Search is offline for countries, states and districts. Places go to the Photon geocoder (cached, at most 1 request/s).
Set `GEOCODER_USER_AGENT` to identify your deployment, and `GEOCODER_URL` to use your own Photon or Nominatim instance.

## Data sources and credits

Full inventory with URLs and licences, including every boundary layer: [CREDITS.md](CREDITS.md). Credits that are
required (or requested) and shown in the app footer:

- **Active fires:** NASA FIRMS, MODIS MCD14ML and VIIRS S-NPP VNP14IMGML (375 m), https://firms.modaps.eosdis.nasa.gov/.
  *We acknowledge the use of data and imagery from NASA's Fire Information for Resource Management System (FIRMS), part of NASA's ESDIS.*
- **Imagery:** NASA Blue Marble and VIIRS Black Marble (2016) via NASA GIBS, https://gibs.earthdata.nasa.gov/.
- **Dark basemap (required):** Powered by Esri. Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community.
- **Boundaries (required):** geoBoundaries gbOpen, Runfola, D. et al. (2020) *geoBoundaries: A global database of political
  administrative boundaries*, PLoS ONE 15(4): e0231866. Layers include © OpenStreetMap contributors (ODbL), WFP/OCHA ROAP
  (CC BY 3.0 IGO), DataMeet India (CC BY 2.5 IN), Australian Bureau of Statistics (CC BY 4.0), Singapore URA (Singapore Open
  Data Licence) and Wikimedia Commons contributors. The ODbL and CC BY-SA layers are share-alike: the boundary files in the
  data release stay under those licences.
- **Place search (required):** Photon by Komoot, https://photon.komoot.io/. Results © OpenStreetMap contributors (ODbL).
- **Fonts:** IBM Plex Sans and IBM Plex Mono (SIL Open Font License 1.1) via Google Fonts.
- **Libraries:** React, deck.gl, MapLibre GL JS, react-map-gl, Apache ECharts and others. Every build writes their licence
  texts to `third-party-licenses.txt`, served by the app.
- Hots45 is not endorsed by NASA or any data provider. No NASA insignia are used.

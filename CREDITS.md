# Credits and licences

Everything Hots45 uses from outside this repository, checked against the code, `frontend/package.json`,
`backend/requirements.txt` and `data_prep/requirements.txt` (November 2026). **Attribution required** marks
licences or terms that legally require a credit; those credits are shown in the app footer and in the README.

Hots45 is not endorsed by NASA, Esri, Komoot or any data provider. No NASA insignia are used.

## Data

| Source | Used for | URL | Licence / terms | Attribution |
|---|---|---|---|---|
| NASA FIRMS: MODIS Collection 6.1 (MCD14ML) and VIIRS S-NPP 375 m (VNP14IMGML) active fire archives | All hotspot counts | https://firms.modaps.eosdis.nasa.gov/ | NASA Earth science data: open, no restrictions ([EOSDIS data use policy](https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance)) | Requested, not required |
| NASA FIRMS NRT (same products, near real time) | Recent months marked provisional | https://firms.modaps.eosdis.nasa.gov/api/ | As above; MAP_KEY required | Requested, not required |
| NASA MODIS Land Cover Type MCD12Q1 Collection 6.1 (Friedl & Sulla-Menashe 2022), extracted with AppEEARS | Land-cover label per hotspot, "What is burning", Fire type map | https://doi.org/10.5067/MODIS/MCD12Q1.061 · https://appeears.earthdatacloud.nasa.gov/ | NASA Earth science data: open, no restrictions (EOSDIS data use policy) | Citation requested |
| geoBoundaries gbOpen (Runfola et al. 2020) | Country, state and district outlines, search, district rankings | https://www.geoboundaries.org/ | Per layer, see [Boundary layers](#boundary-layers): ODbL, CC BY, CC BY-SA, CC BY 3.0 IGO, public domain and others | **Required** (most layers) |

Requested NASA acknowledgement: *We acknowledge the use of data and imagery from NASA's Fire Information for Resource
Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Earth Science Data and Information System (ESDIS).*

MCD12Q1 citation: *Friedl, M., Sulla-Menashe, D. (2022). MODIS/Terra+Aqua Land Cover Type Yearly L3 Global 500m SIN Grid V061.
NASA EOSDIS Land Processes Distributed Active Archive Center. https://doi.org/10.5067/MODIS/MCD12Q1.061*. Extracted with
AppEEARS Team (2026), Application for Extracting and Exploring Analysis Ready Samples (AppEEARS), NASA EOSDIS LP DAAC, USGS EROS Center.

geoBoundaries citation: *Runfola, D. et al. (2020) geoBoundaries: A global database of political administrative
boundaries. PLoS ONE 15(4): e0231866. https://doi.org/10.1371/journal.pone.0231866*

## Map tiles and services (called at runtime)

| Service | Used for | URL | Licence / terms | Attribution |
|---|---|---|---|---|
| NASA GIBS: Blue Marble Shaded Relief + Bathymetry | "Blue Marble" imagery | https://gibs.earthdata.nasa.gov/ | NASA imagery: open, no restrictions | Requested, not required |
| NASA GIBS: VIIRS Black Marble (2016) | "Black Marble" imagery | https://gibs.earthdata.nasa.gov/ | NASA imagery: open, no restrictions | Requested, not required |
| Esri World Dark Gray Canvas (ArcGIS Online tiles) | "Dark" basemap | https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer | [Esri Master Agreement / Terms of Use](https://www.esri.com/en-us/legal/terms/full-master-agreement); data © Esri, HERE, Garmin, OpenStreetMap contributors (ODbL) | **Required**: the service's own attribution, "Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community" (from its `copyrightText`). The app also shows "Powered by Esri", Esri's usual credit; Esri's current terms pages could not be checked automatically, so review whether this use needs an ArcGIS account before production use |
| Photon geocoder by Komoot (server-side, cached, at most 1 request/s) | Place search (cities, towns, parks) | https://photon.komoot.io/ | Fair-use public API; results are OpenStreetMap data under [ODbL](https://opendatacommons.org/licenses/odbl/) | **Required**: "© OpenStreetMap contributors" |
| geoBoundaries API (build time only, `data_prep/build_boundaries.py`) | Downloading boundary files | https://www.geoboundaries.org/api/current/gbOpen/ | See above | See above |
| Google Fonts (CSS + font files) | Font delivery | https://fonts.google.com/ | [Google Fonts API terms](https://developers.google.com/fonts/terms); visitors' browsers request files from Google | Not required |

Requested NASA GIBS acknowledgement: *We acknowledge the use of imagery provided by services from NASA's Global Imagery
Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).*

## Fonts

| Font | URL | Licence | Attribution |
|---|---|---|---|
| IBM Plex Sans (400, 500, 600) | https://github.com/IBM/plex | SIL Open Font License 1.1 | Not required |
| IBM Plex Mono (400, 500) | https://github.com/IBM/plex | SIL Open Font License 1.1 | Not required |

## Frontend libraries (shipped to the browser)

| Library | Version | URL | Licence |
|---|---|---|---|
| React, React DOM | 19.3.1 | https://react.dev/ | MIT |
| deck.gl (core, layers, geo-layers, aggregation-layers, extensions, react) | 9.4.1 | https://deck.gl/ | MIT |
| MapLibre GL JS | 6.18.0 | https://maplibre.org/ | BSD-3-Clause |
| react-map-gl | 8.1.3 | https://visgl.github.io/react-map-gl/ | MIT |
| Apache ECharts | 6.1.0 | https://echarts.apache.org/ | Apache-2.0 |
| echarts-for-react | 3.0.6 | https://github.com/hustcc/echarts-for-react | MIT |

These pull in about 190 transitive packages (MIT, ISC, BSD-2/3-Clause, Apache-2.0, 0BSD; one is "MIT OR GPL-3.0",
used under MIT). Their licences require keeping copyright notices with the shipped code, so every build writes
`third-party-licenses.txt` with each package's licence text; the deployed app serves it at `/third-party-licenses.txt`.

## Frontend build and test tools (not shipped)

| Tool | URL | Licence |
|---|---|---|
| Vite 8 | https://vite.dev/ | MIT |
| @vitejs/plugin-react | https://github.com/vitejs/vite-plugin-react | MIT |
| Tailwind CSS 4, @tailwindcss/vite | https://tailwindcss.com/ | MIT |
| TypeScript 7 | https://www.typescriptlang.org/ | Apache-2.0 |
| Vitest 3 | https://vitest.dev/ | MIT |
| oxlint | https://oxc.rs/ | MIT |
| @types/node, @types/react, @types/react-dom | https://github.com/DefinitelyTyped/DefinitelyTyped | MIT |

## Backend and data pipeline (server side)

| Library | Version | URL | Licence |
|---|---|---|---|
| FastAPI | 0.162.7 | https://fastapi.tiangolo.com/ | MIT |
| Uvicorn | 0.54.0 | https://www.uvicorn.org/ | BSD-3-Clause |
| DuckDB (+ httpfs extension, downloaded at runtime on serverless) | 2.0.0 | https://duckdb.org/ | MIT |
| pandas | 3.1.1 | https://pandas.pydata.org/ | BSD-3-Clause |
| NumPy | 2.5.4 | https://numpy.org/ | BSD-3-Clause (bundled parts: 0BSD, MIT, Zlib) |
| PyArrow | 26.0.1 | https://arrow.apache.org/ | Apache-2.0 |
| Shapely | 2.2.0 | https://shapely.readthedocs.io/ | BSD-3-Clause |
| Matplotlib (data_prep charts only) | 3.11 | https://matplotlib.org/ | Matplotlib License (PSF-based) |
| tifffile, imagecodecs (data_prep land cover only) | 2026.10.15 / 2026.10.10 | https://github.com/cgohlke/tifffile · https://github.com/cgohlke/imagecodecs | BSD-3-Clause |
| python-dotenv (data_prep only) | 1.2 | https://github.com/theskumar/python-dotenv | BSD-3-Clause |
| pytest, HTTPX (tests only) | 9.2 / 0.28 | https://pytest.org/ · https://www.python-httpx.org/ | MIT · BSD-3-Clause |

## Boundary layers

Every geoBoundaries gbOpen layer in `admin.parquet` and `cell_admin.parquet`, with the licence and source reported by
the geoBoundaries API. **Share-alike:** the ODbL and CC BY-SA layers mean that boundary files derived from them, when
distributed (they are, in the `data-v1` GitHub release), must stay under those licences: ODbL for the OpenStreetMap-derived
layers and CC BY-SA for the five CC BY-SA layers. Hotspot counts and the harmonized series are not boundary data and are not affected.

India's outlines follow India's official boundaries: ADM2 from the Local Government Directory (lgdirectory.gov.in,
via Pathways Data, ODbL); ADM1 from DataMeet India / Election Commission of India (CC BY 2.5 IN).

| Country | Level | Licence | Source | Obligation |
|---|---|---|---|---|
| AFG | ADM0 | Public Domain | geoBoundaries, ArcGIS Hub | None |
| AFG | ADM1 | Public Domain | Wikimedia, geoBoundaries | None |
| AFG | ADM2 | Public Domain | Afghanistan Information Management Services, Esri Disaster Response Pr | None |
| AUS | ADM0 | Creative Commons Attribution 4.0 International (CC BY 4.0) | Australian Bureau of Statistics | Attribution |
| AUS | ADM1 | Creative Commons Attribution 4.0 International (CC BY 4.0) | Australian Bureau of Statistics | Attribution |
| AUS | ADM2 | Creative Commons Attribution 4.0 International (CC BY 4.0) | Australian Bureau of Statistics | Attribution |
| BGD | ADM0 | CC0 1.0 Universal (CC0 1.0) Public Domain Dedication | geoBoundaries, Wikimedia Commons | None |
| BGD | ADM1 | CC0 1.0 Universal (CC0 1.0) Public Domain Dedication | geoBoundaries, Wikimedia Commons | None |
| BGD | ADM2 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | Bangladesh Bureau of Statistics (BBS), OCHA ROAP | Attribution |
| BRN | ADM0 | Public Domain | Wikimedia Commons | None |
| BRN | ADM1 | Public Domain | geoBoundaries, Wikimedia Commons; credit to user 'Tachymetre' | None |
| BRN | ADM2 | Public Domain | geoBoundaries, Wikimedia Commons; credit to user 'Rarelibra' | None |
| BTN | ADM0 | Creative Commons Attribution 3.0 License | geoBoundaries, Wikimedia Commons; credit to author 'Babbage' | Attribution |
| BTN | ADM1 | Creative Commons Attribution 3.0 License | geoBoundaries, Wikimedia Commons; credit to author 'Babbage' | Attribution |
| BTN | ADM2 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | OCHA ROAP | Attribution |
| CHN | ADM0 | Public Domain | geoBoundaries, Wikimedia Commons | None |
| CHN | ADM1 | Public Domain | geoBoundaries, Wikimedia Commons | None |
| CHN | ADM2 | Open Data Commons Public Domain Dedication and License (PDDL) v1.0 | National Administration of Surveying, Mapping and Geoinformation of Ch | None |
| IDN | ADM0 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| IDN | ADM1 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| IDN | ADM2 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | Badan Pusat Statistik (BPS - Statistics Indonesia), World Food Program | Attribution |
| IND | ADM0 | CC0 1.0 Universal (CC0 1.0) Public Domain Dedication | geoBoundaries, Wikimedia Commons | None |
| IND | ADM1 | Creative Commons Attribution 2.5 India (CC BY 2.5 IN) | DataMeet India community, Election Commission of India | Attribution |
| IND | ADM2 | Open Data Commons Open Database License 1.0 | Pathways Data Pvt. Ltd., lgdirectory.gov.in | Attribution + share-alike (ODbL) |
| IRN | ADM0 | Public Domain | Natural Earth | None |
| IRN | ADM1 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| IRN | ADM2 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| JPN | ADM0 | Creative Commons Attribution 4.0 International (CC BY 4.0) | Ministry of Land, Infrastructure, Transport and Tourism National Land | Attribution |
| JPN | ADM1 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| JPN | ADM2 | Creative Commons Attribution-ShareAlike 2.0 | OpenStreetMap, Wambacher | Attribution + share-alike |
| KAZ | ADM0 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| KAZ | ADM1 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| KAZ | ADM2 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| KGZ | ADM0 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| KGZ | ADM1 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| KGZ | ADM2 | Creative Commons Attribution-ShareAlike 3.0 Unported | geoBoundaries, Wikipedia, Districts of Kyrgyzstan | Attribution + share-alike |
| KHM | ADM0 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| KHM | ADM1 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| KHM | ADM2 | Creative Commons Attribution 4.0 International (CC BY 4.0) | Open Development Mekong, Open Development Cambodia | Attribution |
| KOR | ADM0 | Public Domain | Natural Earth, geoBoundaries | None |
| KOR | ADM1 | Public Domain | Natural Earth | None |
| KOR | ADM2 | Creative Commons Attribution 3.0 License | geoBoundaries, citypopulation.de | Attribution |
| LAO | ADM0 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| LAO | ADM1 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| LAO | ADM2 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | National Geographic Department, OCHA ROAP | Attribution |
| LKA | ADM0 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| LKA | ADM1 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| LKA | ADM2 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| MDV | ADM0 | Creative Commons Attribution 4.0 (CC BY 4.0) | Sentinel-2 10-Meter Land Use/LandCover | Attribution |
| MDV | ADM1 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| MDV | ADM2 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | Government of the Republic of Maldives, OCHA ROAP | Attribution |
| MMR | ADM0 | Creative Commons Attribution-ShareAlike 2.0 | OpenStreetMap | Attribution + share-alike |
| MMR | ADM1 | Creative Commons Attribution 4.0 (CC BY 4.0) | Myanmar Analytics Project, geoBoundaries | Attribution |
| MMR | ADM2 | Creative Commons Attribution 4.0 (CC BY 4.0) | Myanmar Analytics Project, USAID/Burma | Attribution |
| MNG | ADM0 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| MNG | ADM1 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| MNG | ADM2 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | National Statistical Office of Mongolia, OCHA ROAP | Attribution |
| MYS | ADM0 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| MYS | ADM1 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| MYS | ADM2 | Creative Commons Attribution 3.0 License | geoBoundaries, citypopulation.de | Attribution |
| NPL | ADM0 | Creative Commons Attribution 4.0 International (CC BY 4.0) | Geoboundaries, Open Data Nepal | Attribution |
| NPL | ADM1 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | Survey Department of Nepal, OCHA FISS | Attribution |
| NPL | ADM2 | Public Domain | geoBoundaries, Wikimedia Commons | None |
| PAK | ADM0 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| PAK | ADM1 | Public Domain | geoBoundaries, Wikipedia | None |
| PAK | ADM2 | Public Domain | geoBoundaries, Wikipedia | None |
| PHL | ADM0 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | OCHA Philippines, National Mapping and Resource Information Authority | Attribution |
| PHL | ADM1 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | National Mapping and Resource Information Authority (NAMRIA), Philippi | Attribution |
| PHL | ADM2 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | National Mapping and Resource Information Authority (NAMRIA), Philippi | Attribution |
| PNG | ADM0 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| PNG | ADM1 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | Papua New Guinea National Statistics Office, OCHA ROAP | Attribution |
| PNG | ADM2 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | OCHA ROAP, Papua New Guinea National Statistics Office | Attribution |
| PRK | ADM0 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | World Food Programme, OCHA ROAP | Attribution |
| PRK | ADM1 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | World Food Programme, OCHA ROAP | Attribution |
| PRK | ADM2 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | World Food Programme, OCHA ROAP | Attribution |
| RUS | ADM0 | Open Data Commons Open Database License 1.0 | geoBoundaries, OpenStreetMap | Attribution + share-alike (ODbL) |
| RUS | ADM1 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| RUS | ADM2 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| SGP | ADM0 | Open Data Commons Open Database License 1.0 | Urban Redevelopment Authority, derived from ADM 3 | Attribution + share-alike (ODbL) |
| SGP | ADM1 | Open Data Commons Open Database License 1.0 | Urban Redevelopment Authority, derived from ADM 3 | Attribution + share-alike (ODbL) |
| SGP | ADM2 | Singapore Open Data License Version 1.0 | geoBoundaries, Urban Redevelopment Authority | Attribution |
| THA | ADM0 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| THA | ADM1 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| THA | ADM2 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | Royal Thai Survey Department, OCHA ROAP | Attribution |
| TJK | ADM0 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| TJK | ADM1 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| TJK | ADM2 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| TKM | ADM0 | Public Domain | geoBoundaries, Wikimedia | None |
| TKM | ADM1 | Public Domain | geoBoundaries, Wikimedia | None |
| TKM | ADM2 | Creative Commons Attribution-ShareAlike 3.0 Unported | CIESIN | Attribution + share-alike |
| TLS | ADM0 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| TLS | ADM1 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| TLS | ADM2 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | WHO, OCHA ROAP | Attribution |
| TWN | ADM0 | Pixabay License for Content | geoBoundaries, Pixabay | None |
| TWN | ADM1 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| TWN | ADM2 | Creative Commons Attribution-ShareAlike 2.0 | OpenStreetMap, Wambacher | Attribution + share-alike |
| UZB | ADM0 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| UZB | ADM1 | Open Data Commons Open Database License 1.0 | OpenStreetMap, Wambacher | Attribution + share-alike (ODbL) |
| UZB | ADM2 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | OCHA ROCCA | Attribution |
| VNM | ADM0 | Creative Commons Attribution 4.0 International (CC BY 4.0) | geoBoundaries, Wikipedia | Attribution |
| VNM | ADM1 | Public Domain | geoBoundaries, Wikipedia | None |
| VNM | ADM2 | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | OCHA ROAP, Government of Viet Nam | Attribution |

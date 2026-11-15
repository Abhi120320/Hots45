"""Build administrative boundaries (ADM1 states/provinces, ADM2 districts) for the app.

Source: geoBoundaries gbOpen, simplified GeoJSON per country (https://www.geoboundaries.org), clipped to the
data bbox. India uses its own official boundaries (geoBoundaries IND = Local Government Directory, India); every
other country's polygons have India's territory subtracted, so disputed areas follow India's point of view.

Writes to backend/app_data/:
  admin.parquet       one row per unit: id, level (0 country, 1 state, 2 district), name, kind, adm1, country, iso,
                      geometry (WKB), label point, bbox
  cell_admin.parquet  every 0.05° cell centre in cells.parquet -> adm0_id, adm1_id, adm2_id (point in polygon)

Run after fire_harmonize.py (cell_admin depends on cells.parquet):
  python build_boundaries.py [--bbox 60 -11 150 55]
"""
import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd
import shapely
from shapely.geometry import shape

HERE = Path(__file__).resolve().parent
RAW = HERE / "boundaries_raw"
OUT = HERE.parent / "backend" / "app_data"
API = "https://www.geoboundaries.org/api/current/gbOpen/{iso}/ADM{level}/"
COUNTRIES = {  # ISO3 -> display name, for countries intersecting lon 60-150, lat -11-55
    "AFG": "Afghanistan", "PAK": "Pakistan", "IND": "India", "NPL": "Nepal", "BTN": "Bhutan", "BGD": "Bangladesh",
    "LKA": "Sri Lanka", "MDV": "Maldives", "MMR": "Myanmar", "THA": "Thailand", "LAO": "Laos", "KHM": "Cambodia",
    "VNM": "Vietnam", "MYS": "Malaysia", "SGP": "Singapore", "BRN": "Brunei", "IDN": "Indonesia", "TLS": "Timor-Leste",
    "PHL": "Philippines", "PNG": "Papua New Guinea", "CHN": "China", "MNG": "Mongolia", "RUS": "Russia",
    "KAZ": "Kazakhstan", "UZB": "Uzbekistan", "TKM": "Turkmenistan", "KGZ": "Kyrgyzstan", "TJK": "Tajikistan",
    "IRN": "Iran", "PRK": "North Korea", "KOR": "South Korea", "JPN": "Japan", "TWN": "Taiwan", "AUS": "Australia",
}
SIMPLIFY = {1: 0.005, 2: 0.002}  # degrees; the API simplifies further per zoom


def fetch(iso, level):
    """Download (once) the simplified GeoJSON and its metadata for one country/level. Returns path or None."""
    RAW.mkdir(exist_ok=True)
    path, meta = RAW / f"{iso}_ADM{level}.geojson", RAW / f"{iso}_ADM{level}.json"
    try:
        if not meta.exists():
            with urllib.request.urlopen(API.format(iso=iso, level=level), timeout=60) as r:
                meta.write_bytes(r.read())
        if path.exists() and path.stat().st_size > 0:
            return path
        info = json.loads(meta.read_text())
        url = info.get("simplifiedGeometryGeoJSON") or info["gjDownloadURL"]
        with urllib.request.urlopen(url, timeout=300) as r:
            path.write_bytes(r.read())
        print(f"  downloaded {path.name} ({path.stat().st_size / 1e6:.1f} MB)")
        return path
    except Exception as e:  # some countries have no ADM2 in gbOpen; keep going
        print(f"  {iso} ADM{level}: not available ({e})")
        return None


# English, singular unit names per country (geoBoundaries' own labels are often "Unknown" or local-language plurals)
KIND1 = {"IND": "State", "PAK": "Province", "CHN": "Province", "IDN": "Province", "THA": "Province", "VNM": "Province",
         "MMR": "State/Region", "LAO": "Province", "KHM": "Province", "MYS": "State", "PHL": "Region", "BGD": "Division",
         "NPL": "Province", "AFG": "Province", "IRN": "Province", "RUS": "Federal subject", "KAZ": "Region", "UZB": "Region",
         "TKM": "Region", "KGZ": "Region", "TJK": "Region", "MNG": "Province", "JPN": "Prefecture", "KOR": "Province",
         "PRK": "Province", "TWN": "County", "LKA": "Province", "BTN": "District", "BRN": "District", "SGP": "Region",
         "MDV": "Atoll", "TLS": "Municipality", "PNG": "Province", "AUS": "State"}
KIND2 = {"IDN": "Regency", "CHN": "County", "PHL": "Province", "JPN": "Subprefecture", "MNG": "Soum", "TWN": "Township",
         "AUS": "Local government area", "TLS": "Administrative post", "KOR": "County", "PRK": "County", "BTN": "Gewog",
         "BRN": "Mukim", "IRN": "County"}
JUNK_NAMES = {"data not available", "unknown", "unnamed", ""}  # e.g. the India file's undistricted disputed areas


def kind(iso, level):
    return KIND1.get(iso, "Province") if level == 1 else KIND2.get(iso, "District")


def load(iso, level, bbox):
    path = fetch(iso, level)
    if not path:
        return []
    feats = json.loads(path.read_text())["features"]
    out = []
    for f in feats:
        g = shapely.make_valid(shape(f["geometry"]))
        g = shapely.clip_by_rect(g, *bbox)
        if g.is_empty:
            continue
        name = (f["properties"].get("shapeName") or "").strip()
        if name.lower() in JUNK_NAMES:
            continue
        out.append({"name": name, "iso": iso, "geom": g, "kind": kind(iso, level)})
    return out


def polygonal(g):
    """Keep only polygon parts (clipping/difference can leave lines and points)."""
    if g.is_empty:
        return g
    parts = [p for p in shapely.get_parts(g) if p.geom_type in ("Polygon", "MultiPolygon")]
    return shapely.union_all(parts) if parts else shapely.Polygon()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, default=[60, -11, 150, 55], metavar=("LON0", "LAT0", "LON1", "LAT1"))
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args(argv)
    out = Path(a.out)
    t0 = time.time()

    from concurrent.futures import ThreadPoolExecutor
    jobs = [(iso, level) for iso in COUNTRIES for level in (1, 2)]
    with ThreadPoolExecutor(8) as pool:  # downloads are I/O bound; cached files are skipped
        list(pool.map(lambda j: fetch(*j), jobs))
    units = {1: [], 2: []}
    for iso, level in jobs:
        units[level] += load(iso, level, a.bbox)
    if not units[1]:
        sys.exit("no ADM1 boundaries downloaded")

    # India's point of view: India's official extent wins wherever another country's polygon overlaps it.
    india = shapely.union_all([u["geom"] for u in units[1] if u["iso"] == "IND"])
    for level in (1, 2):
        for u in units[level]:
            if u["iso"] != "IND" and u["geom"].intersects(india):
                u["geom"] = polygonal(u["geom"].difference(india))
        units[level] = [u for u in units[level] if not u["geom"].is_empty]

    # countries (level 0) = union of their states, so a country can be selected like any other unit
    units[0] = [{"name": COUNTRIES[iso], "iso": iso, "kind": "Country",
                 "geom": shapely.union_all([u["geom"] for u in units[1] if u["iso"] == iso])}
                for iso in COUNTRIES if any(u["iso"] == iso for u in units[1])]

    # parent state for each district: the ADM1 of the same country containing its label point
    adm1_geoms = [u["geom"] for u in units[1]]
    tree1 = shapely.STRtree(adm1_geoms)
    rows = []
    for level in (0, 1, 2):
        for u in units[level]:
            g = polygonal(shapely.simplify(u["geom"], SIMPLIFY.get(level, 0.01), preserve_topology=True))
            if g.is_empty:
                continue
            p = shapely.point_on_surface(g)
            parent = None
            if level == 2:
                for i in tree1.query(p, predicate="within"):
                    if units[1][i]["iso"] == u["iso"]:
                        parent = units[1][i]["name"]
                        break
            x0, y0, x1, y1 = g.bounds
            rows.append({"level": level, "name": u["name"], "kind": u["kind"], "adm1": parent, "country": COUNTRIES[u["iso"]], "iso": u["iso"],
                         "geometry": shapely.to_wkb(g), "lx": p.x, "ly": p.y, "minx": x0, "miny": y0, "maxx": x1, "maxy": y1})
    admin = pd.DataFrame(rows)
    admin.insert(0, "id", np.arange(len(admin), dtype="int32"))
    out.mkdir(parents=True, exist_ok=True)
    admin.to_parquet(out / "admin.parquet", index=False)
    print(f"admin units: {(admin.level == 0).sum()} countries, {(admin.level == 1).sum():,} ADM1, "
          f"{(admin.level == 2).sum():,} ADM2 -> {out / 'admin.parquet'}")

    # every cell centre -> containing ADM1 / ADM2 (cell-centre point in polygon)
    import duckdb
    cells = duckdb.execute(f"SELECT DISTINCT lat, lon FROM read_parquet('{out / 'cells.parquet'}')").df()
    pts = shapely.points(cells.lon.to_numpy(), cells.lat.to_numpy())
    for level in (0, 1, 2):
        sub = admin[admin.level == level]
        tree = shapely.STRtree(shapely.from_wkb(sub.geometry.to_numpy()))
        pi, gi = tree.query(pts, predicate="within")
        ids = np.full(len(cells), -1, dtype="int32")
        ids[pi[::-1]] = sub.id.to_numpy()[gi[::-1]]  # reversed so the first match wins on (rare) overlaps
        cells[f"adm{level}_id"] = ids
    cells.to_parquet(out / "cell_admin.parquet", index=False)
    print(f"cells: {len(cells):,}; in a country {(cells.adm0_id >= 0).mean():.1%}, in an ADM1 {(cells.adm1_id >= 0).mean():.1%}, in an ADM2 {(cells.adm2_id >= 0).mean():.1%}"
          f" -> {out / 'cell_admin.parquet'}  ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()

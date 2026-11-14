"""Administrative boundaries: offline search, point lookup, boundary lines/labels and region outlines.

Loads admin.parquet / cell_admin.parquet written by data_prep/build_boundaries.py. Everything degrades to
"not available" when those files are missing, so the rest of the API keeps working.
"""
import difflib
import json
import math
import os
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd
import shapely

LEVEL_ORDER = {0: 0, 1: 1, 2: 2}
# Former / alternate names -> current name in the boundary files (searching either finds the unit)
ALIASES = {
    "orissa": "Odisha", "burma": "Myanmar", "uttaranchal": "Uttarakhand", "pondicherry": "Puducherry",
    "ceylon": "Sri Lanka", "siam": "Thailand", "persia": "Iran", "east timor": "Timor-Leste",
    "gurgaon": "Gurugram", "allahabad": "Prayagraj", "bombay": "Mumbai", "calcutta": "Kolkata", "madras": "Chennai",
    "bangalore": "Bengaluru", "peking": "Beijing", "canton": "Guangdong", "rangoon": "Yangon", "saigon": "Ho Chi Minh",
    "kampuchea": "Cambodia", "nwfp": "Khyber Pakhtunkhwa", "j&k": "Jammu and Kashmir", "jammu kashmir": "Jammu and Kashmir",
    "ncr": "Delhi", "new delhi": "Delhi", "irian jaya": "Papua", "west irian": "Papua", "borneo": "Kalimantan",
}


def norm(s):
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode().lower()
    return " ".join("".join(c if c.isalnum() else " " for c in s).split())


class Admin:
    def __init__(self, data_dir):
        p = Path(data_dir) / "admin.parquet"
        self.ok = p.exists()
        if not self.ok:
            return
        self.df = pd.read_parquet(p)
        self.df["name"] = self.df.name.fillna("")  # placeholder units keep their outline but have no name
        self.geoms = shapely.from_wkb(self.df.geometry.to_numpy())
        self.df["key"] = self.df.name.map(norm)
        # hierarchy shown in results: district -> "State, Country"; state -> "Country"; country -> ""
        self.df["parent"] = [", ".join(x for x in (a, c) if isinstance(x, str)) if lvl == 2 else ("" if lvl == 0 else c)
                             for a, c, lvl in zip(self.df.adm1, self.df.country, self.df.level)]
        self.trees = {lvl: (shapely.STRtree(self.geoms[self.df.level.to_numpy() == lvl]),
                            np.flatnonzero(self.df.level.to_numpy() == lvl)) for lvl in (0, 1, 2)}
        self.cell_admin = Path(data_dir) / "cell_admin.parquet"

    # ---------- lookups ----------
    def unit(self, i):
        r = self.df.iloc[i]
        return {"id": f"a{int(r.id)}", "name": r["name"], "kind": r.kind, "level": int(r.level), "parent": r.parent,
                "country": r.country, "bbox": [round(float(r.minx), 4), round(float(r.miny), 4),
                                               round(float(r.maxx), 4), round(float(r.maxy), 4)],
                "label": [round(float(r.lx), 4), round(float(r.ly), 4)]}

    def at(self, lon, lat):
        """{country, state, district} names containing a point (None where outside)."""
        out = {}
        pt = shapely.Point(lon, lat)
        for lvl, key in ((0, "country"), (1, "state"), (2, "district")):
            tree, idx = self.trees[lvl]
            hit = tree.query(pt, predicate="within")
            ok = len(hit) and self.df.name.iat[idx[hit[0]]]
            out[key] = self.df.name.iat[idx[hit[0]]] if ok else None
            out[f"{key}_id"] = f"a{int(self.df.id.iat[idx[hit[0]]])}" if ok else None
        return out

    def search(self, q, limit=12):
        """Fuzzy, typo-tolerant offline search over countries, states and districts (plus aliases)."""
        qn = norm(q)
        if not qn:
            return []
        targets = {qn}
        for alias, real in ALIASES.items():
            if alias.startswith(qn) or (len(qn) >= 4 and qn in alias):
                targets.add(norm(real))
        keys = self.df.key.to_numpy()
        score = np.zeros(len(keys))
        for t in targets:
            alias_pen = 0 if t == qn else 5
            for i, k in enumerate(keys):
                if k == t:
                    s = 100
                elif k.startswith(t):
                    s = 90 - min(10, len(k) - len(t))
                elif f" {t}" in f" {k}":
                    s = 78
                elif t in k:
                    s = 66
                elif len(t) >= 4 and k[:1] == t[:1] and abs(len(k) - len(t)) <= 3:
                    r = difflib.SequenceMatcher(None, t, k).ratio()  # typo tolerance
                    s = 60 * r if r >= 0.75 else 0
                else:
                    s = 0
                score[i] = max(score[i], s - alias_pen if s else 0)
        score = np.where(score > 0, score + (2 - self.df.level.to_numpy()) * 2, 0)  # bigger units first on near-ties
        order = np.lexsort((self.df.name.str.len().to_numpy(), self.df.level.to_numpy(), -score))
        return [self.unit(i) for i in order[:limit] if score[i] > 0]

    @lru_cache(maxsize=512)
    def outline(self, i, tol=0.002):
        g = shapely.simplify(self.geoms[i], tol, preserve_topology=True)
        return rings(g)

    def boundaries(self, level, bbox, zoom):
        """Boundary lines and label points intersecting bbox, simplified to ~1 px at this zoom."""
        tol = 360 / 256 / 2 ** zoom * 0.8
        d = self.df
        m = ((d.level == level) & (d.maxx >= bbox[0]) & (d.minx <= bbox[2]) & (d.maxy >= bbox[1]) & (d.miny <= bbox[3])).to_numpy()
        idx = np.flatnonzero(m)
        simple = shapely.simplify(self.geoms[idx], tol, preserve_topology=True)
        lines = [ring for g in simple for ring in rings(g, 3)]
        labels = [{"id": f"a{int(d.id.iat[i])}", "name": d.name.iat[i], "pos": [round(float(d.lx.iat[i]), 3), round(float(d.ly.iat[i]), 3)],
                   "area": round(float((d.maxx.iat[i] - d.minx.iat[i]) * (d.maxy.iat[i] - d.miny.iat[i])), 3)}
                  for i in idx if d.name.iat[i] and bbox[0] <= d.lx.iat[i] <= bbox[2] and bbox[1] <= d.ly.iat[i] <= bbox[3]]
        return {"lines": lines, "labels": labels}


def rings(g, nd=4):
    """Polygon/MultiPolygon -> list of rings as [[lon, lat], ...] (exteriors and holes)."""
    out = []
    for p in shapely.get_parts(g):
        if p.geom_type != "Polygon":
            continue
        for r in [p.exterior, *p.interiors]:
            out.append(np.round(np.asarray(r.coords), nd).tolist())
    return out


def circle(lon, lat, km, n=64):
    """Geodesic-ish circle polygon (fine at 25 km)."""
    a = np.linspace(0, 2 * np.pi, n, endpoint=False)
    dlat = km / 111.32
    dlon = km / (111.32 * max(0.01, math.cos(math.radians(lat))))
    return shapely.Polygon(np.c_[lon + dlon * np.cos(a), lat + dlat * np.sin(a)])


# ---------- place geocoder (Photon by Komoot, OSM data) ----------
# Usage policy: identify the app, cache, and keep to at most 1 request per second.
_GEO_UA = os.environ.get("GEOCODER_USER_AGENT", "Hots45/1.0 (wildfire data viewer)")
_GEO_URL = os.environ.get("GEOCODER_URL", "https://photon.komoot.io/api/")
_geo_lock, _geo_last = threading.Lock(), [0.0]


@lru_cache(maxsize=2048)
def geocode(q, bbox):
    with _geo_lock:  # serialize so we never exceed 1 request/second
        wait = 1.0 - (time.monotonic() - _geo_last[0])
        if wait > 0:
            time.sleep(wait)
        params = {"q": q, "limit": 6, "lang": "en", "bbox": ",".join(map(str, bbox))}
        req = urllib.request.Request(f"{_GEO_URL}?{urllib.parse.urlencode(params)}", headers={"User-Agent": _GEO_UA})
        try:
            with urllib.request.urlopen(req, timeout=8) as r:
                data = json.load(r)
        finally:
            _geo_last[0] = time.monotonic()
    out = []
    for f in data.get("features", []):
        pr, (lon, lat) = f["properties"], f["geometry"]["coordinates"]
        out.append({"name": pr.get("name") or q, "type": (pr.get("osm_value") or "place").replace("_", " "),
                    "lon": round(lon, 5), "lat": round(lat, 5),
                    "state": pr.get("state"), "country": pr.get("country")})
    return tuple(json.dumps(o) for o in out)  # hashable for the cache

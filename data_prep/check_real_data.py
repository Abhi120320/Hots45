"""Pre-flight check for real NASA FIRMS CSVs before running fire_harmonize.py.

Usage: python check_real_data.py [data_dir]   (default: data/)
Lists files, checks columns, flags NOAA-20/21 VIIRS files and NRT files overlapping the archive,
and prints row counts per sensor and year. Exit code 1 if a blocking problem is found.
"""
import sys
from pathlib import Path

import pandas as pd

NEEDED = {"latitude", "longitude", "acq_date", "confidence", "frp"}


def sensor_of(name):
    n = name.lower()
    if "j1v" in n or "noaa-20" in n or "noaa20" in n:
        return "NOAA-20"
    if "j2v" in n or "noaa-21" in n or "noaa21" in n:
        return "NOAA-21"
    if "modis" in n or n.startswith(("fire_archive_m", "fire_nrt_m")) or "m-c61" in n:
        return "MODIS"
    if "viirs" in n or "sv-c2" in n or "snpp" in n or "_v1_" in n:
        return "VIIRS S-NPP"
    return "unknown"


def main(data_dir="data"):
    files = sorted(Path(data_dir).glob("*.csv"))
    if not files:
        sys.exit(f"No CSV files in {data_dir}/")
    problems, info = [], []
    for f in files:
        cols = set(pd.read_csv(f, nrows=0).columns)
        dates = pd.to_datetime(pd.read_csv(f, usecols=["acq_date"]).acq_date) if "acq_date" in cols else None
        s = sensor_of(f.name)
        info.append({"file": f.name, "sensor": s, "nrt": "nrt" in f.name.lower(),
                     "start": dates.min() if dates is not None else None,
                     "end": dates.max() if dates is not None else None,
                     "years": dates.dt.year.value_counts() if dates is not None else pd.Series(dtype=int)})
        missing = NEEDED - cols
        print(f"{f.name:45s} {s:12s} {len(cols):2d} cols", "OK" if not missing else f"MISSING {sorted(missing)}")
        if missing:
            problems.append(f"{f.name}: missing columns {sorted(missing)}")
        if s in ("NOAA-20", "NOAA-21"):
            problems.append(f"{f.name}: {s} VIIRS file — use S-NPP only (avoids a new sensor jump); move it out of data/")
        if s == "unknown":
            problems.append(f"{f.name}: cannot tell the sensor from the file name")

    # NRT files whose dates overlap an archive file of the same sensor -> duplicates
    for n in (i for i in info if i["nrt"] and i["start"] is not None):
        for a in (i for i in info if not i["nrt"] and i["sensor"] == n["sensor"] and i["start"] is not None):
            if n["start"] <= a["end"] and a["start"] <= n["end"]:
                problems.append(f"{n['file']}: NRT dates {n['start']:%Y-%m-%d}..{n['end']:%Y-%m-%d} overlap archive "
                                f"{a['file']} — trim NRT to after {a['end']:%Y-%m-%d} to avoid double counting")

    for s in ("MODIS", "VIIRS S-NPP"):
        if not any(i["sensor"] == s for i in info):
            problems.append(f"no {s} files found — harmonization needs both MODIS and VIIRS S-NPP")

    print("\nRows per sensor and year:")
    counts = {}
    for i in info:
        for y, c in i["years"].items():
            counts[(i["sensor"], y)] = counts.get((i["sensor"], y), 0) + c
    table = pd.Series(counts).unstack(0).fillna(0).astype(int).sort_index()
    print(table.to_string())

    if problems:
        print("\nPROBLEMS:")
        for p in problems:
            print(" -", p)
        sys.exit(1)
    print("\nAll checks passed. Next: python fire_harmonize.py --modis '<modis glob>' --viirs '<viirs glob>'")


if __name__ == "__main__":
    main(*sys.argv[1:])

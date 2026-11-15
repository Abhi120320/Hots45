"""Alerts lite: early-warning statistics from the harmonized daily history.

Pure functions only (pandas in, dicts out), so a future daily job can call evaluate() with fresh FIRMS NRT
counts and hand the result to an email sender without touching the API layer.

daily: pd.Series of hotspots per day (DatetimeIndex, zero-filled). Everything is cut at `asof` first, so a
simulated date never sees later data.
"""
import numpy as np
import pandas as pd

VIIRS_YEARS = (2012, 2025)  # baseline years: VIIRS era only (no MODIS conversion uncertainty)
MIN_HOTSPOTS = 20
RANK = {"Info": 0, "Watch": 1, "Warning": 2, "Record": 3}


def _part(ts):
    return f"{'early' if ts.day <= 10 else 'mid' if ts.day <= 20 else 'late'} {ts.strftime('%B')}"


def window_sums(daily, asof, days, years):
    """Sum of the `days`-day window ending at asof's month-day, for each baseline year (skipping missing years)."""
    out = {}
    for y in range(years[0], years[1] + 1):
        try:
            end = asof.replace(year=y)
        except ValueError:  # 29 Feb
            end = asof.replace(year=y, day=28)
        start = end - pd.Timedelta(days=days - 1)
        if start >= daily.index[0] and end <= daily.index[-1] and y != asof.year:
            out[y] = float(daily[start:end].sum())
    return out


def unusual(daily, asof, days=7, years=VIIRS_YEARS):
    """Last `days` days vs the same window in baseline years. Watch: >= p90 or >= 2x median; Warning: >= p97 or >= 3x."""
    cur = float(daily[asof - pd.Timedelta(days=days - 1):asof].sum())
    base = np.array(list(window_sums(daily, asof, days, years).values()))
    if len(base) < 5 or cur < MIN_HOTSPOTS:
        return None
    med, p90, p97 = np.median(base), np.percentile(base, 90), np.percentile(base, 97)
    ratio = cur / med if med > 0 else float("inf")
    # strict ">" on percentiles: with a flat baseline p90 == median, and normal activity must not alert
    sev = "Warning" if (cur > p97 or ratio >= 3) else "Watch" if (cur > p90 or ratio >= 2) else None
    if not sev:
        return None
    return {"kind": "unusual", "severity": sev, "hotspots": round(cur), "median": round(float(med), 1),
            "ratio": None if np.isinf(ratio) else round(ratio, 1), "window": [str((asof - pd.Timedelta(days=days - 1)).date()), str(asof.date())],
            "message": f"{cur:,.0f} hotspots in the last {days} days, "
                       + (f"{ratio:.1f}× the usual for {_part(asof)}" if np.isfinite(ratio) else f"none usual for {_part(asof)}")}


def season_stats(daily, asof):
    """Typical start/peak/end day-of-year: when cumulative yearly hotspots reach 10/50/90%, median across complete years before asof."""
    d = daily[:asof]
    rows = []
    for y, s in d.groupby(d.index.year):
        if y >= asof.year or len(s) < 360 or s.sum() <= 0:
            continue
        c = s.cumsum() / s.sum()
        rows.append([int(c.searchsorted(q)) + 1 for q in (0.1, 0.5, 0.9)])
    if len(rows) < 3:
        return None
    start, peak, end = (int(v) for v in np.median(np.array(rows), axis=0))
    return {"start": start, "peak": peak, "end": end, "years": len(rows)}


def season(daily, asof):
    st = season_stats(daily, asof)
    if not st:
        return None
    doy = asof.dayofyear
    md = lambda n: (pd.Timestamp(f"{asof.year}-01-01") + pd.Timedelta(days=n - 1)).strftime("%-d %b")  # noqa: E731
    if 0 <= st["start"] - doy <= 14:
        return {"kind": "season", "severity": "Info", "message": f"Fire season usually starts around {md(st['start'])} (in {st['start'] - doy} days); peak around {md(st['peak'])}.", **st}
    if abs(st["peak"] - doy) <= 7:
        return {"kind": "season", "severity": "Watch", "message": f"Typical peak of the fire season ({md(st['peak'])}) is within a week.", **st}
    return None


def record(daily, asof, days=30):
    """Last `days` days are the highest for that window in the whole record."""
    cur = float(daily[asof - pd.Timedelta(days=days - 1):asof].sum())
    prev = window_sums(daily, asof, days, (daily.index[0].year, asof.year - 1))
    if cur < MIN_HOTSPOTS or len(prev) < 5 or cur <= max(prev.values()):
        return None
    return {"kind": "record", "severity": "Record", "hotspots": round(cur),
            "message": f"Highest {_part(asof)} activity since {min(prev)} ({cur:,.0f} hotspots in {days} days; previous high {max(prev.values()):,.0f} in {max(prev, key=prev.get)})."}


def evaluate(daily, asof, gaps=(), provisional=()):
    """All alerts for one area as of `asof` (inclusive). gaps: [(start, end)] date strings; provisional: ['YYYY-MM'].
    Alerts whose window overlaps a data gap are down-graded one level; NRT-based alerts are flagged provisional."""
    asof = pd.Timestamp(asof)
    d = daily[:asof]  # the cutoff: nothing after asof is ever used
    if d.empty:
        return []
    out = [a for a in (unusual(d, asof), season(d, asof), record(d, asof)) if a]
    w0 = asof - pd.Timedelta(days=29)
    for a in out:
        a["asof"] = str(asof.date())
        a["provisional"] = any(w0.strftime("%Y-%m") <= m <= asof.strftime("%Y-%m") for m in provisional)
        hit = [g for g in gaps if pd.Timestamp(g[0]) <= asof and pd.Timestamp(g[1]) >= w0]
        if hit and a["severity"] in ("Watch", "Warning"):
            a["severity"] = {"Warning": "Watch", "Watch": "Info"}[a["severity"]]
            a["message"] += " (down-graded: overlaps a satellite data gap)"
    return sorted(out, key=lambda a: -RANK[a["severity"]])

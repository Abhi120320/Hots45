"""Fire outlook: a simple, transparent statistical forecast of monthly harmonized hotspots, with a leak-free backtest.

Pure functions (pandas in, dicts out). Every forecast takes a cutoff month C and uses ONLY months <= C, so the
backtest never sees the future (test_outlook.py checks this by corrupting the future and comparing forecasts).

Model for target month T = C + h (h = 1..3):
  baseline   median and 10th-90th percentile of the same calendar month in VIIRS-era years before T
  trend      Sen's slope of yearly totals over the last 10 complete years, applied only if Mann-Kendall p < 0.05
  persistence r = last 3 complete months vs the baseline median for those months; forecast x r**w_h, where w_h
             (one per horizon) is the weight that gave the lowest error on earlier backtest forecasts only
  range      80% range from the model's own earlier errors at that horizon: 10th-90th percentile of
             log((actual+1)/(forecast+1)) over backtest forecasts already verified at the cutoff (>= 24 of them);
             before that, baseline p10-p90 x the same factors. Baseline percentiles alone were too narrow (~50% coverage).
Reference ("historical median"): median and p10-p90 of the same calendar month in every earlier year of the record.
"""
import math

import numpy as np
import pandas as pd

WEIGHTS = (0.0, 0.25, 0.5, 0.75, 1.0)
HORIZONS = (1, 2, 3)
MIN_YEARS = 3  # baseline values needed for a forecast
MIN_ERRORS = 24  # verified past forecasts needed to set the range from errors
BACKTEST = ("2015-01", "2025-12")  # target months scored (clamped to the cutoff)
DISCLAIMER = "Statistical outlook based on past satellite data; does not include weather forecasts; not an official forecast."


def add_months(m, k):
    p = pd.Period(m, "M") + k
    return p.strftime("%Y-%m")


# ---------- statistics ----------
def sen_slope(y):
    """Median of pairwise slopes (Theil-Sen) for equally spaced values."""
    y = np.asarray(y, float)
    i, j = np.triu_indices(len(y), 1)
    return float(np.median((y[j] - y[i]) / (j - i))) if len(y) > 1 else 0.0


def mann_kendall_p(y):
    """Two-sided p-value of the Mann-Kendall trend test (normal approximation, tie-corrected variance)."""
    y = np.asarray(y, float)
    n = len(y)
    if n < 4:
        return 1.0
    i, j = np.triu_indices(n, 1)
    s = float(np.sign(y[j] - y[i]).sum())
    _, counts = np.unique(y, return_counts=True)
    var = (n * (n - 1) * (2 * n + 5) - sum(t * (t - 1) * (2 * t + 5) for t in counts)) / 18
    if var <= 0:
        return 1.0
    z = (s - np.sign(s)) / math.sqrt(var)
    return math.erfc(abs(z) / math.sqrt(2))


def p_above(pred, lo, hi, normal):
    """P(actual > normal) if the forecast is log-normal with 10th/90th percentiles lo/hi (+1 so zeros work)."""
    mu = math.log(pred + 1)
    sigma = (math.log(hi + 1) - math.log(lo + 1)) / (2 * 1.2816)
    if sigma <= 1e-9:
        return 1.0 if pred > normal else 0.0
    z = (math.log(normal + 1) - mu) / sigma
    return 0.5 * math.erfc(z / math.sqrt(2))


# ---------- forecasts ----------
def _same_month(s, target, first_month):
    """Values of target's calendar month in earlier years, from first_month on."""
    cal = target[5:]
    v = s[(s.index.str[5:] == cal) & (s.index < target) & (s.index >= first_month)]
    return v.to_numpy(float)


def reference(s, cutoff, target):
    """Historical-median reference: same calendar month, every earlier year of the record."""
    v = _same_month(s[s.index <= cutoff], target, s.index[0])
    if len(v) < MIN_YEARS:
        return None
    return {"pred": float(np.median(v)), "lo": float(np.percentile(v, 10)), "hi": float(np.percentile(v, 90))}


def components(s, cutoff, target, viirs_start):
    """Model parts for one target, from months <= cutoff only: baseline, trend factor, persistence ratio."""
    s = s[s.index <= cutoff]
    v = _same_month(s, target, viirs_start)
    if len(v) < MIN_YEARS:
        return None
    base = {"median": float(np.median(v)), "p10": float(np.percentile(v, 10)), "p90": float(np.percentile(v, 90)), "years": len(v)}
    # trend: yearly totals of the last 10 complete calendar years
    years = s.groupby(s.index.str[:4]).agg(["sum", "count"])
    full = years[years["count"] == 12]["sum"].iloc[-10:]
    slope, p, factor = 0.0, 1.0, 1.0
    if len(full) >= 5:
        slope, p = sen_slope(full.values), mann_kendall_p(full.values)
        if p < 0.05 and np.median(full.values) > 0:
            # trend line evaluated at the target year, relative to its value at the baseline's middle year
            mid_year = np.median([int(target[:4]) - k for k in range(1, len(v) + 1)])
            factor = float(np.clip(1 + slope * (int(target[:4]) - mid_year) / np.median(full.values), 1 / 3, 3))
    # persistence: last 3 complete months vs their own baseline medians (each from years before that month)
    recent = [add_months(cutoff, -k) for k in range(3)]
    norm = [_same_month(s, m, viirs_start) for m in recent]
    if all(len(n) >= MIN_YEARS for n in norm) and all(m in s.index for m in recent):
        act, nrm = sum(float(s[m]) for m in recent), sum(float(np.median(n)) for n in norm)
        ratio = float(np.clip((act + 1) / (nrm + 1), 0.2, 5))
    else:
        ratio = 1.0
    return {"baseline": base, "trend": {"slope_per_year": slope, "p": p, "applied": factor != 1.0, "factor": factor},
            "persistence": {"ratio": ratio}}


def model(comp, w):
    f = comp["trend"]["factor"] * comp["persistence"]["ratio"] ** w
    b = comp["baseline"]
    pred, lo, hi = b["median"] * f, b["p10"] * f, b["p90"] * f
    return {"pred": pred, "lo": min(lo, pred), "hi": max(hi, pred)}


def calibrate(f, w, past):
    """Replace f's range by the 10th-90th percentile of past log errors for weight w (past: [(actual, {w: forecast})])."""
    if len(past) < MIN_ERRORS:
        return f
    e = np.log([(a + 1) / (p[w]["pred"] + 1) for a, p in past])
    q10, q90 = np.percentile(e, 10), np.percentile(e, 90)
    lo, hi = (f["pred"] + 1) * math.exp(min(q10, 0)) - 1, (f["pred"] + 1) * math.exp(max(q90, 0)) - 1
    return {"pred": f["pred"], "lo": max(0.0, lo), "hi": hi}


# ---------- backtest ----------
def backtest(s, viirs_start, first_target="2015-01", last_target=None):
    """Every month first_target..last_target, horizons 1-3, each forecast from data before it only. The persistence
    weight for a forecast is learned from forecasts whose targets were already observed at its cutoff."""
    last_target = last_target or s.index[-1]
    cut0 = add_months(viirs_start, 12)  # earliest cutoff with a usable baseline: weight history starts here
    rows = []
    for h in HORIZONS:
        cands = []  # (cutoff, target, actual, {w: forecast})
        c = cut0
        while add_months(c, h) <= last_target:
            t = add_months(c, h)
            comp = components(s, c, t, viirs_start)
            if comp:
                cands.append((c, t, float(s[t]), {w: model(comp, w) for w in WEIGHTS}))
            c = add_months(c, 1)
        for i, (c, t, actual, preds) in enumerate(cands):
            if t < first_target:
                continue
            past = [(x[2], x[3]) for x in cands[:i] if x[1] <= c]  # targets already observed at this cutoff: no leak
            w = best_weight(past)
            ref = reference(s, c, t)
            if not ref:
                continue
            m = calibrate(preds[w], w, past)
            rows.append({"h": h, "cutoff": c, "target": t, "actual": actual, "w": w, "calibrated": len(past) >= MIN_ERRORS, **{f"m_{k}": m[k] for k in m},
                         **{f"r_{k}": ref[k] for k in ref}, **{f"pw_{ww}": preds[ww]["pred"] for ww in WEIGHTS}})
    return pd.DataFrame(rows)


def best_weight(past):
    """past: [(actual, {w: forecast})]. Lowest mean absolute error; ties go to the weight nearest 0.5."""
    if not past:
        return 0.5
    return min(WEIGHTS, key=lambda w: (np.mean([abs(f[w]["pred"] - a) for a, f in past]), abs(w - 0.5)))


def scores(bt):
    """MAE and 80%-range coverage for the model and the reference, overall and per horizon."""
    def one(d):
        inside = lambda p, x=d: float(((x.actual >= x[f"{p}_lo"]) & (x.actual <= x[f"{p}_hi"])).mean() * 100) if len(x) else None  # noqa: E731
        cal = d[d.calibrated]
        return {"n": int(len(d)), "mae_model": float((d.m_pred - d.actual).abs().mean()), "mae_reference": float((d.r_pred - d.actual).abs().mean()),
                "coverage_model": inside("m"), "coverage_reference": inside("r"),
                # ranges set from >= MIN_ERRORS verified past errors (after the warm-up years)
                "coverage_model_calibrated": inside("m", cal), "n_calibrated": int(len(cal)),
                "calibrated_from": cal.target.min() if len(cal) else None}
    if bt.empty:
        return None
    out = one(bt)
    out["by_horizon"] = {int(h): one(d) for h, d in bt.groupby("h")}
    out["skill"] = 1 - out["mae_model"] / out["mae_reference"] if out["mae_reference"] > 0 else 0.0
    out["period"] = [bt.target.min(), bt.target.max()]
    return out


# ---------- live outlook ----------
def label(p):
    """'likely above normal (60-80% chance)' from P(above normal)."""
    q, side = (p, "above") if p >= 0.5 else (1 - p, "below")
    if q < 0.6:
        return "near normal (no clear signal)"
    band = "60–80%" if q < 0.8 else "over 80%"
    return f"{'likely' if q < 0.8 else 'very likely'} {side} normal ({band} chance)"


def outlook(s, cutoff, viirs_start, bt=None):
    """Forecast for cutoff+1..+3. Each horizon uses the model only if it beat the reference at that horizon in the
    backtest; otherwise the historical median (reference) is shown."""
    bt = backtest(s[s.index <= cutoff], viirs_start) if bt is None else bt
    sc = scores(bt)
    s = s[s.index <= cutoff]
    out = []
    for h in HORIZONS:
        hs = (sc or {}).get("by_horizon", {}).get(h)
        use_model = bool(hs and hs["mae_model"] < hs["mae_reference"])
        t = add_months(cutoff, h)
        comp = components(s, cutoff, t, viirs_start)
        ref = reference(s, cutoff, t)
        if not comp or not ref:
            continue
        past = bt[bt.h == h] if not bt.empty else bt
        w = best_weight([(r["actual"], {ww: {"pred": r[f"pw_{ww}"]} for ww in WEIGHTS}) for _, r in past.iterrows()]) if use_model else 0.5
        f = calibrate(model(comp, w), w, [(r["actual"], {ww: {"pred": r[f"pw_{ww}"]} for ww in WEIGHTS}) for _, r in past.iterrows()]) if use_model else ref
        normal = comp["baseline"]["median"]  # "normal" = VIIRS-era median for the month
        pa = p_above(f["pred"], f["lo"], f["hi"], normal)
        out.append({"month": t, "horizon": h, "pred": round(f["pred"], 1), "lo": round(f["lo"], 1), "hi": round(f["hi"], 1),
                    "normal": round(normal, 1), "p_above": round(pa, 3), "text": label(pa), "weight": w if use_model else None,
                    "using": "model" if use_model else "reference",
                    "trend": comp["trend"], "persistence": comp["persistence"], "baseline_years": comp["baseline"]["years"]})
    used = {m["using"] for m in out}
    return {"cutoff": cutoff, "using": used.pop() if len(used) == 1 else "mixed", "months": out, "backtest": sc, "disclaimer": DISCLAIMER}


# ---------- season dates ----------
def season_dates(daily, cutoff_day, first_year):
    """Typical start / peak / end of the next fire season with a 10-90% range, from each complete VIIRS-era season:
    a season runs while the 15-day mean stays >= 25% of that season's peak, around the climatological peak day."""
    d = daily[:cutoff_day]
    if d.sum() <= 0:
        return None
    clim = d.groupby(d.index.strftime("%m-%d")).mean().drop("02-29", errors="ignore")
    sm = pd.concat([clim] * 3).rolling(15, center=True).mean().iloc[len(clim):2 * len(clim)]
    peak_md = sm.idxmax()
    offs = []
    for y in range(first_year, cutoff_day.year + 1):
        c = pd.Timestamp(f"{y}-{peak_md}")
        lo_, hi_ = c - pd.Timedelta(days=182), c + pd.Timedelta(days=182)
        if lo_ < d.index[0] or hi_ > d.index[-1]:
            continue  # incomplete season
        w = d[lo_:hi_].rolling(15, center=True, min_periods=1).mean()
        core = w[c - pd.Timedelta(days=60):c + pd.Timedelta(days=60)]
        if core.max() <= 0:
            continue
        pk = core.idxmax()
        above = w >= 0.25 * core.max()
        st, en = pk, pk
        while st - pd.Timedelta(days=1) >= lo_ and above[st - pd.Timedelta(days=1)] and (pk - st).days < 150:
            st -= pd.Timedelta(days=1)
        while en + pd.Timedelta(days=1) <= hi_ and above[en + pd.Timedelta(days=1)] and (en - pk).days < 150:
            en += pd.Timedelta(days=1)
        offs.append([(st - c).days, (pk - c).days, (en - c).days])
    if len(offs) < MIN_YEARS:
        return None
    o = np.array(offs)
    # next season: the first climatological peak whose season end is after the cutoff
    c = pd.Timestamp(f"{cutoff_day.year - 1}-{peak_md}")
    while c + pd.Timedelta(days=int(np.median(o[:, 2]))) < cutoff_day:
        c = pd.Timestamp(f"{c.year + 1}-{peak_md}")
    day = lambda k: (c + pd.Timedelta(days=int(round(k)))).strftime("%Y-%m-%d")  # noqa: E731
    out = {name: {"date": day(np.median(o[:, i])), "lo": day(np.percentile(o[:, i], 10)), "hi": day(np.percentile(o[:, i], 90))}
           for i, name in enumerate(("start", "peak", "end"))}
    out["years"] = len(offs)
    out["underway"] = pd.Timestamp(out["start"]["date"]) <= cutoff_day
    return out

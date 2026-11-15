// Cividis (colour-blind-safe sequential). We use its upper 70% on the map so low counts stay visible on dark imagery.
export const CIVIDIS = ['#00224e', '#123570', '#3b496c', '#575d6d', '#707173', '#8a8779', '#a69d75', '#c4b56c', '#e4cf5b', '#fee838']
export const MAP_RAMP = CIVIDIS.slice(3)

function hex(c: string): [number, number, number] {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
}

/** t in [0,1] -> RGB along ramp */
export function rampColor(t: number, ramp = MAP_RAMP): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (ramp.length - 1)
  const i = Math.min(ramp.length - 2, Math.floor(x))
  const a = hex(ramp[i]), b = hex(ramp[i + 1]), f = x - i
  return [0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * f)) as [number, number, number]
}

/** log scale so a few huge cells don't wash out the rest */
export const logNorm = (v: number, max: number) => (max > 0 ? Math.log1p(v) / Math.log1p(max) : 0)

export const SERIES = { harmonized: '#E6E8EB', modis: '#56B4E9', viirs: '#009E73', median: '#9AA3AE', anomaly: '#E8743B' }
export const ACCENT = '#E8743B'
export const BELOW = '#56B4E9'

export const fmt = (v: number | null | undefined, d = 0) =>
  v == null || Number.isNaN(v) ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const monthLabel = (m: string) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`

export function monthsBetween(first: string, last: string) {
  const out: string[] = []
  let y = +first.slice(0, 4), m = +first.slice(5, 7)
  const ey = +last.slice(0, 4), em = +last.slice(5, 7)
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    if (++m > 12) { m = 1; y++ }
  }
  return out
}

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

// ColorBrewer YlOrRd, 6 classes (colour-blind safe, sequential): darkest red = most fires
export const YLORRD6 = ['#ffffb2', '#fed976', '#feb24c', '#fd8d3c', '#f03b20', '#bd0026']
export const CLASS_ALPHA = [120, 160, 195, 220, 240, 255] // low classes fade so they read as background
// ColorBrewer RdBu, reversed so red = more fires than usual, blue = fewer
export const RDBU7 = ['#2166ac', '#67a9cf', '#d1e5f0', '#f7f7f7', '#fddbc7', '#ef8a62', '#b2182b']

export const rgb = (c: string): [number, number, number] => hex(c)

/** Nearest-rank quantile of an ascending-sorted array. */
export const quantile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))] : 0

/**
 * Hide the bottom `minPct`% of non-zero cells, then split the rest into up to 6 quantile classes.
 * Returns the threshold, the class breaks (lower bound of each class) and a classifier.
 */
export function classify(values: number[], minPct: number) {
  const nz = values.filter(v => v > 0).sort((a, b) => a - b)
  let threshold = Math.max(quantile(nz, minPct / 100), nz.length ? nz[0] : 0)
  // ties (e.g. most cells = 1) can push the quantile up to the max; cap it below the max so the view never empties
  const below = nz.filter(v => v < nz[nz.length - 1])
  if (nz.length && threshold >= nz[nz.length - 1] && below.length) threshold = below[below.length - 1]
  const shown = nz.filter(v => v >= threshold)
  const breaks = [threshold]
  for (let i = 1; i < 6; i++) {
    const b = quantile(shown, i / 6)
    if (b > breaks[breaks.length - 1]) breaks.push(b)
  }
  const classOf = (v: number) => { let c = 0; while (c + 1 < breaks.length && v >= breaks[c + 1]) c++; return c }
  // spread the available classes over the full ramp so few classes still span light -> dark
  const colorIdx = (c: number) => (breaks.length === 1 ? 5 : Math.round((c * 5) / (breaks.length - 1)))
  return { threshold, breaks, max: shown.length ? shown[shown.length - 1] : 0, shown: shown.length, total: nz.length, classOf, colorIdx }
}

/** log2 ratio of current to baseline, clipped to ±2 (4×), mapped to 0..1 for the diverging ramp */
export const ratioT = (cur: number, base: number) => (Math.max(-2, Math.min(2, Math.log2((cur + 1) / (base + 1)))) + 2) / 4

/**
 * Fixed scale: class breaks from the full record's monthly cell values (quantiles from /api/scale), so a quiet
 * month looks pale and a peak season red whatever period is shown. `values` must already be per month.
 */
export function classifyFixed(values: number[], q: Record<string, number>, minPct: number) {
  const qv = (p: number) => q[String(+p.toFixed(3))] ?? 0
  const threshold = Math.max(qv(minPct / 100), 1e-9)
  const breaks = [threshold]
  for (const p of [0.5, 0.7, 0.85, 0.95, 0.99]) if (qv(p) > breaks[breaks.length - 1]) breaks.push(qv(p))
  const nz = values.filter(v => v > 0)
  const classOf = (v: number) => { let c = 0; while (c + 1 < breaks.length && v >= breaks[c + 1]) c++; return c }
  const colorIdx = (c: number) => (breaks.length === 1 ? 5 : Math.round((c * 5) / (breaks.length - 1)))
  // heights are linear up to 2x the 99.5th percentile, then capped, so one extreme cell can't flatten the rest
  return { threshold, breaks, max: qv(0.995) * 2, shown: nz.filter(v => v >= threshold).length, total: nz.length, classOf, colorIdx }
}

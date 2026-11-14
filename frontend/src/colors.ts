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

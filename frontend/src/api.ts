import { useEffect, useState } from 'react'

export const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''

export type BBox = [number, number, number, number] // lon0, lat0, lon1, lat1

export interface Meta {
  grid_deg: number
  first_month: string
  last_month: string
  viirs_start: string
  factor_global: number
  factor_by_month: Record<string, number>
  r2_overlap: number
  method: string
  data_source: 'synthetic_sample' | 'nasa_firms' | string
  region?: string | null
  last_complete_month?: string
  tile_deg?: number
  factor_by_tile?: Record<string, { k: Record<string, number>; n: Record<string, number> }>
  tile_months_fallback?: number
  rows?: Record<string, { raw: number; nrt_overlap?: number; duplicates: number; clean: number }>
  fit_window?: [string, string]
  data_gaps?: { sensor: string; start: string; end: string }[]
  gap_months?: string[]
  provisional_months?: string[]
  month_notes?: Record<string, string>
  coverage_bbox?: BBox
  has_boundaries?: boolean
  frp?: {
    unit: string; factor_global: number; factor_by_month: Record<string, number>; r2_overlap: number; fit_window: [string, string]
    method: string; tile_months_fallback: number
    regions?: Record<string, { r2_fit: number | null; yearly_ratio_cv?: number | null }>
    tiles?: { tile: string; share_of_viirs_frp: number; r2: number | null; yearly_ratio_cv: number | null; yearly_ratio_range: [number, number] | null; unreliable: boolean }[]
  }
  land_cover?: { product: string; note: string; map_years: number[]; groups: LcGroup[]; classes: Record<string, string> }
}

/** /api/intensity: per-sensor FRP per hotspot (never harmonized) */
export interface Intensity { unit: string; note: string; sensors: Record<'MODIS' | 'VIIRS', { n: number; mean: number; p90: number; total: number } | null> }

/** /api/outlook: statistical outlook for the next 1-3 months, with its backtest (see backend/outlook.py) */
export interface OutlookMonth {
  month: string; horizon: number; pred: number; lo: number; hi: number; normal: number; p_above: number; text: string
  using: 'model' | 'reference'; weight: number | null
  trend: { slope_per_year: number; p: number; applied: boolean; factor: number }; persistence: { ratio: number }
}
interface Score { n: number; mae_model: number; mae_reference: number; coverage_model: number; coverage_reference: number; coverage_model_calibrated: number | null; n_calibrated: number; calibrated_from: string | null }
export interface Outlook {
  cutoff: string; using: 'model' | 'reference' | 'mixed'; months: OutlookMonth[]; disclaimer: string
  backtest: (Score & { skill: number; period: [string, string]; by_horizon: Record<string, Score> }) | null
  season: { start: { date: string; lo: string; hi: string }; peak: { date: string; lo: string; hi: string }; end: { date: string; lo: string; hi: string }; years: number; underway: boolean } | null
  provisional_inputs: string[]; gap_inputs: string[]
}

export interface LcGroup { key: string; label: string; classes: number[] }

/** /api/landcover: harmonized hotspots per land-cover group in an area and period */
export interface LandCover { total: number; groups: (LcGroup & { hotspots: number; share: number })[]; text: string; note: string }

export interface Cell { lon: number; lat: number; hotspots: number; modis: number; viirs: number; lc?: number; lc_share?: number; frp?: number }

export interface AnomalyCell { lon: number; lat: number; current: number; baseline: number; diff: number; z: number }

export interface SeriesRow {
  month: string
  hotspots: number
  modis: number
  viirs: number
  modis_scaled: number
  hist_median: number
  pct_vs_median: number | null
  mean: number
  std: number
  z: number
  flag: '' | 'unusually high' | 'unusually low'
  source: 'MODIS-scaled' | 'VIIRS'
  note: string
}

export interface Summary {
  start: string
  end: string
  total: number
  peak_month: string | null
  peak_month_hotspots: number
  peak_year: string | null
  peak_year_hotspots: number
  busiest_calendar_month: number | null
  busiest_calendar_month_mean: number
  latest_month: string
  latest_hotspots: number
  latest_hist_median: number
  latest_pct_vs_median: number | null
  anomalous_months: number
}

export function url(path: string, params: Record<string, string | number | BBox | undefined>) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, Array.isArray(v) ? v.join(',') : String(v))
  const s = q.toString()
  return `${API}${path}${s ? `?${s}` : ''}`
}

// shortcut: unbounded in-memory cache, fine for one session; add LRU if memory grows on long sessions
const cache = new Map<string, Promise<unknown>>()

function get<T>(u: string): Promise<T> {
  if (!cache.has(u)) {
    const p = fetch(u).then(async r => {
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? `HTTP ${r.status}`)
      return r.json()
    })
    p.catch(() => cache.delete(u)) // let failed requests retry
    cache.set(u, p)
  }
  return cache.get(u) as Promise<T>
}

export function prefetch(u: string) { get(u).catch(() => {}) }

export interface Loadable<T> { data?: T; error?: string; loading: boolean }

/** Fetch u (debounced, cached). Data is only returned for the current u, so a panel never shows the previous
 *  area's numbers under a new name; map layers pass keepStale to keep drawing the old view while panning. */
/** keepStale: true keeps the last data while a new URL loads; a string keeps it only while that key is unchanged
 *  (e.g. period + grid, so panning keeps the map but a new month never shows the old month's cells). */
export function useApi<T>(u: string | null, debounceMs = 0, keepStale: boolean | string = false): Loadable<T> {
  const [state, set] = useState<Loadable<T> & { for?: string; key?: string }>({ loading: !!u })
  const key = typeof keepStale === 'string' ? keepStale : undefined
  useEffect(() => {
    if (!u) return
    let live = true
    set(s => ({ data: s.data, for: s.for, key: s.key, loading: true }))
    const t = setTimeout(() => {
      get<T>(u).then(
        data => live && set({ data, for: u, key, loading: false }),
        e => live && set(s => ({ data: s.data, for: s.for, key: s.key, error: String(e.message ?? e), loading: false })),
      )
    }, cache.has(u) ? 0 : debounceMs)
    return () => { live = false; clearTimeout(t) }
  }, [u, debounceMs, key])
  if (keepStale === true || state.for === u || (key !== undefined && state.key === key)) return state
  return { loading: !!u && !state.error, error: state.error }
}

/** An admin unit (country / state / district) or a radius around a place, as returned by /api/search and /api/region */
export interface Region {
  id: string // 'a<id>' admin unit, 'c<lon>,<lat>,<km>' radius
  name: string
  kind: string // Country, State, Province, District, Regency, Radius…
  level: number // 0 country, 1 state, 2 district, 3 radius
  parent: string // "Punjab, India"
  bbox: BBox
  label: [number, number]
  rings?: [number, number][][]
  in_coverage?: boolean
}

export interface Place {
  name: string
  type: string
  lon: number
  lat: number
  state?: string | null
  country?: string | null
  in_coverage: boolean
  district_id?: string | null
  state_id?: string | null
  country_id?: string | null
  district?: string | null
}

export interface Boundaries { lines: [number, number][][]; labels: { id: string; name: string; pos: [number, number]; area: number }[] }

export interface CellInfo {
  lon: number; lat: number
  country?: string | null; state?: string | null; district?: string | null
  current: number | null; median: number | null; pct_vs_median: number | null
}

export interface TopArea extends Region { hotspots: number; share: number }

/** Region label shown in chips and headers: "Punjab, India" */
export const regionLabel = (r: Pick<Region, 'name' | 'parent'>) => [r.name, r.parent].filter(Boolean).join(', ')

/** Area for analytics: an admin/radius region, or a rectangle */
export type Area = { region: Region } | { bbox: BBox } | null
export const areaParams = (a: Area): { region?: string; bbox?: BBox } =>
  !a ? {} : 'region' in a ? { region: a.region.id } : { bbox: a.bbox }

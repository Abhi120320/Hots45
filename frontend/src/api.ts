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
}

export interface Cell { lon: number; lat: number; hotspots: number; modis: number; viirs: number }

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

/** Fetch u (debounced, cached). Keeps the previous data while the next request loads. */
export function useApi<T>(u: string | null, debounceMs = 0): Loadable<T> {
  const [state, set] = useState<Loadable<T>>({ loading: !!u })
  useEffect(() => {
    if (!u) return
    let live = true
    set(s => ({ data: s.data, loading: true }))
    const t = setTimeout(() => {
      get<T>(u).then(
        data => live && set({ data, loading: false }),
        e => live && set(s => ({ data: s.data, error: String(e.message ?? e), loading: false })),
      )
    }, cache.has(u) ? 0 : debounceMs)
    return () => { live = false; clearTimeout(t) }
  }, [u, debounceMs])
  return state
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

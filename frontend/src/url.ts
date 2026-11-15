// Shareable URLs: /view/<chart>?area=…&start=YYYY-MM&end=YYYY-MM&mode=month|range (also used on the main map page).
import { useCallback, useEffect, useState } from 'react'
import type { Area, BBox } from './api'

export const CHARTS = ['calendar', 'timeline', 'monthly', 'before-after'] as const
export type ChartKey = (typeof CHARTS)[number]
export const CHART_TITLES: Record<ChartKey, string> = {
  calendar: 'Burning calendar', timeline: 'Timeline', monthly: 'Monthly hotspots', 'before-after': 'Before vs after harmonization',
}

export interface Route { chart: ChartKey | null; params: URLSearchParams }

const parse = (): Route => {
  const m = location.pathname.match(/^\/view\/([a-z-]+)\/?$/)
  const chart = m && (CHARTS as readonly string[]).includes(m[1]) ? (m[1] as ChartKey) : null
  return { chart, params: new URLSearchParams(location.search) }
}

/** Minimal router: the current route, and navigate() that pushes history (popstate keeps them in sync). */
export function useRoute() {
  const [route, setRoute] = useState<Route>(parse)
  useEffect(() => {
    const on = () => setRoute(parse())
    addEventListener('popstate', on)
    return () => removeEventListener('popstate', on)
  }, [])
  const navigate = useCallback((href: string, replace = false) => {
    if (replace) history.replaceState(null, '', href); else history.pushState(null, '', href)
    setRoute(parse())
  }, [])
  return { route, navigate }
}

const slug = (s: string) => s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_]+/g, '-')

/** area param: "a109-punjab-india" (region id + readable slug), "c75.85,30.9,25" (radius) or "b74,29,76,31" (box) */
export function encodeArea(a: Area): string | undefined {
  if (!a) return undefined
  if ('bbox' in a) return `b${a.bbox.map(v => +v.toFixed(3)).join(',')}`
  return a.region.id.startsWith('a') ? `${a.region.id}-${slug([a.region.name, a.region.parent].filter(Boolean).join(' '))}` : a.region.id
}

export function decodeArea(v: string | null): { region: string } | { bbox: BBox } | null {
  if (!v) return null
  if (v[0] === 'b') {
    const n = v.slice(1).split(',').map(Number)
    return n.length === 4 && n.every(x => !Number.isNaN(x)) ? { bbox: n as BBox } : null
  }
  if (v[0] === 'a') { const m = v.match(/^a\d+/); return m ? { region: m[0] } : null }
  if (v[0] === 'c') return { region: v }
  return null
}

export function stateQuery(o: { area: Area; start: string; end: string; mode: string }) {
  const q = new URLSearchParams()
  const a = encodeArea(o.area)
  if (a) q.set('area', a)
  q.set('start', o.start)
  q.set('end', o.end)
  q.set('mode', o.mode)
  return q.toString()
}

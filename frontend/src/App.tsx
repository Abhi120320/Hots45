import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { FlyToInterpolator, WebMercatorViewport } from '@deck.gl/core'
import { areaParams, prefetch, regionLabel, url, useApi, type AnomalyCell, type Area, type BBox, type Cell, type Meta, type SeriesRow } from './api'
import { fmt, monthLabel, monthsBetween, reducedMotion } from './colors'
import Earth, { GLOBE_MAX_ZOOM, IMAGERY, gridFor, type Imagery, type MapMode, type ScaleMode, type ViewState } from './Earth'
import Panel from './Panel'
import TimelineChart from './TimelineChart'
import ChartView from './ChartView'
import Alerts from './Alerts'
import { PRESETS } from './Area'
import { decodeArea, stateQuery, useRoute, type ChartKey } from './url'
import type { Region } from './api'
import { initTL, reduceTL, type TLAction } from './timeline'

const PANEL_KEY = 'hots45.panelWidth'
const panelMax = () => Math.min(900, Math.round(window.innerWidth * 0.6))

export default function App() {
  const meta = useApi<Meta>(url('/api/meta', {}))
  if (meta.error) return <Center>Could not reach the Hots45 API: {meta.error}</Center>
  if (!meta.data) return <Center>Loading record…</Center>
  return <Main meta={meta.data} />
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="h-full grid place-items-center text-dim" role="status">{children}</div>
}

function Main({ meta }: { meta: Meta }) {
  const months = useMemo(() => monthsBetween(meta.first_month, meta.last_month), [meta])
  const n = months.length

  const [viewState, setViewState] = useState<ViewState>({ longitude: 0, latitude: 15, zoom: 1.3, pitch: 0, bearing: 0 })
  const [interacted, setInteracted] = useState(false)
  const lastCompleteIdx = Math.max(0, months.indexOf(meta.last_complete_month ?? meta.last_month))
  const ctx = useMemo(() => ({ n, lastComplete: lastCompleteIdx }), [n, lastCompleteIdx])
  const { route, navigate } = useRoute()
  // one selection for the whole app (map, panel, calendar, timeline); see timeline.ts. Restored from the URL.
  const [tl, dispatch] = useReducer((s: ReturnType<typeof initTL>, a: TLAction) => reduceTL(s, a, ctx), ctx, c => {
    const s0 = initTL(c), q = route.params
    const a = months.indexOf(q.get('start') ?? ''), b = months.indexOf(q.get('end') ?? '')
    if (a < 0 || b < 0 || b < a) return s0
    return q.get('mode') === 'month' ? { ...s0, mode: 'month' as const, a: b, b } : { ...s0, a, b }
  })
  const [preview, setPreview] = useState<string | null>(null) // timeline hover: map shows that month
  const [area, setAreaState] = useState<Area>(null)
  const [drawing, setDrawing] = useState(false)
  const [panelOpen, setPanelOpen] = useState(true)
  const [panelW, setPanelW] = useState(() => { try { return Math.min(panelMax(), Math.max(340, +(localStorage.getItem(PANEL_KEY) ?? 440) || 440)) } catch { return 440 } })
  // Blue Marble suits the globe; the dark basemap lets data stand out on the 3D map. Each view keeps its own choice.
  const [imageryBy, setImageryBy] = useState<{ globe: Imagery; map: Imagery }>({ globe: 'blue', map: 'dark' })
  const [mapMode, setMapMode] = useState<MapMode>('hotspots')
  const [minPct, setMinPct] = useState(30)
  const [scaleMode, setScaleMode] = useState<ScaleMode>('fixed')
  const [spark, setSpark] = useState<SeriesRow[]>()

  const [start, end] = [months[tl.a], months[tl.b]] // the selection (panel, calendar, KPIs)
  const [mStart, mEnd] = [start, end] // map, legend, banner, KPIs and URL always show the selection; hover is only a hint
  const nMonths = tl.b - tl.a + 1
  const isMap = viewState.zoom >= GLOBE_MAX_ZOOM
  // the heatmap needs denser points than 1° to read as a smooth surface
  const grid = mapMode === 'heatmap' && isMap ? Math.min(gridFor(viewState.zoom), 0.25) : gridFor(viewState.zoom)
  const imagery = imageryBy[isMap ? 'map' : 'globe']
  const setImagery = (i: Imagery) => setImageryBy(s => ({ ...s, [isMap ? 'map' : 'globe']: i }))
  // Map view only loads the visible area, snapped outward to a coarse step so small pans hit the cache.
  const { longitude, latitude, zoom, pitch, bearing } = viewState
  const view = useMemo<BBox | undefined>(() => {
    if (zoom < GLOBE_MAX_ZOOM) return undefined
    const vp = new WebMercatorViewport({ longitude, latitude, zoom, pitch, bearing,
      width: Math.max(300, window.innerWidth - (panelOpen ? panelW : 0)), height: Math.max(300, window.innerHeight - 120) })
    const [w, s, e, n] = vp.getBounds()
    const step = grid * 40
    const snap = (v: number, f: (x: number) => number, lo: number, hi: number) => Math.min(hi, Math.max(lo, f(v / step) * step))
    return [snap(w, Math.floor, -180, 180), snap(s, Math.floor, -90, 90), snap(e, Math.ceil, -180, 180), snap(n, Math.ceil, -90, 90)]
  }, [longitude, latitude, zoom, pitch, bearing, grid, panelOpen, panelW])
  const cells = useApi<Cell[]>(url('/api/map', { start: mStart, end: mEnd, grid, bbox: view }), 150, true)
  const anomaly = useApi<AnomalyCell[]>(mapMode === 'anomaly' ? url('/api/anomaly', { start: mStart, end: mEnd, grid, bbox: view }) : null, 150, true)
  const scale = useApi<{ q: Record<string, number> }>(url('/api/scale', { grid }))
  const active = mapMode === 'anomaly' ? anomaly : cells

  const periodLabel = mStart === mEnd ? monthLabel(mStart) : `${monthLabel(mStart)} – ${monthLabel(mEnd)}`

  // During playback, warm the cache for the next month so frames don't stall.
  useEffect(() => {
    const nx = months[(tl.a + 1) % n]
    if (tl.playing) prefetch(url('/api/map', { start: nx, end: nx, grid, bbox: view }))
  }, [tl.playing, tl.a, n, months, grid, view])

  // Start the globe over the data's weighted centre, then rotate slowly until the user interacts.
  const [centred, setCentred] = useState(false)
  useEffect(() => {
    if (centred || interacted || !cells.data?.length) return
    const w = cells.data.reduce((s, c) => s + c.hotspots, 0) || 1
    const lon = cells.data.reduce((s, c) => s + c.lon * c.hotspots, 0) / w
    const lat = cells.data.reduce((s, c) => s + c.lat * c.hotspots, 0) / w
    setViewState(v => ({ ...v, longitude: lon - 40, latitude: Math.max(-40, Math.min(40, lat)) }))
    setCentred(true)
  }, [cells.data, centred, interacted])

  useEffect(() => {
    if (interacted || viewState.zoom >= GLOBE_MAX_ZOOM || reducedMotion()) return
    let raf = 0, last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(now - last, 100) / 1000 // seconds; capped so a background tab doesn't jump
      last = now
      setViewState(v => ({ ...v, longitude: v.longitude + 2.4 * dt }))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [interacted, viewState.zoom >= GLOBE_MAX_ZOOM])

  const panelOpenRef = useRef(panelOpen)
  panelOpenRef.current = panelOpen
  const panelWRef = useRef(panelW)
  panelWRef.current = panelW
  const flyTo = useCallback((b: BBox) => {
    setInteracted(true)
    const w = window.innerWidth - (panelOpenRef.current ? panelWRef.current : 0), h = window.innerHeight - 120
    const { longitude, latitude, zoom } = new WebMercatorViewport({ width: Math.max(w, 300), height: Math.max(h, 300) })
      .fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 60 })
    setViewState({
      longitude, latitude, zoom: Math.min(8.5, Math.max(zoom, GLOBE_MAX_ZOOM + 0.2)), pitch: 50, bearing: 0, // keep some context around small areas
      transitionDuration: reducedMotion() ? 0 : 1800, transitionInterpolator: new FlyToInterpolator({ speed: 1.6 }),
    })
  }, [])

  // select a rectangle or a region (state/district/country/radius) and fly to it
  const setArea = useCallback((a: Area) => {
    setAreaState(a)
    setDrawing(false)
    if (a) flyTo('region' in a ? a.region.bbox : a.bbox)
  }, [flyTo])
  const onDrawn = useCallback((b: BBox) => setArea({ bbox: b }), [setArea])
  const onInteract = useCallback(() => setInteracted(true), [])
  // calendar click: Month mode at that month
  const pickMonth = useCallback((m: string) => {
    const i = months.indexOf(m)
    if (i >= 0) dispatch({ type: 'month', i })
  }, [months])

  // map header: what the map shows, its total and how that compares with normal (selected area's series)
  const overlay = useMemo(() => {
    const r = (spark ?? []).filter(x => x.month >= mStart && x.month <= mEnd)
    if (!r.length) return null
    const total = r.reduce((s, x) => s + x.hotspots, 0), normal = r.reduce((s, x) => s + x.hist_median, 0)
    return { total, pct: normal > 0 ? ((total - normal) / normal) * 100 : null }
  }, [spark, mStart, mEnd])
  const areaName = area ? ('region' in area ? regionLabel(area.region) : PRESETS.find(pr => pr.bbox.join() === area.bbox.join())?.name ?? 'selected box') : (meta.region ?? 'full extent')
  const ap = useMemo(() => areaParams(area), [area])

  // ---------- URL: restore the area once, then keep the address bar in sync (shareable links) ----------
  useEffect(() => {
    const a = decodeArea(route.params.get('area'))
    if (!a) return
    if ('bbox' in a) setArea({ bbox: a.bbox })
    else fetch(url(`/api/region/${a.region}`, {})).then(r => (r.ok ? r.json() : null)).then((r: Region | null) => r && setArea({ region: r })).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const query = stateQuery({ area, start, end, mode: tl.mode })
  useEffect(() => { history.replaceState(null, '', `${route.chart ? `/view/${route.chart}` : '/'}?${query}`) }, [query, route.chart])
  const fromApp = useRef(false)
  const expand = useCallback((c: ChartKey) => {
    const href = `/view/${c}?${query}`
    return {
      href,
      onClick: (e: React.MouseEvent) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return // let the browser open a new tab
        e.preventDefault()
        fromApp.current = true
        navigate(href)
      },
    }
  }, [query, navigate])
  const back = useCallback(() => {
    if (fromApp.current) { fromApp.current = false; history.back() } else navigate(`/?${query}`)
  }, [navigate, query])
  const go = useCallback((c: ChartKey) => navigate(`/view/${c}?${query}`, true), [navigate, query]) // tabs replace, so Back returns to the map

  // resizable side panel: drag its left edge; width remembered
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const move = (ev: PointerEvent) => setPanelW(Math.min(panelMax(), Math.max(340, window.innerWidth - ev.clientX)))
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); try { localStorage.setItem(PANEL_KEY, String(panelWRef.current)) } catch { /* ignore */ } }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  return (
    <div className="h-full flex flex-col">
      {meta.data_source === 'synthetic_sample' && (
        <div role="alert" className="bg-accent text-bg text-center text-[12px] font-semibold py-1 tracking-wide">
          SAMPLE DATA — not real fire observations
        </div>
      )}

      <main className="relative flex-1 flex min-h-0">
        <div className="relative flex-1 min-w-0 bg-bg">
          <Earth viewState={viewState} setViewState={setViewState} mode={mapMode} cells={cells.data} anomaly={anomaly.data}
            minPct={minPct} setMinPct={setMinPct} grid={grid} periodLabel={periodLabel} start={mStart} end={mEnd}
            scaleMode={scaleMode} setScaleMode={setScaleMode} scale={scale.data?.q} nMonths={mEnd === mStart ? 1 : nMonths}
            area={area} view={view} drawing={drawing} onDrawn={onDrawn} imagery={imagery} setImagery={setImagery}
            onInteract={onInteract} />

          <header className="absolute left-4 top-4 max-w-[420px] pointer-events-none">
            <h1 className="text-[15px] font-semibold leading-tight">Hots45</h1>
            <p className="text-[12px] text-dim">Harmonized MODIS/VIIRS burning activity record</p>
          </header>

          <div className="absolute right-4 top-4 flex flex-wrap justify-end gap-2 items-start max-w-[70%]">
            <div className="flex border border-line rounded-sm overflow-hidden bg-panel" role="group" aria-label="Map mode">
              {([['hotspots', 'Hotspots'], ['anomaly', 'Anomaly vs median'], ['heatmap', 'Heatmap']] as [MapMode, string][]).map(([k, label]) => (
                <button key={k} aria-pressed={mapMode === k} onClick={() => setMapMode(k)}
                  className={`h-7 px-2.5 text-[12px] ${mapMode === k ? 'bg-accent text-bg font-medium' : 'text-dim hover:text-ink'}`}>
                  {label}
                </button>
              ))}
            </div>
            <div className="flex border border-line rounded-sm overflow-hidden bg-panel" role="group" aria-label="Basemap imagery">
              {(Object.keys(IMAGERY) as Imagery[]).map(k => (
                <button key={k} aria-pressed={imagery === k} onClick={() => setImagery(k)}
                  className={`h-7 px-2.5 text-[12px] ${imagery === k ? 'bg-raised text-ink' : 'text-dim hover:text-ink'}`}>
                  {IMAGERY[k].label}
                </button>
              ))}
            </div>
            <div className="relative"><Alerts meta={meta} area={area} setArea={setArea} months={months} dispatch={dispatch} /></div>
            <button className="h-7 px-2.5 text-[12px] border border-line rounded-sm bg-panel text-dim hover:text-ink"
              aria-expanded={panelOpen} aria-controls="analytics" onClick={() => setPanelOpen(!panelOpen)}>
              {panelOpen ? 'Hide panel' : 'Show analytics'}
            </button>
          </div>

          {/* period header: updates on every change so the period is never ambiguous */}
          <div className="absolute left-1/2 -translate-x-1/2 top-14 pointer-events-none text-center" aria-live="polite">
            <div className={`num text-[15px] font-medium px-3 py-1 rounded-sm border border-line bg-panel/95`}>
              {periodLabel}
              {overlay && <> · {fmt(overlay.total)} hotspots{overlay.pct != null && (
                <span style={{ color: overlay.pct >= 10 ? '#E8743B' : overlay.pct <= -10 ? '#56B4E9' : undefined }}>
                  {' '}· {Math.abs(overlay.pct) < 5 ? '≈ normal' : `${overlay.pct > 0 ? '+' : ''}${Math.round(overlay.pct)}% vs normal`}</span>)}</>}
            </div>
            <div className="text-[10px] text-faint mt-0.5">{areaName}</div>
            {preview && <div className="mt-1 text-[11px] text-accent bg-panel/95 border border-accent/50 rounded-sm px-2 py-0.5 inline-block">Previewing {monthLabel(preview)} · click to select</div>}
          </div>

          {(active.loading || active.error) && (
            <div className="absolute left-1/2 -translate-x-1/2 top-28 text-[11px] bg-panel border border-line rounded-sm px-2 py-1 max-w-[50%]" role="status">
              {active.error ? <span className="text-accent">{mapMode === 'anomaly' ? 'Anomaly' : 'Map data'}: {active.error}</span>
                : <span className="text-dim">Loading {grid}° cells…</span>}
            </div>
          )}
          {active.data && active.data.length === 0 && !active.loading && !active.error && (
            <div className="absolute left-1/2 -translate-x-1/2 top-36 text-[12px] text-dim bg-panel border border-line rounded-sm px-3 py-1.5" role="status">
              {mapMode === 'anomaly' ? `No cells changed significantly in ${periodLabel}.` : `No hotspots recorded for ${periodLabel}.`}
            </div>
          )}
        </div>

        {panelOpen && (
          <aside id="analytics" aria-label="Analytics for the selected area"
            className="relative shrink-0 border-l border-line bg-bg overflow-y-auto" style={{ width: panelW }}>
            <div role="separator" aria-orientation="vertical" aria-label="Resize panel" tabIndex={0}
              aria-valuenow={panelW} aria-valuemin={340} aria-valuemax={panelMax()}
              onPointerDown={startResize}
              onKeyDown={e => { const d = e.key === 'ArrowLeft' ? 24 : e.key === 'ArrowRight' ? -24 : 0; if (d) { e.preventDefault(); setPanelW(w => { const v = Math.min(panelMax(), Math.max(340, w + d)); try { localStorage.setItem(PANEL_KEY, String(v)) } catch { /* ignore */ } return v }) } }}
              className="sticky top-0 float-left -ml-px h-full w-2 cursor-col-resize hover:bg-accent/40 focus:bg-accent/40 z-10" style={{ marginBottom: '-100%' }} />
            <Panel meta={meta} area={area} setArea={setArea} start={start} end={end} view={view} periodLabel={periodLabel} onPickMonth={pickMonth} expand={expand}
              drawing={drawing} setDrawing={setDrawing} onSeries={setSpark} />
          </aside>
        )}
      </main>

      <TimelineChart meta={meta} months={months} tl={tl} dispatch={dispatch} lastComplete={lastCompleteIdx} rows={spark}
        area={ap} areaKey={ap.region ?? ap.bbox?.join(',') ?? 'all'} areaName={areaName} onPreview={setPreview}
        expandHref={expand('timeline').href} onExpand={expand('timeline').onClick} />

      {route.chart && (
        <ChartView chart={route.chart} meta={meta} months={months} tl={tl} dispatch={dispatch} lastComplete={lastCompleteIdx}
          area={area} setArea={setArea} areaName={areaName} go={go} onBack={back} onPreview={() => {}} />
      )}

      <footer className="border-t border-line bg-bg px-4 py-1 text-[10px] text-faint flex flex-wrap gap-x-3">
        <span>Source: NASA FIRMS MCD14ML (MODIS), VNP14IMGML (VIIRS S-NPP)</span>
        <span>{IMAGERY[imagery].credit}</span>
        <span>Hotspots are VIIRS-equivalent counts; MODIS scaled by monthly factor k (R² {meta.r2_overlap.toFixed(3)})</span>
        <span className="num">Dates UTC</span>
      </footer>
    </div>
  )
}

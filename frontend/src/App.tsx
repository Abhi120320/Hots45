import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { FlyToInterpolator, WebMercatorViewport } from '@deck.gl/core'
import { areaParams, prefetch, regionLabel, url, useApi, type AnomalyCell, type Area, type BBox, type Cell, type Meta, type SeriesRow } from './api'
import { fmt, monthLabel, monthsBetween, reducedMotion } from './colors'
import Earth, { GLOBE_MAX_ZOOM, IMAGERY, gridFor, type Imagery, type MapMode, type ScaleMode, type ViewState } from './Earth'
import Panel from './Panel'
import TimelineChart from './TimelineChart'
import { IconButton, Menu, Segmented, menuItemCls } from './ui'
import ChartView from './ChartView'
import Alerts from './Alerts'
import { PRESETS } from './Area'
import { decodeArea, stateQuery, useRoute, type ChartKey } from './url'
import type { Region } from './api'
import { initTL, reduceTL, type TLAction } from './timeline'
import type { Metric } from './Metric'

const PANEL_KEY = 'hots45.panelWidth'
const panelMax = () => Math.min(900, Math.round(window.innerWidth * 0.6))
const PANEL_MIN = 320, PANEL_DEFAULT = 400

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
  const [panelW, setPanelW] = useState(() => { try { return Math.min(panelMax(), Math.max(PANEL_MIN, +(localStorage.getItem(PANEL_KEY) ?? PANEL_DEFAULT) || PANEL_DEFAULT)) } catch { return PANEL_DEFAULT } })
  // Blue Marble suits the globe; the dark basemap lets data stand out on the 3D map. Each view keeps its own choice.
  const [imageryBy, setImageryBy] = useState<{ globe: Imagery; map: Imagery }>({ globe: 'blue', map: 'dark' })
  const [mapMode, setMapMode] = useState<MapMode>('hotspots')
  const [minPct, setMinPct] = useState(30)
  const [scaleMode, setScaleMode] = useState<ScaleMode>('fixed')
  const [metric, setMetric] = useState<Metric>('hotspots') // calendar, timeline and KPIs: counts or FRP
  const [fireType, setFireType] = useState('all') // calendar + timeline filter: 'all' or a land-cover group key
  const [sparkFor, setSparkFor] = useState<{ key: string; rows?: SeriesRow[] }>() // the Panel's monthly series, tagged with its area

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
  const mapMetric = mapMode === 'intensity' ? 'frp' : undefined
  const cells = useApi<Cell[]>(url('/api/map', { start: mStart, end: mEnd, grid, bbox: view, lc: mapMode === 'firetype' ? 1 : undefined, metric: mapMetric }), 150, `${mStart}|${mEnd}|${grid}|${mapMode}`)
  const anomaly = useApi<AnomalyCell[]>(mapMode === 'anomaly' ? url('/api/anomaly', { start: mStart, end: mEnd, grid, bbox: view }) : null, 150, `${mStart}|${mEnd}|${grid}`)
  const scale = useApi<{ q: Record<string, number> }>(url('/api/scale', { grid, metric: mapMetric }))
  const active = mapMode === 'anomaly' ? anomaly : cells

  const periodLabel = mStart === mEnd ? monthLabel(mStart) : `${monthLabel(mStart)} – ${monthLabel(mEnd)}`

  // During playback, warm the cache for the next month so frames don't stall.
  useEffect(() => {
    const nx = months[(tl.a + 1) % n]
    if (tl.playing) prefetch(url('/api/map', { start: nx, end: nx, grid, bbox: view, lc: mapMode === 'firetype' ? 1 : undefined, metric: mapMetric }))
  }, [tl.playing, tl.a, n, months, grid, view, mapMode, mapMetric])

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

  const ap = useMemo(() => areaParams(area), [area])
  const areaKey = ap.region ?? ap.bbox?.join(',') ?? 'all'
  const setSpark = useCallback((rows?: SeriesRow[]) => setSparkFor({ key: areaKey, rows }), [areaKey])
  const spark = sparkFor?.key === areaKey ? sparkFor.rows : undefined // never show another area's rows (panel hidden)
  // timeline rows for the fire-type filter / FRP (same URL as the panel's calendar, so it is fetched once).
  // FRP is not split by land cover, so the fire-type filter is off in Intensity.
  const group = fireType === 'all' || metric === 'frp' ? undefined : fireType
  const met = metric === 'frp' ? 'frp' : undefined
  const ownRows = useApi<SeriesRow[]>((group || met) && spark ? url('/api/series', { ...ap, group, metric: met }) : null)
  const tlRows = group || met ? ownRows.data : spark
  const tlArea = useMemo(() => ({ ...ap, group, metric: met }), [ap, group, met])
  // map header: what the map shows, its total and how that compares with normal (selected area's series)
  const overlay = useMemo(() => {
    const r = (spark ?? []).filter(x => x.month >= mStart && x.month <= mEnd)
    if (!r.length) return null
    const total = r.reduce((s, x) => s + x.hotspots, 0), normal = r.reduce((s, x) => s + x.hist_median, 0)
    return { total, pct: normal > 0 ? ((total - normal) / normal) * 100 : null }
  }, [spark, mStart, mEnd])
  const areaName = area ? ('region' in area ? regionLabel(area.region) : PRESETS.find(pr => pr.bbox.join() === area.bbox.join())?.name ?? 'selected box') : (meta.region ?? 'full extent')

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
    const move = (ev: PointerEvent) => setPanelW(Math.min(panelMax(), Math.max(PANEL_MIN, window.innerWidth - ev.clientX)))
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); try { localStorage.setItem(PANEL_KEY, String(panelWRef.current)) } catch { /* ignore */ } }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  const modes = ([['hotspots', 'Hotspots'], ['anomaly', 'Anomaly'], ['heatmap', 'Heatmap'], ...(meta.frp ? [['intensity', 'Intensity']] : []),
    ...(meta.land_cover ? [['firetype', 'Fire type']] : [])] as [MapMode, string][]).map(([value, label]) => ({ value, label,
      title: value === 'anomaly' ? 'Change vs the median of the same months in other years' : undefined }))
  const statusMsg = (text: string, alert = false) => (
    <div role={alert ? 'alert' : 'status'} className={`absolute left-1/2 -translate-x-1/2 top-20 h-8 px-3 flex items-center text-sm bg-panel border rounded-md max-w-[60%] truncate ${alert ? 'border-accent/60 text-ink' : 'border-line text-dim'}`}>{text}</div>
  )

  return (
    <div className="h-full flex flex-col">
      {meta.data_source === 'synthetic_sample' && (
        <div role="alert" className="bg-accent text-bg text-center text-xs font-semibold py-1">SAMPLE DATA — not real fire observations</div>
      )}

      {/* top bar: title · map modes · basemap, alerts, panel, more */}
      <header className="h-14 shrink-0 grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 border-b border-line bg-panel">
        <div className="min-w-0 flex items-baseline gap-3">
          <h1 className="text-lg font-semibold text-ink">Hots45</h1>
          <p className="text-xs text-dim truncate hidden min-[1500px]:block">Harmonized MODIS/VIIRS burning activity record</p>
        </div>
        <Segmented label="Map mode" value={mapMode} onChange={setMapMode} options={modes} />
        <div className="flex items-center justify-end gap-2 min-w-0">
          <Segmented label="Basemap" value={imagery} onChange={setImagery}
            options={(Object.keys(IMAGERY) as Imagery[]).map(k => ({ value: k, label: IMAGERY[k].label }))} />
          <div className="relative"><Alerts meta={meta} area={area} setArea={setArea} months={months} dispatch={dispatch} /></div>
          <IconButton label={panelOpen ? 'Hide analytics panel' : 'Show analytics panel'} aria-expanded={panelOpen} aria-controls="analytics"
            onClick={() => setPanelOpen(!panelOpen)}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d={panelOpen ? 'M10 3v10' : 'M10 3v10M12 6.5 11 8l1 1.5'} /></svg>
          </IconButton>
          <Menu label="More" icon={<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden fill="currentColor"><circle cx="3" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="13" cy="8" r="1.4" /></svg>}>
            <a role="menuitem" className={menuItemCls} href="https://github.com/Abhi120320/Hots45/blob/main/CREDITS.md" target="_blank" rel="noreferrer">Credits &amp; licences</a>
            <a role="menuitem" className={menuItemCls} href="/third-party-licenses.txt" target="_blank" rel="noreferrer">Open-source notices</a>
            <div className="border-t border-line my-2" />
            <p className="px-3 py-1 text-xs text-dim max-w-[280px]">
              Hotspots are VIIRS-equivalent counts; MODIS is scaled by a monthly factor k (R² {meta.r2_overlap.toFixed(3)}). Dates are UTC.
              Boundaries: geoBoundaries (Runfola et al. 2020), incl. © OpenStreetMap contributors (ODbL), WFP/OCHA, DataMeet, ABS and others.
              Place search: Photon by Komoot, © OpenStreetMap contributors.
            </p>
          </Menu>
        </div>
      </header>

      <main className="relative flex-1 flex min-h-0">
        <div className="relative flex-1 min-w-0 bg-bg">
          <Earth viewState={viewState} setViewState={setViewState} mode={mapMode} cells={cells.data} anomaly={anomaly.data}
            minPct={minPct} setMinPct={setMinPct} grid={grid} periodLabel={periodLabel} start={mStart} end={mEnd}
            scaleMode={scaleMode} setScaleMode={setScaleMode} scale={scale.data?.q} nMonths={mEnd === mStart ? 1 : nMonths}
            area={area} view={view} drawing={drawing} onDrawn={onDrawn} imagery={imagery} setImagery={setImagery}
            onInteract={onInteract} lcGroups={meta.land_cover?.groups} />

          {/* the one place the period is shown on the map: period · total · vs normal, then the area */}
          <div className="absolute left-1/2 -translate-x-1/2 top-4 pointer-events-none flex flex-col items-center gap-2 max-w-[calc(100%-32px)]" aria-live="polite">
            <div className="num text-base text-ink h-10 px-4 inline-flex items-center gap-2 rounded-md border border-line bg-panel/95 whitespace-nowrap">
              <span className="font-semibold">{periodLabel}</span>
              {overlay && <><span className="text-dim">·</span>{fmt(overlay.total)}<span className="text-dim font-sans text-sm">hotspots</span>{overlay.pct != null && (
                <span className={Math.abs(overlay.pct) < 5 ? 'text-dim' : overlay.pct > 0 ? 'text-accent' : 'text-below'}>
                  {Math.abs(overlay.pct) < 5 ? '≈ normal' : `${overlay.pct > 0 ? '+' : '−'}${Math.abs(Math.round(overlay.pct))}% vs normal`}</span>)}</>}
            </div>
            <div className="max-w-full truncate text-xs text-ink h-6 leading-6 px-2 rounded-sm bg-panel/95 border border-line">{areaName}</div>
            {preview && <div className="text-xs text-accent bg-panel/95 border border-accent/60 rounded-md px-2 py-1 inline-block">Previewing {monthLabel(preview)} · click to select</div>}
          </div>

          {active.error ? statusMsg(`${mapMode === 'anomaly' ? 'Anomaly' : 'Map data'}: ${active.error}`, true)
            : active.loading ? statusMsg(`Loading ${grid}° cells…`)
              : active.data && active.data.length === 0 ? statusMsg(mapMode === 'anomaly' ? `No cells changed significantly in ${periodLabel}.` : `No fires in this area for ${periodLabel}.`)
                : null}
        </div>

        {panelOpen && (
          <aside id="analytics" aria-label="Analytics for the selected area"
            className="relative shrink-0 border-l border-line bg-bg overflow-y-auto" style={{ width: panelW }}>
            <div role="separator" aria-orientation="vertical" aria-label="Resize panel" tabIndex={0}
              aria-valuenow={panelW} aria-valuemin={PANEL_MIN} aria-valuemax={panelMax()}
              onPointerDown={startResize}
              onKeyDown={e => { const d = e.key === 'ArrowLeft' ? 24 : e.key === 'ArrowRight' ? -24 : 0; if (d) { e.preventDefault(); setPanelW(w => { const v = Math.min(panelMax(), Math.max(PANEL_MIN, w + d)); try { localStorage.setItem(PANEL_KEY, String(v)) } catch { /* ignore */ } return v }) } }}
              className="sticky top-0 float-left -ml-px h-full w-2 cursor-col-resize hover:bg-accent/40 focus:bg-accent/40 z-10" style={{ marginBottom: '-100%' }} />
            <Panel meta={meta} area={area} setArea={setArea} start={start} end={end} view={view} periodLabel={periodLabel} onPickMonth={pickMonth} expand={expand}
              drawing={drawing} setDrawing={setDrawing} onSeries={setSpark} fireType={fireType} setFireType={setFireType} metric={metric} setMetric={setMetric} />
          </aside>
        )}
      </main>

      <TimelineChart meta={meta} months={months} tl={tl} dispatch={dispatch} lastComplete={lastCompleteIdx} rows={tlRows}
        area={tlArea} areaKey={`${areaKey}|${fireType}`} areaName={areaName} onPreview={setPreview} fireType={fireType} setFireType={setFireType} metric={metric} setMetric={setMetric}
        expandHref={expand('timeline').href} onExpand={expand('timeline').onClick} />

      {route.chart && (
        <ChartView chart={route.chart} meta={meta} months={months} tl={tl} dispatch={dispatch} lastComplete={lastCompleteIdx}
          area={area} setArea={setArea} areaName={areaName} go={go} onBack={back} onPreview={() => {}} fireType={fireType} setFireType={setFireType} metric={metric} setMetric={setMetric} />
      )}

      {/* required attributions, one line; the rest is under ⋯ More */}
      <footer className="h-8 shrink-0 border-t border-line bg-bg px-4 flex items-center gap-4 text-xs text-dim min-w-0">
        <span className="truncate" title={`${IMAGERY[imagery].credit} · NASA FIRMS MCD14ML, VNP14IMGML${meta.land_cover ? ' · NASA MODIS MCD12Q1' : ''} · geoBoundaries · © OpenStreetMap contributors`}>
          {IMAGERY[imagery].credit} · Data: NASA FIRMS MCD14ML, VNP14IMGML{meta.land_cover ? ', MCD12Q1' : ''} · Boundaries: geoBoundaries, © OpenStreetMap contributors
        </span>
        <a className="ml-auto shrink-0 underline hover:text-ink" href="https://github.com/Abhi120320/Hots45/blob/main/CREDITS.md" target="_blank" rel="noreferrer">Credits</a>
      </footer>
    </div>
  )
}

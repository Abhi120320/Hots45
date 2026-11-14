import { useEffect, useMemo, useState } from 'react'
import { FlyToInterpolator, WebMercatorViewport } from '@deck.gl/core'
import { prefetch, url, useApi, type BBox, type Cell, type Meta, type SeriesRow } from './api'
import { monthLabel, monthsBetween, reducedMotion } from './colors'
import Earth, { GLOBE_MAX_ZOOM, IMAGERY, gridFor, type Imagery, type ViewState } from './Earth'
import Panel from './Panel'
import Timeline, { type Mode } from './Timeline'

const PANEL_W = 440

export default function App() {
  const meta = useApi<Meta>(url('/api/meta', {}))
  if (meta.error) return <Center>Could not reach the FireLedger API: {meta.error}</Center>
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
  const [mode, setMode] = useState<Mode>('range')
  const [idx, setIdx] = useState(n - 1)
  const [range, setRange] = useState<[number, number]>([0, n - 1])
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [bbox, setBBox] = useState<BBox>()
  const [drawing, setDrawing] = useState(false)
  const [panelOpen, setPanelOpen] = useState(true)
  const [imagery, setImagery] = useState<Imagery>('blue')
  const [spark, setSpark] = useState<SeriesRow[]>()

  const [start, end] = mode === 'month' ? [months[idx], months[idx]] : [months[range[0]], months[range[1]]]
  const grid = gridFor(viewState.zoom)
  // Map view only loads the visible area, snapped outward to a coarse step so small pans hit the cache.
  const { longitude, latitude, zoom, pitch, bearing } = viewState
  const view = useMemo<BBox | undefined>(() => {
    if (zoom < GLOBE_MAX_ZOOM) return undefined
    const vp = new WebMercatorViewport({ longitude, latitude, zoom, pitch, bearing,
      width: Math.max(300, window.innerWidth - (panelOpen ? PANEL_W : 0)), height: Math.max(300, window.innerHeight - 120) })
    const [w, s, e, n] = vp.getBounds()
    const step = grid * 40
    const snap = (v: number, f: (x: number) => number, lo: number, hi: number) => Math.min(hi, Math.max(lo, f(v / step) * step))
    return [snap(w, Math.floor, -180, 180), snap(s, Math.floor, -90, 90), snap(e, Math.ceil, -180, 180), snap(n, Math.ceil, -90, 90)]
  }, [longitude, latitude, zoom, pitch, bearing, grid, panelOpen])
  const cells = useApi<Cell[]>(url('/api/map', { start, end, grid, bbox: view }), 150)
  const periodLabel = start === end ? monthLabel(start) : `${monthLabel(start)} – ${monthLabel(end)}`

  // During playback, warm the cache for the next month so frames don't stall.
  useEffect(() => {
    if (playing) prefetch(url('/api/map', { start: months[(idx + 1) % n], end: months[(idx + 1) % n], grid, bbox: view }))
  }, [playing, idx, n, months, grid, view])

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
    let raf = 0
    const tick = () => { setViewState(v => ({ ...v, longitude: v.longitude + 0.04 })); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [interacted, viewState.zoom >= GLOBE_MAX_ZOOM])

  const flyTo = (b: BBox) => {
    setInteracted(true)
    const w = window.innerWidth - (panelOpen ? PANEL_W : 0), h = window.innerHeight - 120
    const { longitude, latitude, zoom } = new WebMercatorViewport({ width: Math.max(w, 300), height: Math.max(h, 300) })
      .fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 60 })
    setViewState({
      longitude, latitude, zoom: Math.max(zoom, GLOBE_MAX_ZOOM + 0.2), pitch: 50, bearing: 0,
      transitionDuration: reducedMotion() ? 0 : 1800, transitionInterpolator: new FlyToInterpolator({ speed: 1.6 }),
    })
  }

  const selectBBox = (b?: BBox) => { setBBox(b); setDrawing(false); if (b) flyTo(b) }

  return (
    <div className="h-full flex flex-col">
      {meta.data_source === 'synthetic_sample' && (
        <div role="alert" className="bg-accent text-bg text-center text-[12px] font-semibold py-1 tracking-wide">
          SAMPLE DATA — not real fire observations
        </div>
      )}

      <main className="relative flex-1 flex min-h-0">
        <div className="relative flex-1 min-w-0 bg-bg">
          <Earth viewState={viewState} setViewState={setViewState} cells={cells.data} grid={grid} periodLabel={periodLabel}
            bbox={bbox} drawing={drawing} onDrawn={selectBBox} imagery={imagery} setImagery={setImagery}
            onInteract={() => setInteracted(true)} />

          <header className="absolute left-4 top-4 max-w-[420px] pointer-events-none">
            <h1 className="text-[15px] font-semibold leading-tight">FireLedger</h1>
            <p className="text-[12px] text-dim">Harmonized MODIS/VIIRS burning activity record</p>
          </header>

          <div className="absolute right-4 top-4 flex gap-2 items-start">
            <div className="flex border border-line rounded-sm overflow-hidden bg-panel" role="group" aria-label="Basemap imagery">
              {(Object.keys(IMAGERY) as Imagery[]).map(k => (
                <button key={k} aria-pressed={imagery === k} onClick={() => setImagery(k)}
                  className={`h-7 px-2.5 text-[12px] ${imagery === k ? 'bg-raised text-ink' : 'text-dim hover:text-ink'}`}>
                  {IMAGERY[k].label}
                </button>
              ))}
            </div>
            <button className="h-7 px-2.5 text-[12px] border border-line rounded-sm bg-panel text-dim hover:text-ink"
              aria-expanded={panelOpen} aria-controls="analytics" onClick={() => setPanelOpen(!panelOpen)}>
              {panelOpen ? 'Hide panel' : 'Show analytics'}
            </button>
          </div>

          {(cells.loading || cells.error) && (
            <div className="absolute left-1/2 -translate-x-1/2 top-4 text-[11px] bg-panel border border-line rounded-sm px-2 py-1" role="status">
              {cells.error ? <span className="text-accent">Map data failed: {cells.error}</span> : <span className="text-dim">Loading {grid}° cells…</span>}
            </div>
          )}
          {cells.data && cells.data.length === 0 && !cells.loading && (
            <div className="absolute left-1/2 -translate-x-1/2 top-12 text-[12px] text-dim bg-panel border border-line rounded-sm px-3 py-1.5" role="status">
              No hotspots recorded for {periodLabel}.
            </div>
          )}
        </div>

        {panelOpen && (
          <aside id="analytics" aria-label="Analytics for the selected area"
            className="shrink-0 border-l border-line bg-bg overflow-y-auto" style={{ width: PANEL_W }}>
            <Panel meta={meta} bbox={bbox} setBBox={selectBBox} start={start} end={end}
              drawing={drawing} setDrawing={setDrawing} onSeries={setSpark} />
          </aside>
        )}
      </main>

      <Timeline months={months} mode={mode} setMode={setMode} idx={idx} setIdx={setIdx} range={range} setRange={setRange}
        playing={playing} setPlaying={setPlaying} speed={speed} setSpeed={setSpeed}
        spark={spark?.map(r => r.hotspots)} sparkLabel={bbox ? 'selected area' : 'full extent'} />

      <footer className="border-t border-line bg-bg px-4 py-1 text-[10px] text-faint flex flex-wrap gap-x-3">
        <span>Source: NASA FIRMS MCD14ML (MODIS), VNP14IMGML (VIIRS S-NPP)</span>
        <span>{IMAGERY[imagery].credit}</span>
        <span>Hotspots are VIIRS-equivalent counts; MODIS scaled by monthly factor k (R² {meta.r2_overlap.toFixed(3)})</span>
        <span className="num">Dates UTC</span>
      </footer>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { _GlobeView as GlobeView, MapView, LinearInterpolator, type PickingInfo } from '@deck.gl/core'
import { TileLayer } from '@deck.gl/geo-layers'
import { BitmapLayer, ColumnLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { CollisionFilterExtension } from '@deck.gl/extensions'
import { HeatmapLayer } from '@deck.gl/aggregation-layers'
import { Map as MapLibre, ScaleControl } from 'react-map-gl/maplibre'
import { url, useApi, type AnomalyCell, type Area, type BBox, type Boundaries, type Cell, type CellInfo } from './api'
import { CLASS_ALPHA, RDBU7, YLORRD6, classify, classifyFixed, fmt, rampColor, ratioT, reducedMotion, rgb } from './colors'

export const GLOBE_MAX_ZOOM = 3.5
const MIN_ZOOM = 1 // whole globe in view; below z1 the globe tiles fall back to one world tile that renders flat

export interface ViewState {
  longitude: number
  latitude: number
  zoom: number
  pitch: number
  bearing: number
  transitionDuration?: number
  transitionInterpolator?: unknown
}

export type Imagery = 'blue' | 'black' | 'dark'
export type MapMode = 'hotspots' | 'anomaly' | 'heatmap'
export type ScaleMode = 'fixed' | 'relative'

// Verified against NASA GIBS WMTS (epsg3857 "best", GoogleMapsCompatible_Level8 => max zoom 8).
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best'
export const IMAGERY: Record<Imagery, { label: string; tiles: string; maxzoom: number; credit: string }> = {
  blue: { label: 'Blue Marble', tiles: `${GIBS}/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg`, maxzoom: 8, credit: 'Imagery: NASA GIBS Blue Marble' },
  black: { label: 'Black Marble', tiles: `${GIBS}/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`, maxzoom: 8, credit: 'Imagery: NASA GIBS VIIRS Black Marble 2016' },
  // CARTO's free dark tiles now return an "API KEY REQUIRED" watermark; Esri's dark canvas needs no key.
  dark: { label: 'Dark', tiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', maxzoom: 16, credit: 'Basemap: Esri World Dark Gray Canvas (Esri, HERE, Garmin, © OpenStreetMap contributors)' },
}

/** Globe 0.5° (pre-aggregated file); map: 1° country scale, 0.25° regional, 0.05° local. */
export const gridFor = (zoom: number) => (zoom < GLOBE_MAX_ZOOM ? 0.5 : zoom < 5.5 ? 1 : zoom < 7.5 ? 0.25 : 0.05)

const deg = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? pos : neg}`
type Label = Boundaries['labels'][number]
const RDBU_RGB = RDBU7.map(rgb)
const HEAT_ALPHA = [35, 80, 130, 180, 225, 255] // low density fades into the basemap
const divergingColor = (t: number): [number, number, number] => rampColor(t, RDBU7)

interface Props {
  viewState: ViewState
  setViewState: (v: ViewState | ((v: ViewState) => ViewState)) => void
  mode: MapMode
  cells?: Cell[]
  anomaly?: AnomalyCell[]
  grid: number
  periodLabel: string
  start: string
  end: string
  area: Area
  view?: BBox
  drawing: boolean
  onDrawn: (b: BBox) => void
  imagery: Imagery
  setImagery: (i: Imagery) => void
  onInteract: () => void
  minPct: number
  scaleMode: ScaleMode
  setScaleMode: (m: ScaleMode) => void
  scale?: Record<string, number> // full-record quantiles of monthly cell values at this grid
  nMonths: number
  setMinPct: (v: number) => void
}

export default function Earth(p: Props) {
  const isMap = p.viewState.zoom >= GLOBE_MAX_ZOOM
  const zoomStep = Math.round(p.viewState.zoom * 2) / 2 // quantized so layers aren't rebuilt every frame
  const [hover, setHover] = useState<[number, number] | null>(null)
  const [draft, setDraft] = useState<[number, number, number, number] | null>(null)
  const tileErrors = useRef(0)
  const [hoverObj, setHoverObj] = useState<{ o: Cell | AnomalyCell; x: number; y: number } | null>(null)

  // Admin boundaries (map view only): states from the 3D map's first zoom, districts from zoom 6
  const zInt = Math.floor(p.viewState.zoom)
  const adm1 = useApi<Boundaries>(isMap && p.view ? url('/api/boundaries', { level: 1, bbox: p.view, zoom: zInt }) : null, 200)
  const adm2 = useApi<Boundaries>(isMap && p.view && zInt >= 6 ? url('/api/boundaries', { level: 2, bbox: p.view, zoom: zInt }) : null, 200)

  // hover details (names + % vs normal) for the cell under the pointer, debounced and cached by useApi
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  useEffect(() => {
    const t = setTimeout(() => setHoverKey(hoverObj ? url('/api/cell', { lon: hoverObj.o.lon, lat: hoverObj.o.lat, grid: p.grid, start: p.start, end: p.end }) : null), 120)
    return () => clearTimeout(t)
  }, [hoverObj, p.grid, p.start, p.end])
  const cellInfo = useApi<CellInfo>(hoverKey)

  // Hotspot classes for the cells currently loaded (the visible area in map view)
  // Fixed scale compares periods: values are hotspots per month, classed against the full record.
  // Relative scale shows detail inside this period: totals, classed against what is on screen.
  const fixed = p.scaleMode === 'fixed' && !!p.scale
  const per = fixed ? Math.max(1, p.nMonths) : 1
  const val = (c: Cell) => c.hotspots / per
  const cls = useMemo(() => {
    const v = (p.cells ?? []).map(c => c.hotspots / per)
    return fixed ? classifyFixed(v, p.scale!, p.minPct) : classify(v, p.minPct)
  }, [p.cells, p.minPct, fixed, p.scale, per])
  const shownCells = useMemo(() => (p.cells ?? []).filter(c => c.hotspots > 0 && c.hotspots / per >= cls.threshold), [p.cells, cls, per])
  const maxAbsDiff = useMemo(() => (p.anomaly ?? []).reduce((m, a) => Math.max(m, Math.abs(a.diff)), 0), [p.anomaly])

  const fallback = () => {
    if (p.imagery !== 'dark' && ++tileErrors.current > 3) { tileErrors.current = 0; p.setImagery('dark') }
  }

  const layers = useMemo(() => {
    const out = []
    const im = IMAGERY[p.imagery]
    const half = p.grid * 111_000 * 0.35 // coverage 0.7: square half-side in metres
    const H = 250_000 * 2 ** (5 - zoomStep) // tallest column in metres: ~a fifth of the view height at any zoom
    const hotColor = (v: number): [number, number, number, number] => {
      const c = cls.classOf(v)
      return [...rgb(YLORRD6[cls.colorIdx(c)]), CLASS_ALPHA[cls.colorIdx(c)]]
    }
    const anomColor = (a: AnomalyCell): [number, number, number, number] => [...divergingColor(ratioT(a.current, a.baseline)), 235]

    if (!isMap) {
      out.push(new TileLayer({
        id: `tiles-${p.imagery}`, data: im.tiles, minZoom: 0, maxZoom: Math.min(im.maxzoom, 8), tileSize: 256,
        onTileError: fallback,
        renderSubLayers: (props: any) => {
          const [[w, s], [e, n]] = props.tile.boundingBox
          const { data, ...rest } = props
          return new BitmapLayer(rest, { image: data, bounds: [w, s, e, n], desaturate: 0.25, tintColor: [175, 175, 175] })
        },
      }))
    }

    if (p.mode === 'anomaly') {
      const data = p.anomaly ?? []
      out.push(isMap
        ? new ColumnLayer<AnomalyCell>({
            id: 'anomaly-columns', data, pickable: true, extruded: true, diskResolution: 4, angle: 45, radius: half * Math.SQRT2,
            getPosition: d => [d.lon, d.lat], getElevation: d => Math.abs(d.diff), elevationScale: maxAbsDiff > 0 ? H / maxAbsDiff : 0,
            getFillColor: anomColor, material: { ambient: 0.6, diffuse: 0.5, shininess: 8 },
            updateTriggers: { getFillColor: data }, transitions: reducedMotion() ? undefined : { getElevation: 250 },
          })
        : new ScatterplotLayer<AnomalyCell>({
            id: 'anomaly-points', data, pickable: true, radiusUnits: 'meters', radiusMinPixels: 1.5,
            getPosition: d => [d.lon, d.lat], getRadius: half * 1.4, getFillColor: anomColor,
          }))
    } else if (p.mode === 'heatmap' && isMap) {
      out.push(new HeatmapLayer<Cell>({
        id: 'heatmap', data: p.cells ?? [], getPosition: d => [d.lon, d.lat], getWeight: d => Math.sqrt(d.hotspots), // sqrt so one huge hotspot doesn't hide every other region
        radiusPixels: 32, intensity: 1, threshold: 0.06, aggregation: 'SUM',
        colorRange: YLORRD6.map((c, i) => [...rgb(c), HEAT_ALPHA[i]]),
      }))
    } else if (!isMap) {
      // globe: points; also the heatmap fallback (HeatmapLayer does not support GlobeView)
      out.push(new ScatterplotLayer<Cell>({
        id: 'globe-points', data: shownCells, pickable: true, radiusUnits: 'meters', radiusMinPixels: 1.2,
        getPosition: d => [d.lon, d.lat],
        getRadius: d => half * (0.8 + 0.25 * cls.classOf(val(d))),
        getFillColor: d => hotColor(val(d)),
        transitions: reducedMotion() ? undefined : { getFillColor: 300, getRadius: 300 },
        updateTriggers: { getRadius: [cls, per], getFillColor: [cls, per] },
      }))
    } else {
      out.push(new ColumnLayer<Cell>({
        id: 'columns', data: shownCells, pickable: true, extruded: true, diskResolution: 4, angle: 45, radius: half * Math.SQRT2,
        getPosition: d => [d.lon, d.lat],
        getElevation: d => Math.min(val(d), cls.max), elevationScale: cls.max > 0 ? H / cls.max : 0, // linear: top cells tower
        getFillColor: d => hotColor(val(d)),
        material: { ambient: 0.6, diffuse: 0.5, shininess: 8 },
        updateTriggers: { getFillColor: cls, getElevation: [cls, per] },
        transitions: reducedMotion() ? undefined : { getElevation: 300, getFillColor: 300 }, // makes period changes visible
      }))
    }

    // boundary lines sit on the ground under the columns; labels draw last, on top of everything
    const lines = (b: Boundaries | undefined, id: string, color: [number, number, number, number], w: number) =>
      b && new PathLayer({ id, data: b.lines, getPath: (d: any) => d, getColor: color, getWidth: w, widthUnits: 'pixels', widthMinPixels: w })
    if (isMap) {
      out.unshift(...[lines(adm2.data, 'adm2-lines', [205, 210, 218, 55], 0.6), lines(adm1.data, 'adm1-lines', [225, 230, 236, 120], 1)].filter(Boolean) as any[])
    }

    const region = p.area && 'region' in p.area ? p.area.region : null
    if (region?.rings && !draft) {
      out.push(new PathLayer({
        id: 'region-outline', data: region.rings, getPath: (d: any) => d, getColor: [232, 116, 59, 255],
        getWidth: 2.5, widthUnits: 'pixels', parameters: { depthCompare: 'always' } as any,
      }))
    }
    const box = draft ?? (p.area && 'bbox' in p.area ? p.area.bbox : null)
    if (box) {
      const [a, b, c, d] = box
      const [lon0, lon1, lat0, lat1] = [Math.min(a, c), Math.max(a, c), Math.min(b, d), Math.max(b, d)]
      out.push(new PolygonLayer({
        id: 'bbox', data: [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1]]], getPolygon: (d: any) => d,
        stroked: true, filled: true, getFillColor: [232, 116, 59, 22], getLineColor: [232, 116, 59, 255],
        lineWidthUnits: 'pixels', getLineWidth: 2,
      }))
    }
    const labels = (b: Boundaries | undefined, id: string, size: number, minZoom: number, weight: number) =>
      b && zInt >= minZoom && new TextLayer<Label>({
        id, data: zInt < 5 ? b.labels.filter(l => l.area >= 4) : b.labels, getPosition: (d: Label) => d.pos, getText: (d: Label) => d.name, getSize: size, sizeUnits: 'pixels',
        fontFamily: 'IBM Plex Sans, system-ui, sans-serif', fontWeight: weight, characterSet: 'auto',
        getColor: [236, 238, 241, 235], fontSettings: { sdf: true, fontSize: 48, buffer: 8 },
        outlineWidth: 3, outlineColor: [11, 13, 16, 230], // dark halo: readable on Dark and Blue Marble
        billboard: true, parameters: { depthCompare: 'always' } as any, // never hidden behind columns
        extensions: [new CollisionFilterExtension()], collisionEnabled: true,
        getCollisionPriority: (d: Label) => d.area, collisionTestProps: { sizeScale: 1.6 },
      } as any)
    if (isMap) {
      out.push(...[labels(adm1.data, 'adm1-labels', 12, 4, 600), labels(adm2.data, 'adm2-labels', 11, 6, 400)].filter(Boolean) as any[])
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMap, zoomStep, zInt, p.mode, shownCells, cls, per, p.cells, p.anomaly, maxAbsDiff, p.grid, p.area, draft, p.imagery, adm1.data, adm2.data])

  const imagery = IMAGERY[p.imagery]
  const mapStyle = useMemo(() => ({
    version: 8 as const,
    sources: { base: { type: 'raster' as const, tiles: [imagery.tiles], tileSize: 256, maxzoom: imagery.maxzoom } },
    layers: [
      { id: 'bg', type: 'background' as const, paint: { 'background-color': '#0B0D10' } },
      { id: 'base', type: 'raster' as const, source: 'base', paint: { 'raster-brightness-max': p.imagery === 'blue' ? 0.6 : 1, 'raster-saturation': -0.3 } },
    ],
  }), [imagery, p.imagery])

  const view = useMemo(() => {
    // smooth wheel zoom restarts its animation on every wheel event, which swallowed fast scrolling; snap instead
    const motion = { scrollZoom: { smooth: false, speed: 0.02 }, ...(reducedMotion() ? {} : { inertia: 400 }) }
    return isMap
      ? new MapView({ id: 'map', controller: { dragPan: !p.drawing, dragRotate: !p.drawing, keyboard: true, ...motion } })
      : new GlobeView({ id: 'globe', resolution: 10, controller: { dragPan: !p.drawing, keyboard: true, ...motion } as any })
  }, [isMap, p.drawing])

  return (
    <div className="absolute inset-0" style={{ cursor: p.drawing ? 'crosshair' : undefined }}
      onPointerDown={p.onInteract} onWheel={p.onInteract}
      role="application" aria-label="3D map of fire hotspots. Use arrow keys to pan, plus and minus to zoom.">
      <DeckGL
        views={view}
        viewState={p.viewState as any}
        onViewStateChange={({ viewState: raw, interactionState }: any) => {
          // Drop fly-to settings once deck is done with them: if they stick, every later scroll restarts a slow
          // 1.8 s transition and zooming looks stuck.
          const { transitionDuration: _d, transitionInterpolator: _i, ...rest } = raw
          const v = interactionState?.inTransition ? raw : rest
          const wasMap = p.viewState.zoom >= GLOBE_MAX_ZOOM, nowMap = v.zoom >= GLOBE_MAX_ZOOM
          if (!wasMap && nowMap && v.pitch < 1 && !p.viewState.transitionDuration)
            p.setViewState({ ...v, pitch: 45, transitionDuration: reducedMotion() ? 0 : 300, transitionInterpolator: new LinearInterpolator(['pitch']) })
          else if (wasMap && !nowMap)
            // hand over to the globe with a clean, level camera (the map controller's extra fields confuse the globe)
            p.setViewState({ longitude: v.longitude, latitude: Math.max(-60, Math.min(60, v.latitude)), zoom: Math.max(MIN_ZOOM, v.zoom), pitch: 0, bearing: 0 })
          else if (!nowMap) p.setViewState({ ...v, zoom: Math.max(MIN_ZOOM, v.zoom) })
          else p.setViewState(v)
        }}
        layers={layers}
        onHover={(i: PickingInfo) => {
          setHover(i.coordinate ? [i.coordinate[0], i.coordinate[1]] : null)
          setHoverObj(!p.drawing && i.object && 'lon' in (i.object as any) ? { o: i.object as Cell | AnomalyCell, x: i.x, y: i.y } : null)
        }}
        onDragStart={(i: PickingInfo) => { if (p.drawing && i.coordinate) setDraft([i.coordinate[0], i.coordinate[1], i.coordinate[0], i.coordinate[1]]) }}
        onDrag={(i: PickingInfo) => { if (p.drawing && draft && i.coordinate) setDraft([draft[0], draft[1], i.coordinate[0], i.coordinate[1]]) }}
        onDragEnd={() => {
          if (!p.drawing || !draft) return
          const [a, b, c, d] = draft
          setDraft(null)
          const box: BBox = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)].map(v => +v.toFixed(3)) as BBox
          if (box[2] - box[0] > 0.05 && box[3] - box[1] > 0.05) p.onDrawn(box)
        }}
      >
        {isMap && (
          <MapLibre mapStyle={mapStyle as any} onError={fallback}>
            <ScaleControl position="bottom-right" unit="metric" />
          </MapLibre>
        )}
      </DeckGL>

      <Legend {...p} isMap={isMap} cls={cls} />
      {hoverObj && <Tooltip o={hoverObj.o} x={hoverObj.x} y={hoverObj.y} info={cellInfo.data} loading={cellInfo.loading} grid={p.grid} periodLabel={p.periodLabel} />}

      {/* coordinates readout */}
      <div className={`absolute ${isMap ? 'bottom-10' : 'bottom-4'} right-4 num text-[11px] text-dim bg-panel/95 border border-line rounded-sm px-2 py-1`} aria-live="off">
        {hover ? `${deg(hover[1], 'N', 'S')}  ${deg(hover[0], 'E', 'W')} · z${p.viewState.zoom.toFixed(1)}` : 'Off globe'}
      </div>
    </div>
  )
}

function Legend(p: Props & { isMap: boolean; cls: ReturnType<typeof classify> }) {
  const f = (v: number) => fmt(Math.max(1, Math.round(v))) // whole numbers in the legend
  const fixed = p.scaleMode === 'fixed' && !!p.scale
  const box = 'absolute left-4 bottom-4 bg-panel/95 border border-line rounded-md px-3 py-2 w-[248px]'
  const title = 'text-[11px] text-dim mb-1.5'

  if (p.mode === 'anomaly') {
    return (
      <div className={box}>
        <div className={title}>Change vs median of the same months in other years · {p.periodLabel}</div>
        <div className="h-2 rounded-sm" style={{ background: `linear-gradient(90deg, ${RDBU_RGB.map(c => `rgb(${c})`).join(',')})` }} />
        <div className="flex justify-between num text-[10px] text-dim mt-1">
          <span>÷4</span><span>÷2</span><span>same</span><span>×2</span><span>×4</span>
        </div>
        <div className="text-[10px] text-faint mt-1">
          Colour = ratio to median (blue fewer, red more); height = absolute change. Shown: {fmt(p.anomaly?.length ?? 0)} cells with |robust z| ≥ 2 and ≥ 5 hotspots change.
        </div>
      </div>
    )
  }
  if (p.mode === 'heatmap' && p.isMap) {
    return (
      <div className={box}>
        <div className={title}>Hotspot density (smoothed) · {p.periodLabel}</div>
        <div className="h-2 rounded-sm" style={{ background: `linear-gradient(90deg, ${YLORRD6.join(',')})` }} />
        <div className="flex justify-between text-[10px] text-dim mt-1"><span>low</span><span>high</span></div>
        <div className="text-[10px] text-faint mt-1">Relative to the busiest spot in view; for exact counts use Hotspots.</div>
      </div>
    )
  }
  const { cls } = p
  return (
    <div className={box}>
      <div className={title}>
        {fixed && p.nMonths > 1 ? 'Hotspots per month' : 'Hotspots'} per {p.grid}° cell · {p.periodLabel}
        {p.mode === 'heatmap' && <span className="block text-faint">Heatmap shows in map view; zoom in.</span>}
      </div>
      <div className="flex items-center gap-1.5 mb-1.5 text-[10px]" role="group" aria-label="Colour scale">
        <span className="text-faint">Scale</span>
        {(['fixed', 'relative'] as ScaleMode[]).map(m => (
          <button key={m} aria-pressed={p.scaleMode === m} onClick={() => p.setScaleMode(m)}
            title={m === 'fixed' ? 'Fixed: same colours for every period, so periods can be compared' : 'Relative: colours stretched to this period, for detail'}
            className={`px-1.5 h-5 rounded-sm border ${p.scaleMode === m ? 'border-accent text-ink bg-accent/15' : 'border-line text-dim hover:text-ink'}`}>
            {m === 'fixed' ? 'Fixed' : 'Relative'}
          </button>
        ))}
      </div>
      <ul className="grid grid-cols-[12px_1fr] gap-x-2 gap-y-0.5 items-center num text-[10px] text-dim" aria-label="Colour classes">
        {cls.breaks.map((b, i) => (
          <li key={b} className="contents">
            <span className="h-2.5 w-3 rounded-[2px]" style={{ background: YLORRD6[cls.colorIdx(i)], opacity: CLASS_ALPHA[cls.colorIdx(i)] / 255 }} />
            <span>{f(b)}{i + 1 < cls.breaks.length ? ` – ${f(cls.breaks[i + 1])}` : '+'}</span>
          </li>
        ))}
      </ul>
      <label className="block mt-2 text-[10px] text-dim">
        <span className="flex justify-between"><span>Min hotspots</span><span className="num text-ink">≥ {f(cls.threshold)}{fixed && p.nMonths > 1 ? '/month' : ''}</span></span>
        <input type="range" className="w-full" min={0} max={95} step={5} value={p.minPct}
          aria-valuetext={`hide the lowest ${p.minPct}% of cells, minimum ${f(cls.threshold)} hotspots`}
          onChange={e => p.setMinPct(+e.target.value)} />
      </label>
      <div className="text-[10px] text-faint">
        Showing {fmt(cls.shown)} of {fmt(cls.total)} cells. {fixed ? `Classes fixed from the full record (lowest ${p.minPct}% of all cell-months hidden)` : `Classes from this view (lowest ${p.minPct}% hidden)`}{p.isMap ? '; height is linear.' : '.'}
      </div>
    </div>
  )
}

function Tooltip({ o, x, y, info, loading, grid, periodLabel }: {
  o: Cell | AnomalyCell; x: number; y: number; info?: CellInfo; loading: boolean; grid: number; periodLabel: string
}) {
  const names = info && (info.lon === o.lon && info.lat === o.lat) ? [info.district, info.state, info.country].filter(Boolean).join(', ') : ''
  const anom = 'baseline' in o
  const value = anom ? o.current : o.hotspots
  const pct = anom ? (o.baseline > 0 ? ((o.current - o.baseline) / o.baseline) * 100 : null) : info?.pct_vs_median ?? null
  const median = anom ? o.baseline : info?.median
  return (
    <div role="tooltip" className="absolute z-10 pointer-events-none num text-[11px] leading-relaxed bg-panel border border-line rounded-sm px-2.5 py-1.5 max-w-[280px]"
      style={{ left: x + 14, top: y + 14 }}>
      <div className="text-ink font-medium font-sans text-[12px]">{names || (loading ? 'Locating…' : 'Outside mapped boundaries')}</div>
      <div className="text-faint">{deg(o.lat, 'N', 'S')} {deg(o.lon, 'E', 'W')} · {grid}° cell</div>
      <div><span className="text-[14px] text-ink">{fmt(value)}</span> <span className="text-dim">hotspots · {periodLabel}</span></div>
      <div className="text-dim">
        {pct == null ? (median === 0 ? 'no fires here normally' : loading ? '… vs normal' : '% vs normal needs ≤ 12 months')
          : `${pct > 0 ? '+' : ''}${Math.round(pct)}% vs normal (median ${fmt(median ?? 0)})`}
      </div>
      {!anom && <div className="text-faint">raw MODIS {fmt((o as Cell).modis)} · raw VIIRS {fmt((o as Cell).viirs)}</div>}
    </div>
  )
}

import { useMemo, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { _GlobeView as GlobeView, MapView, LinearInterpolator, type PickingInfo } from '@deck.gl/core'
import { TileLayer } from '@deck.gl/geo-layers'
import { BitmapLayer, ColumnLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers'
import { Map as MapLibre, ScaleControl } from 'react-map-gl/maplibre'
import type { BBox, Cell } from './api'
import { fmt, logNorm, rampColor, reducedMotion } from './colors'

export const GLOBE_MAX_ZOOM = 3.5

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

// Verified against NASA GIBS WMTS (epsg3857 "best", GoogleMapsCompatible_Level8 => max zoom 8).
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best'
export const IMAGERY: Record<Imagery, { label: string; tiles: string; maxzoom: number; credit: string }> = {
  blue: { label: 'Blue Marble', tiles: `${GIBS}/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg`, maxzoom: 8, credit: 'Imagery: NASA GIBS Blue Marble' },
  black: { label: 'Black Marble', tiles: `${GIBS}/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`, maxzoom: 8, credit: 'Imagery: NASA GIBS VIIRS Black Marble 2016' },
  dark: { label: 'Dark', tiles: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', maxzoom: 18, credit: 'Basemap: © CARTO, © OpenStreetMap contributors' },
}

export const gridFor = (zoom: number) => (zoom < GLOBE_MAX_ZOOM ? 0.5 : zoom < 5.5 ? 0.25 : zoom < 7.5 ? 0.1 : 0.05)

const deg = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? pos : neg}`

interface Props {
  viewState: ViewState
  setViewState: (v: ViewState | ((v: ViewState) => ViewState)) => void
  cells?: Cell[]
  grid: number
  periodLabel: string
  bbox?: BBox
  drawing: boolean
  onDrawn: (b: BBox) => void
  imagery: Imagery
  setImagery: (i: Imagery) => void
  onInteract: () => void
}

export default function Earth(p: Props) {
  const isMap = p.viewState.zoom >= GLOBE_MAX_ZOOM
  const [hover, setHover] = useState<[number, number] | null>(null)
  const [draft, setDraft] = useState<[number, number, number, number] | null>(null)
  const tileErrors = useRef(0)

  const max = useMemo(() => (p.cells ?? []).reduce((m, c) => Math.max(m, c.hotspots), 0), [p.cells])

  const fallback = () => {
    if (p.imagery !== 'dark' && ++tileErrors.current > 3) { tileErrors.current = 0; p.setImagery('dark') }
  }

  const layers = useMemo(() => {
    const out = []
    const im = IMAGERY[p.imagery]
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
      out.push(new ScatterplotLayer<Cell>({
        id: 'globe-points', data: p.cells ?? [], pickable: true, radiusUnits: 'meters', radiusMinPixels: 1.2,
        getPosition: d => [d.lon, d.lat],
        getRadius: d => p.grid * 111_000 * (0.25 + 0.5 * Math.sqrt(logNorm(d.hotspots, max))),
        getFillColor: d => [...rampColor(logNorm(d.hotspots, max)), 230],
        updateTriggers: { getRadius: [max, p.grid], getFillColor: max },
      }))
    } else {
      const r = p.grid * 111_000 * 0.45 * Math.SQRT2 // diskResolution 4 + angle 45 => square cell, 10% gap
      out.push(new ColumnLayer<Cell>({
        id: 'columns', data: p.cells ?? [], pickable: true, extruded: true, diskResolution: 4, angle: 45, radius: r,
        getPosition: d => [d.lon, d.lat],
        getElevation: d => (max > 0 ? Math.sqrt(d.hotspots / max) : 0),
        elevationScale: 60_000,
        getFillColor: d => rampColor(logNorm(d.hotspots, max)),
        material: { ambient: 0.55, diffuse: 0.6, shininess: 8 },
        updateTriggers: { getElevation: max, getFillColor: max },
        transitions: reducedMotion() ? undefined : { getElevation: 250 },
      }))
    }
    const box = draft ?? p.bbox
    if (box) {
      const [a, b, c, d] = box
      const [lon0, lon1, lat0, lat1] = [Math.min(a, c), Math.max(a, c), Math.min(b, d), Math.max(b, d)]
      out.push(new PolygonLayer({
        id: 'bbox', data: [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1]]], getPolygon: (d: any) => d,
        stroked: true, filled: true, getFillColor: [232, 116, 59, 22], getLineColor: [232, 116, 59, 255],
        lineWidthUnits: 'pixels', getLineWidth: 2,
      }))
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMap, p.cells, p.grid, max, p.bbox, draft, p.imagery])

  const tooltip = ({ object }: PickingInfo<Cell>) => object && {
    html: `<div class="num" style="font-size:11px;line-height:1.5">
      <div style="color:#9AA3AE">${deg(object.lat, 'N', 'S')} ${deg(object.lon, 'E', 'W')} · ${p.grid}° cell</div>
      <div style="font-size:14px;color:#E6E8EB">${fmt(object.hotspots)} <span style="font-size:11px;color:#9AA3AE">hotspots (VIIRS-equiv.)</span></div>
      <div style="color:#9AA3AE">${p.periodLabel}</div>
      <div style="color:#9AA3AE">raw MODIS ${fmt(object.modis)} · raw VIIRS ${fmt(object.viirs)}</div></div>`,
    style: { background: '#14171C', border: '1px solid #262B33', borderRadius: '4px', padding: '8px 10px', color: '#E6E8EB' },
  }

  const imagery = IMAGERY[p.imagery]
  const mapStyle = useMemo(() => ({
    version: 8 as const,
    sources: { base: { type: 'raster' as const, tiles: [imagery.tiles], tileSize: 256, maxzoom: imagery.maxzoom } },
    layers: [
      { id: 'bg', type: 'background' as const, paint: { 'background-color': '#0B0D10' } },
      { id: 'base', type: 'raster' as const, source: 'base', paint: { 'raster-brightness-max': p.imagery === 'blue' ? 0.6 : 1, 'raster-saturation': -0.3 } },
    ],
  }), [imagery, p.imagery])

  const view = isMap
    ? new MapView({ id: 'map', controller: { dragPan: !p.drawing, dragRotate: !p.drawing, keyboard: true } })
    : new GlobeView({ id: 'globe', resolution: 10, controller: { dragPan: !p.drawing, keyboard: true } as any })

  return (
    <div className="absolute inset-0" style={{ cursor: p.drawing ? 'crosshair' : undefined }}
      onPointerDown={p.onInteract} onWheel={p.onInteract}
      role="application" aria-label="3D map of fire hotspots. Use arrow keys to pan, plus and minus to zoom.">
      <DeckGL
        views={view}
        viewState={p.viewState as any}
        onViewStateChange={({ viewState: v }: any) => {
          const wasMap = p.viewState.zoom >= GLOBE_MAX_ZOOM, nowMap = v.zoom >= GLOBE_MAX_ZOOM
          if (!wasMap && nowMap && v.pitch < 1 && !p.viewState.transitionDuration)
            p.setViewState({ ...v, pitch: 45, transitionDuration: reducedMotion() ? 0 : 300, transitionInterpolator: new LinearInterpolator(['pitch']) })
          else if (wasMap && !nowMap) p.setViewState({ ...v, pitch: 0, bearing: 0 })
          else p.setViewState(v)
        }}
        layers={layers}
        getTooltip={p.drawing ? undefined : (tooltip as any)}
        onHover={(i: PickingInfo) => setHover(i.coordinate ? [i.coordinate[0], i.coordinate[1]] : null)}
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
          <MapLibre mapStyle={mapStyle as any} onError={fallback} reuseMaps>
            <ScaleControl position="bottom-right" unit="metric" />
          </MapLibre>
        )}
      </DeckGL>

      {/* legend */}
      <div className="absolute left-4 bottom-4 bg-panel/95 border border-line rounded-md px-3 py-2 w-[232px]">
        <div className="text-[11px] text-dim mb-1.5">
          {isMap ? 'Column height and colour' : 'Point colour and size'}: hotspots per {p.grid}° cell, {p.periodLabel}
        </div>
        <div className="h-2 rounded-sm" style={{ background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map(t => `rgb(${rampColor(t)})`).join(',')})` }} />
        <div className="flex justify-between num text-[10px] text-dim mt-1">
          <span>1</span><span>{fmt(Math.round(Math.expm1(Math.log1p(max) / 2)))}</span><span>{fmt(max)}</span>
        </div>
        <div className="text-[10px] text-faint mt-0.5">VIIRS-equivalent, log scale</div>
      </div>

      {/* coordinates readout */}
      <div className={`absolute ${isMap ? 'bottom-10' : 'bottom-4'} right-4 num text-[11px] text-dim bg-panel/95 border border-line rounded-sm px-2 py-1`} aria-live="off">
        {hover ? `${deg(hover[1], 'N', 'S')}  ${deg(hover[0], 'E', 'W')}` : '—'} · z{p.viewState.zoom.toFixed(1)}
      </div>
    </div>
  )
}

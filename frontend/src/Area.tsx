import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { url, regionLabel, type Area, type BBox, type Meta, type Place, type Region } from './api'
import { Disclosure, buttonCls } from './ui'

export const PRESETS: { name: string; bbox: BBox }[] = [
  { name: 'India', bbox: [68, 6.5, 97.5, 35.5] },
  { name: 'Punjab–Haryana', bbox: [73.8, 28.4, 77.6, 32.6] },
  { name: 'Central India', bbox: [74, 18, 84, 26] },
]
const RECENT_KEY = 'hots45.recent'
const RADIUS_KM = 25

type Recent = Pick<Region, 'id' | 'name' | 'parent' | 'kind'>
const loadRecent = (): Recent[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]').slice(0, 5) } catch { return [] } }
const saveRecent = (r: Recent[]) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, 5))) } catch { /* private mode */ } }

async function getJSON<T>(u: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(u, { signal })
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? `HTTP ${r.status}`)
  return r.json()
}

type Option = { type: 'unit'; unit: Region } | { type: 'place'; place: Place }

interface Props {
  meta: Meta
  area: Area
  setArea: (a: Area) => void
  drawing: boolean
  setDrawing: (d: boolean) => void
}

const coverageText = (m: Meta) => {
  const c = m.coverage_bbox ?? [60, -11, 150, 55]
  const lat = (v: number) => `${Math.abs(Math.round(v))}°${v < 0 ? 'S' : 'N'}`
  return `${m.region ?? 'the data area'}: ${Math.round(c[0])}–${Math.round(c[2])}°E, ${lat(c[1])}–${lat(c[3])}`
}

export default function AreaControls(p: Props) {
  const [q, setQ] = useState('')
  const [units, setUnits] = useState<Region[]>([])
  const [places, setPlaces] = useState<Place[]>([])
  const [placeState, setPlaceState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [msg, setMsg] = useState<string | null>(null)
  const [fromPlace, setFromPlace] = useState<Place | null>(null)
  const [recent, setRecent] = useState<Recent[]>(loadRecent)
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const hasBoundaries = p.meta.has_boundaries !== false

  // local (offline) search: fast, debounced lightly
  useEffect(() => {
    if (!q.trim() || !hasBoundaries) { setUnits([]); return }
    const ac = new AbortController()
    const t = setTimeout(() => getJSON<Region[]>(url('/api/search', { q, limit: 8 }), ac.signal).then(setUnits, () => {}), 120)
    return () => { clearTimeout(t); ac.abort() }
  }, [q, hasBoundaries])

  // place geocoder: slower and rate-limited server-side (1 req/s), so wait for a pause in typing
  useEffect(() => {
    setPlaces([])
    if (q.trim().length < 3 || !hasBoundaries) { setPlaceState('idle'); return }
    const ac = new AbortController()
    setPlaceState('loading')
    const t = setTimeout(() => getJSON<Place[]>(url('/api/places', { q }), ac.signal)
      .then(r => { setPlaces(r.slice(0, 4)); setPlaceState('idle') }, e => { if (e.name !== 'AbortError') setPlaceState('error') }), 600)
    return () => { clearTimeout(t); ac.abort() }
  }, [q, hasBoundaries])

  const options: Option[] = [...units.map(u => ({ type: 'unit' as const, unit: u })), ...places.map(pl => ({ type: 'place' as const, place: pl }))]
  useEffect(() => setActive(0), [q])

  const choose = async (id: string, place: Place | null = null) => {
    setOpen(false)
    setMsg(null)
    try {
      const r = await getJSON<Region>(url(`/api/region/${id}`, {}))
      if (r.in_coverage === false) { setMsg(`${regionLabel(r)} is outside our data coverage (${coverageText(p.meta)}).`); return }
      p.setArea({ region: r })
      setFromPlace(place)
      setQ('')
      const next = [{ id: r.id, name: r.name, parent: r.parent, kind: r.kind }, ...recent.filter(x => x.id !== r.id)].slice(0, 5)
      setRecent(next)
      saveRecent(next)
    } catch (e) {
      setMsg(`Could not load that area: ${(e as Error).message}`)
    }
  }

  const pick = (o: Option) => {
    if (o.type === 'unit') return choose(o.unit.id)
    const pl = o.place
    if (!pl.in_coverage) {
      setOpen(false)
      setMsg(`${pl.name}${pl.country ? `, ${pl.country}` : ''} is outside our data coverage (${coverageText(p.meta)}).`)
      return
    }
    const id = pl.district_id ?? pl.state_id ?? pl.country_id
    return id ? choose(id, pl) : choose(`c${pl.lon},${pl.lat},${RADIUS_KM}`, pl)
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(a => Math.min(options.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)) }
    else if (e.key === 'Enter' && open && options[active]) { e.preventDefault(); pick(options[active]) }
    else if (e.key === 'Escape') { setOpen(false) }
  }

  const sel = p.area && 'region' in p.area ? p.area.region : null
  const chipCls = (on: boolean) => (on ? buttonCls('secondary').replace('border-line', 'border-accent').replace('bg-panel', 'bg-accent/15') : buttonCls('secondary'))
  const isPreset = (b: BBox) => !!p.area && 'bbox' in p.area && p.area.bbox.join() === b.join()

  return (
    <div className="flex flex-col gap-2">
      {/* search */}
      <div className="relative">
        <label htmlFor={`${listId}-in`} className="sr-only">Search country, state, district or place</label>
        <input ref={inputRef} id={`${listId}-in`} type="search" autoComplete="off" spellCheck={false}
          role="combobox" aria-expanded={open && options.length > 0} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${listId}-o${active}` : undefined}
          placeholder={hasBoundaries ? 'Search country, state, district or place…' : 'Search needs boundaries (run build_boundaries.py)'}
          disabled={!hasBoundaries}
          className="w-full h-8 px-3 bg-bg border border-line rounded-md text-sm text-ink placeholder:text-dim focus:border-dim"
          value={q} onChange={e => { setQ(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={onKey} />
        {open && q.trim() && (
          <ul id={listId} role="listbox" aria-label="Search results"
            className="absolute z-20 left-0 right-0 mt-1 bg-panel border border-line rounded-md max-h-[320px] overflow-y-auto py-1">
            {options.length === 0 && placeState !== 'loading' && <li className="px-3 py-2 text-xs text-dim">No matches</li>}
            {options.map((o, i) => {
              const first = o.type === 'place' && (i === 0 || options[i - 1].type === 'unit')
              const title = o.type === 'unit' ? o.unit.name : o.place.name
              const kind = o.type === 'unit' ? o.unit.kind : o.place.type
              const parent = o.type === 'unit' ? o.unit.parent
                : o.place.in_coverage ? [o.place.district, o.place.state, o.place.country].filter(Boolean).join(', ')
                  : [o.place.state, o.place.country].filter(Boolean).join(', ') + ' · outside data'
              return (
                <li key={i} role="presentation">
                  {first && <div className="px-3 pt-2 pb-1 text-xs font-semibold text-dim">Places</div>}
                  <div id={`${listId}-o${i}`} role="option" aria-selected={i === active}
                    onMouseDown={e => { e.preventDefault(); pick(o) }} onMouseEnter={() => setActive(i)}
                    className={`px-3 py-2 cursor-pointer text-sm ${i === active ? 'bg-ink/5' : ''}`}>
                    <span className="text-ink">{title}</span>
                    <span className="text-dim"> · {kind}{parent ? ` · ${parent}` : ''}</span>
                  </div>
                </li>
              )
            })}
            {placeState === 'loading' && <li className="px-3 py-1 text-xs text-dim">Searching places…</li>}
            {placeState === 'error' && <li className="px-3 py-1 text-xs text-dim">Place search unavailable (offline?); states and districts still work.</li>}
          </ul>
        )}
      </div>

      {msg && <p role="alert" className="text-xs text-accent border border-accent/40 rounded-sm px-2 py-2">{msg}</p>}

      {/* selected area chip */}
      {sel && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 h-8 pl-3 pr-1 rounded-md border border-accent bg-accent/15 text-sm text-ink">
            {regionLabel(sel)} <span className="text-dim">· {sel.kind}</span>
            <button aria-label={`Remove ${regionLabel(sel)}`} className="w-5 h-5 rounded-sm hover:bg-ink/5 text-dim"
              onClick={() => { p.setArea(null); setFromPlace(null) }}>✕</button>
          </span>
          {fromPlace && (sel.level === 3
            ? <button className={buttonCls('ghost')}
                onClick={() => fromPlace.district_id && choose(fromPlace.district_id, fromPlace)}>Use the district instead</button>
            : <button className={buttonCls('ghost')}
                onClick={() => choose(`c${fromPlace.lon},${fromPlace.lat},${RADIUS_KM}`, fromPlace)}>
                Use {RADIUS_KM} km around {fromPlace.name} instead
              </button>)}
        </div>
      )}

      {/* quick chips, recent, draw */}
      <div className="flex flex-wrap gap-2">
        {PRESETS.map(pr => (
          <button key={pr.name} className={chipCls(isPreset(pr.bbox))} aria-pressed={isPreset(pr.bbox)}
            onClick={() => { p.setArea({ bbox: pr.bbox }); setFromPlace(null) }}>{pr.name}</button>
        ))}
        <button className={chipCls(p.drawing)} aria-pressed={p.drawing} onClick={() => p.setDrawing(!p.drawing)}>
          {p.drawing ? 'Drawing… drag on map' : 'Draw box'}
        </button>
        {p.area && !sel && <button className={chipCls(false)} onClick={() => p.setArea(null)}>Clear</button>}
      </div>
      {recent.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-dim w-12">Recent</span>
          {recent.map(r => (
            <button key={r.id} className={buttonCls('secondary')}
              onClick={() => choose(r.id)} title={`${regionLabel(r)} · ${r.kind}`}>{r.name}</button>
          ))}
        </div>
      )}

      <Coordinates area={p.area} setArea={p.setArea} />
    </div>
  )
}

const COORD_NAMES = ['West longitude', 'South latitude', 'East longitude', 'North latitude']

/** Why a [west, south, east, north] entry can't be applied, or null when it can. */
export function bboxError(v: string[]): string | null {
  const blank = v.findIndex(x => x.trim() === '')
  if (blank >= 0) return `Enter the ${COORD_NAMES[blank].toLowerCase()}.`
  const bad = v.findIndex(x => Number.isNaN(+x))
  if (bad >= 0) return `${COORD_NAMES[bad]} must be a number, e.g. 75.5 or -12.`
  const [w, s, e, n] = v.map(Number)
  if (w < -180 || w > 180 || e < -180 || e > 180) return 'Longitudes must be between -180 and 180.'
  if (s < -90 || s > 90 || n < -90 || n > 90) return 'Latitudes must be between -90 and 90.'
  if (w >= e) return 'West longitude must be less than east longitude.'
  if (s >= n) return 'South latitude must be less than north latitude.'
  return null
}

function Coordinates({ area, setArea }: { area: Area; setArea: (a: Area) => void }) {
  const box = area && 'bbox' in area ? area.bbox : area && 'region' in area ? area.region.bbox : undefined
  const [v, setV] = useState<string[]>(['', '', '', ''])
  useEffect(() => setV(box ? box.map(x => String(+x.toFixed(3))) : ['', '', '', '']), [box?.join()])
  const nums = v.map(Number)
  const error = bboxError(v)
  const valid = error === null
  return (
    <Disclosure summary="Enter coordinates">
      <form className="grid grid-cols-[repeat(4,1fr)_auto] gap-2 items-end"
        onSubmit={e => { e.preventDefault(); if (valid) setArea({ bbox: nums as BBox }) }}>
        {['West °E', 'South °N', 'East °E', 'North °N'].map((l, i) => (
          <label key={l} className="text-xs text-dim">
            {l}
            <input className="num mt-1 w-full h-8 px-2 bg-bg border border-line rounded-md text-sm text-ink"
              inputMode="decimal" aria-describedby="coord-error" aria-invalid={!!error && v.some(x => x.trim())} value={v[i]} onChange={e => setV(v.map((x, j) => (j === i ? e.target.value : x)))} />
          </label>
        ))}
        <button type="submit" disabled={!valid} aria-describedby="coord-error"
          className={buttonCls('secondary')}>Apply</button>
        <p id="coord-error" role="status" className="col-span-5 text-xs text-accent min-h-[1em]">
          {error && v.some(x => x.trim()) ? error : ''}
        </p>
      </form>
    </Disclosure>
  )
}

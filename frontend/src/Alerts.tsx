import { useEffect, useState } from 'react'
import { areaParams, regionLabel, url, type Area, type BBox, type Meta, type Region } from './api'
import type { TLAction } from './timeline'

interface Watched { key: string; name: string; region?: string; bbox?: BBox } // region id or bbox; neither = full extent
interface Alert { kind: string; severity: 'Info' | 'Watch' | 'Warning' | 'Record'; message: string; asof: string; provisional: boolean; window?: [string, string] }
const KEY = 'hots45.watched', MAX = 20
const RANK = { Record: 3, Warning: 2, Watch: 1, Info: 0 }
const CHIP: Record<Alert['severity'], string> = { Info: 'border-line text-dim', Watch: 'border-[#E8743B] text-[#E8743B]', Warning: 'bg-[#B2182B] border-[#B2182B] text-white', Record: 'bg-[#E8743B] border-[#E8743B] text-[#0B0D10]' }
const load = (): Watched[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]').slice(0, MAX) } catch { return [] } }
const save = (w: Watched[]) => { try { localStorage.setItem(KEY, JSON.stringify(w.slice(0, MAX))) } catch { /* private mode */ } }
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

const SCENARIOS = [
  { label: 'Punjab, 5 Nov 2021', q: 'punjab', parent: 'India', date: '2021-11-05' },
  { label: 'Riau/Indonesia, 15 Sep 2015', q: 'riau', parent: 'Indonesia', date: '2015-09-15' },
  { label: 'Asia, 10 Apr 2003', q: null, parent: '', date: '2003-04-10' },
]

export default function Alerts({ meta, area, setArea, months, dispatch }: {
  meta: Meta; area: Area; setArea: (a: Area) => void; months: string[]; dispatch: (a: TLAction) => void
}) {
  const dataEnd = new Date(Date.UTC(+meta.last_month.slice(0, 4), +meta.last_month.slice(5, 7), 0)).toISOString().slice(0, 10)
  const [open, setOpen] = useState(false)
  const [watched, setWatched] = useState<Watched[]>(load)
  const [sim, setSim] = useState<string | null>(null)
  const [simPick, setSimPick] = useState('2021-11-05')
  const [feed, setFeed] = useState<(Alert & { area: Watched; id: string })[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const asof = sim ?? dataEnd
  const update = (w: Watched[]) => { setWatched(w); save(w) }

  // evaluate every watched area as of the (real or simulated) date
  useEffect(() => {
    let live = true
    setChecking(true)
    Promise.all(watched.map(w => fetch(url('/api/alerts', { asof, region: w.region, bbox: w.bbox })).then(r => (r.ok ? r.json() : [])).catch(() => [])
      .then((as: Alert[]) => as.map(a => ({ ...a, area: w, id: `${w.key}|${a.kind}|${a.asof}` })))))
      .then(all => { if (live) { setFeed(all.flat().sort((a, b) => RANK[b.severity] - RANK[a.severity] || b.asof.localeCompare(a.asof))); setChecking(false) } })
    return () => { live = false }
  }, [watched, asof])
  const shown = feed.filter(a => !dismissed.has(a.id))

  const watchCurrent = () => {
    const p = areaParams(area)
    const name = !area ? (meta.region ?? 'Full extent') : 'region' in area ? regionLabel(area.region) : `Box ${area.bbox.map(v => +v.toFixed(1)).join(', ')}`
    const key = p.region ?? p.bbox?.join(',') ?? 'all'
    if (watched.some(w => w.key === key) || watched.length >= MAX) return
    update([...watched, { key, name, region: p.region, bbox: p.bbox }])
  }
  const showOnMap = async (w: Watched, d: string) => {
    if (w.region) { const r: Region = await fetch(url(`/api/region/${w.region}`, {})).then(x => x.json()); setArea({ region: r }) }
    else setArea(w.bbox ? { bbox: w.bbox } : null)
    const i = months.indexOf(d.slice(0, 7))
    if (i >= 0) dispatch({ type: 'month', i })
  }
  const scenario = async (s: (typeof SCENARIOS)[number]) => {
    let w: Watched = { key: 'all', name: meta.region ?? 'Full extent' }
    if (s.q) {
      const hits: Region[] = await fetch(url('/api/search', { q: s.q })).then(x => x.json())
      const r = hits.find(h => h.parent.endsWith(s.parent)) ?? hits[0]
      if (r) w = { key: r.id, name: regionLabel(r), region: r.id }
    }
    if (!watched.some(x => x.key === w.key)) update([...watched, w].slice(-MAX))
    setSim(s.date); setSimPick(s.date); setDismissed(new Set())
    showOnMap(w, s.date)
  }
  const btn = 'h-7 px-2.5 text-[12px] border border-line rounded-sm bg-raised hover:border-dim text-ink'

  return (
    <>
      {sim && (
        <div className="absolute left-1/2 -translate-x-1/2 top-[124px] z-20 flex items-center gap-2 bg-[#E8743B] text-[#0B0D10] text-[12px] font-medium px-3 py-1 rounded-sm" role="status">
          Simulation: showing alerts as of {dayLabel(sim)}
          <button className="underline" onClick={() => setSim(null)}>Exit</button>
        </div>
      )}
      <button className="relative h-7 px-2.5 text-[12px] border border-line rounded-sm bg-panel text-dim hover:text-ink" aria-expanded={open}
        aria-label={`Alerts, ${shown.length} active`} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden className="inline -mt-0.5"><path fill="currentColor" d="M8 1.5a4 4 0 0 0-4 4v2.8L2.8 11h10.4L12 8.3V5.5a4 4 0 0 0-4-4Zm-1.6 11a1.6 1.6 0 0 0 3.2 0Z" /></svg>
        {shown.length > 0 && <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 rounded-full bg-[#E8743B] text-[#0B0D10] text-[10px] font-semibold leading-4 text-center">{shown.length}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-30 w-[400px] max-h-[75vh] overflow-y-auto bg-panel border border-line rounded-md p-3 text-[12px] text-left" role="dialog" aria-label="Alerts">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[13px] font-semibold text-ink">Alerts · as of {dayLabel(asof)}</h2>
            <button className="text-dim hover:text-ink" aria-label="Close alerts" onClick={() => setOpen(false)}>✕</button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            <label className="text-faint" htmlFor="sim-date">Simulate date</label>
            <input id="sim-date" type="date" className="h-7 px-1.5 bg-bg border border-line rounded-sm text-ink num" min={`${meta.first_month}-01`} max={dataEnd}
              value={simPick} onChange={e => setSimPick(e.target.value)} />
            <button className={btn} onClick={() => { setSim(simPick); setDismissed(new Set()) }}>Simulate</button>
          </div>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {SCENARIOS.map(s => <button key={s.label} className={btn} onClick={() => scenario(s)}>{s.label}</button>)}
          </div>

          <ul className="flex flex-col gap-2 mb-3">
            {watched.length === 0 && <li className="text-faint">Watch an area to get alerts for it.</li>}
            {checking && <li className="text-faint" role="status">Checking {watched.length} watched area{watched.length === 1 ? '' : 's'}… (first check of an area can take a few seconds)</li>}
            {!checking && watched.length > 0 && shown.length === 0 && <li className="text-faint">No alerts for your watched areas as of this date.</li>}
            {shown.map(a => (
              <li key={a.id} className="border border-line rounded-sm p-2">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`px-1.5 rounded-sm border text-[11px] font-medium ${CHIP[a.severity]}`}>{a.severity}</span>
                  <span className="text-ink font-medium">{a.area.name}</span>
                  {a.provisional && <span className="text-faint text-[11px]">provisional</span>}
                </div>
                <p className="text-dim leading-snug">{a.message}</p>
                <div className="flex items-center gap-3 mt-1.5 text-[11px]">
                  <span className="text-faint num">{dayLabel(a.asof)}</span>
                  <button className="underline text-dim hover:text-ink" onClick={() => showOnMap(a.area, a.asof)}>Show on map</button>
                  <button className="underline text-dim hover:text-ink" onClick={() => setDismissed(new Set(dismissed).add(a.id))}>Dismiss</button>
                </div>
              </li>
            ))}
          </ul>

          <div className="border-t border-line pt-2 mb-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[12px] font-semibold text-ink">Watched areas ({watched.length}/{MAX})</span>
              <button className={btn} onClick={watchCurrent} disabled={watched.length >= MAX}>Watch this area</button>
            </div>
            <ul>
              {watched.map(w => (
                <li key={w.key} className="flex items-center gap-2 py-0.5">
                  {renaming === w.key ? (
                    <input autoFocus defaultValue={w.name} aria-label="Area name" className="flex-1 h-6 px-1.5 bg-bg border border-line rounded-sm text-ink"
                      onKeyDown={e => { if (e.key === 'Enter') { update(watched.map(x => (x.key === w.key ? { ...x, name: e.currentTarget.value || x.name } : x))); setRenaming(null) } if (e.key === 'Escape') setRenaming(null) }} />
                  ) : <span className="flex-1 truncate text-dim">{w.name}</span>}
                  <button className="text-[11px] underline text-dim hover:text-ink" onClick={() => setRenaming(w.key)}>Rename</button>
                  <button className="text-[11px] underline text-dim hover:text-ink" onClick={() => update(watched.filter(x => x.key !== w.key))}>Remove</button>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-[11px] text-faint leading-snug">
            Alerts are based on satellite hotspot statistics and are not official warnings. Satellites can miss fires under clouds or between overpasses.
          </p>
        </div>
      )}
    </>
  )
}

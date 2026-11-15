import { useEffect, useState } from 'react'
import { areaParams, regionLabel, url, type Area, type BBox, type Meta, type Region } from './api'
import type { TLAction } from './timeline'
import { Button, IconButton } from './ui'

interface Watched { key: string; name: string; region?: string; bbox?: BBox } // region id or bbox; neither = full extent
interface Alert { kind: string; severity: 'Info' | 'Watch' | 'Warning' | 'Record'; message: string; asof: string; provisional: boolean; window?: [string, string] }
const KEY = 'hots45.watched', MAX = 20
const RANK = { Record: 3, Warning: 2, Watch: 1, Info: 0 }
// severity ladder in the one accent colour: outline < tint < solid; Info is neutral
const CHIP: Record<Alert['severity'], string> = { Info: 'border-line text-dim', Watch: 'border-accent text-accent', Warning: 'border-accent bg-accent/25 text-ink', Record: 'border-accent bg-accent text-bg' }
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
  const [failed, setFailed] = useState(0) // areas whose check failed: never report those as "no alerts"
  const [retry, setRetry] = useState(0)
  const asof = sim ?? dataEnd
  const update = (w: Watched[]) => { setWatched(w); save(w) }

  // evaluate every watched area as of the (real or simulated) date
  useEffect(() => {
    let live = true
    setChecking(true)
    Promise.all(watched.map(w => fetch(url('/api/alerts', { asof, region: w.region, bbox: w.bbox }))
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then((as: Alert[]) => as.map(a => ({ ...a, area: w, id: `${w.key}|${a.kind}|${a.asof}` })), () => null)))
      .then(all => {
        if (!live) return
        setFailed(all.filter(x => x === null).length)
        setFeed(all.flatMap(x => x ?? []).sort((a, b) => RANK[b.severity] - RANK[a.severity] || b.asof.localeCompare(a.asof)))
        setChecking(false)
      })
    return () => { live = false }
  }, [watched, asof, retry])
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

  const note = 'text-dim border border-dashed border-line rounded-md px-4 py-3'
  const X = <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 4l8 8M12 4l-8 8" /></svg>

  return (
    <>
      {sim && (
        <div className="fixed left-1/2 -translate-x-1/2 top-[144px] z-20 h-8 flex items-center gap-2 bg-accent text-bg text-sm font-semibold pl-3 pr-1 rounded-md" role="status">
          Simulation: alerts as of <span className="num">{dayLabel(sim)}</span>
          <button className="h-6 px-2 rounded-sm underline hover:bg-bg/10" onClick={() => setSim(null)}>Exit</button>
        </div>
      )}
      <IconButton label={`Alerts, ${shown.length} active`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path fill="currentColor" d="M8 1.5a4 4 0 0 0-4 4v2.8L2.8 11h10.4L12 8.3V5.5a4 4 0 0 0-4-4Zm-1.6 11a1.6 1.6 0 0 0 3.2 0Z" /></svg>
        {shown.length > 0 && <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-accent text-bg text-xs font-semibold leading-4 text-center">{shown.length}</span>}
      </IconButton>
      {open && (
        <div className="absolute right-0 top-10 z-30 w-[400px] max-h-[calc(100vh-96px)] overflow-y-auto bg-panel border border-line rounded-md p-4 text-sm text-left flex flex-col gap-4"
          role="dialog" aria-label="Alerts" onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}>
          <div className="flex items-center justify-between -my-1 -mr-2">
            <h2 className="text-sm font-semibold text-ink">Alerts <span className="font-normal text-dim">· as of <span className="num">{dayLabel(asof)}</span></span></h2>
            <IconButton label="Close alerts" onClick={() => setOpen(false)}>{X}</IconButton>
          </div>

          <section className="flex flex-col gap-2" aria-label="Simulate a past date">
            <div className="flex items-center gap-2">
              <label className="text-xs text-dim" htmlFor="sim-date">Simulate date</label>
              <input id="sim-date" type="date" className="h-8 px-2 bg-bg border border-line rounded-md text-sm text-ink num" min={`${meta.first_month}-01`} max={dataEnd}
                value={simPick} onChange={e => setSimPick(e.target.value)} />
              <Button onClick={() => { setSim(simPick); setDismissed(new Set()) }}>Simulate</Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {SCENARIOS.map(s => <Button key={s.label} variant="secondary" onClick={() => scenario(s)}>{s.label}</Button>)}
            </div>
          </section>

          <ul className="flex flex-col gap-2">
            {watched.length === 0 && <li className={note}>No watched areas yet. Select an area, then “Watch this area”.</li>}
            {checking && <li className="text-dim" role="status">Checking {watched.length} watched area{watched.length === 1 ? '' : 's'}… (the first check of an area can take a few seconds)</li>}
            {!checking && failed > 0 && (
              <li className="text-ink border border-accent/60 rounded-md px-4 py-3 flex items-center justify-between gap-2" role="alert">
                <span><span className="text-accent font-semibold">Error · </span>Could not check {failed} watched area{failed === 1 ? '' : 's'}.</span>
                <Button variant="ghost" onClick={() => setRetry(n => n + 1)}>Retry</Button>
              </li>
            )}
            {!checking && failed === 0 && watched.length > 0 && shown.length === 0 && <li className={note}>No alerts for your watched areas as of this date.</li>}
            {shown.map(a => (
              <li key={a.id} className="border border-line rounded-md p-3 flex flex-col gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`h-6 px-2 inline-flex items-center rounded-sm border text-xs font-semibold shrink-0 ${CHIP[a.severity]}`}>{a.severity}</span>
                  <span className="text-ink font-semibold truncate">{a.area.name}</span>
                  {a.provisional && <span className="text-dim text-xs shrink-0">provisional</span>}
                  <span className="ml-auto text-dim text-xs num shrink-0">{dayLabel(a.asof)}</span>
                </div>
                <p className="text-dim">{a.message}</p>
                <div className="flex items-center gap-1 -ml-3">
                  <Button variant="ghost" onClick={() => showOnMap(a.area, a.asof)}>Show on map</Button>
                  <Button variant="ghost" onClick={() => setDismissed(new Set(dismissed).add(a.id))}>Dismiss</Button>
                </div>
              </li>
            ))}
          </ul>

          <section className="border-t border-line pt-4" aria-labelledby="watched-h">
            <div className="flex items-center justify-between mb-2">
              <h3 id="watched-h" className="text-sm font-semibold text-ink">Watched areas <span className="font-normal text-dim num">{watched.length}/{MAX}</span></h3>
              <Button onClick={watchCurrent} disabled={watched.length >= MAX}>Watch this area</Button>
            </div>
            <ul>
              {watched.map(w => (
                <li key={w.key} className="flex items-center gap-1 h-8">
                  {renaming === w.key ? (
                    <input autoFocus defaultValue={w.name} aria-label="Area name" className="flex-1 h-8 px-2 bg-bg border border-line rounded-md text-sm text-ink"
                      onKeyDown={e => { if (e.key === 'Enter') { update(watched.map(x => (x.key === w.key ? { ...x, name: e.currentTarget.value || x.name } : x))); setRenaming(null) } if (e.key === 'Escape') setRenaming(null) }} />
                  ) : <span className="flex-1 truncate text-ink">{w.name}</span>}
                  <Button variant="ghost" onClick={() => setRenaming(w.key)}>Rename</Button>
                  <Button variant="ghost" onClick={() => update(watched.filter(x => x.key !== w.key))}>Remove</Button>
                </li>
              ))}
            </ul>
          </section>
          <p className="text-xs text-dim">
            Alerts are based on satellite hotspot statistics and are not official warnings. Satellites can miss fires under clouds or between overpasses.
          </p>
        </div>
      )}
    </>
  )
}

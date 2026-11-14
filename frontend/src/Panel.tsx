import React, { memo, useEffect, useMemo, type ReactNode } from 'react'
import ReactECharts from 'echarts-for-react'
import AreaControls from './Area'
import Calendar from './Calendar'
import { lineOption } from './charts'
import BeforeAfter from './BeforeAfter'
import type { ChartKey } from './url'
import { areaParams, regionLabel, url, useApi, type Area, type BBox, type Meta, type Region, type SeriesRow, type Summary, type TopArea } from './api'
import { ACCENT, BELOW, MONTHS, fmt, monthLabel } from './colors'


interface Props {
  meta: Meta
  area: Area
  setArea: (a: Area) => void
  start: string
  end: string
  drawing: boolean
  setDrawing: (d: boolean) => void
  onSeries: (s?: SeriesRow[]) => void
  view?: BBox
  periodLabel: string
  onPickMonth: (m: string) => void
  expand: (c: ChartKey) => { href: string; onClick: (e: React.MouseEvent) => void }
}

const intersects = (a: BBox, b: BBox) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3])

export default memo(function Panel(p: Props) {
  const ap = areaParams(p.area)
  const cov = p.meta.coverage_bbox
  const box = p.area ? ('region' in p.area ? p.area.region.bbox : p.area.bbox) : undefined
  const outside = !!(box && cov && !intersects(box, cov))
  const series = useApi<SeriesRow[]>(outside ? null : url('/api/series', ap))
  const summary = useApi<Summary>(outside ? null : url('/api/summary', { ...ap, start: p.start, end: p.end }), 200)
  const rows = series.data
  const firstYear = +p.meta.first_month.slice(0, 4), lastYear = +p.meta.last_month.slice(0, 4)
  const nYears = lastYear - firstYear + 1
  const { onSeries } = p
  useEffect(() => onSeries(outside ? undefined : rows), [rows, onSeries, outside])

  const label = !p.area ? 'Full data extent'
    : 'region' in p.area ? `${regionLabel(p.area.region)} · ${p.area.region.kind}`
      : `${p.area.bbox[1]}–${p.area.bbox[3]}°N, ${p.area.bbox[0]}–${p.area.bbox[2]}°E`
  const empty = summary.data && summary.data.total === 0

  return (
    <div className="flex flex-col gap-3 p-3">
      <Card title="Area">
        <AreaControls meta={p.meta} area={p.area} setArea={p.setArea} drawing={p.drawing} setDrawing={p.setDrawing} />
      </Card>

      <div className="text-[11px] text-dim -mb-1">
        <span className="text-ink font-medium">{label}</span> · <span className="num">{monthLabel(p.start)} – {monthLabel(p.end)}</span>
      </div>

      {outside ? (
        <p className="border border-accent/40 rounded-md p-3 text-[12px] text-ink" role="status">
          This area is outside our data coverage ({p.meta.region ?? 'data area'}: {cov?.[0]}–{cov?.[2]}°E, {cov?.[1]}–{cov?.[3]}°N),
          so there are no hotspots to show. Pick an area inside it.
        </p>
      ) : (
        <>
          <Status l={summary} what="summary" />
          {summary.data && <Kpis s={summary.data} rows={rows} />}
          <TopAreas start={p.start} end={p.end} view={p.view} periodLabel={p.periodLabel} area={p.area} setArea={p.setArea} />
          {empty && (
            <p className="border border-line rounded-md p-3 text-dim" role="status">
              No hotspots recorded in this area between {monthLabel(p.start)} and {monthLabel(p.end)}. Try a larger area or a longer range.
            </p>
          )}
          <Status l={series} what="monthly series" />
          {rows && <Charts rows={rows} meta={p.meta} onPickMonth={p.onPickMonth} selected={[p.start, p.end]} expand={p.expand} />}
        </>
      )}

      <MethodCard meta={p.meta} nYears={nYears} />

      <Card title="Download" sub={`CSV, UTC dates${p.area && 'region' in p.area ? ' · hotspots inside the exact outline' : ''}`}>
        <div className="flex flex-wrap gap-2">
          <a className="h-7 px-2.5 inline-flex items-center border border-line rounded-sm bg-raised hover:border-dim text-[12px]"
            href={url('/api/download', { ...ap, start: p.start, end: p.end })} download>Hotspots CSV</a>
          <a className="h-7 px-2.5 inline-flex items-center border border-line rounded-sm bg-raised hover:border-dim text-[12px]"
            href={url('/api/download/series', ap)} download>Monthly series CSV</a>
        </div>
      </Card>
    </div>
  )
})

function TopAreas({ start, end, view, periodLabel, area, setArea }: {
  start: string; end: string; view?: BBox; periodLabel: string; area: Area; setArea: (a: Area) => void
}) {
  // a selected area wins over the visible map area (a tilted view can reach far beyond it)
  const sel = areaParams(area)
  const scope = sel.region || sel.bbox ? sel : { bbox: view }
  const top = useApi<TopArea[]>(url('/api/top', { start, end, ...scope }), 300)
  const selectedId = area && 'region' in area ? area.region.id : null
  const pick = async (t: TopArea) => {
    const r = await fetch(url(`/api/region/${t.id}`, {})).then(x => x.json() as Promise<Region>)
    setArea({ region: r })
  }
  return (
    <Card title="Top 10 fire areas" sub={`Districts (or states) in ${area ? 'the selected area' : view ? 'the current map view' : 'the whole record'} · ${periodLabel}`}>
      <Status l={top} what="top areas" />
      {top.data && top.data.length === 0 && <p className="text-[12px] text-faint">No hotspots in view for this period.</p>}
      <ol className="flex flex-col">
        {(top.data ?? []).map((t, i) => (
          <li key={t.id}>
            <button onClick={() => pick(t)} aria-pressed={selectedId === t.id}
              className={`w-full grid grid-cols-[18px_1fr_auto_40px] gap-2 items-center text-left px-1.5 py-1 rounded-sm text-[12px] ${selectedId === t.id ? 'bg-accent/15' : 'hover:bg-raised'}`}>
              <span className="num text-faint">{i + 1}</span>
              <span className="truncate"><span className="text-ink">{t.name}</span><span className="text-faint"> · {t.parent}</span></span>
              <span className="num text-ink">{fmt(t.hotspots)}</span>
              <span className="num text-[10px] text-faint text-right">{t.share.toFixed(1)}%</span>
            </button>
          </li>
        ))}
      </ol>
      {!!top.data?.length && <p className="text-[10px] text-faint mt-1">Hotspots (VIIRS-equivalent) and share of the view's total. Click to fly there and select its outline.</p>}
    </Card>
  )
}

function Charts({ rows, meta, onPickMonth, selected, expand }: {
  rows: SeriesRow[]; meta: Meta; onPickMonth: (m: string) => void; selected: [string, string]; expand: Props['expand']
}) {
  const span = `${meta.first_month.slice(0, 4)}–${meta.last_month.slice(0, 4)}`
  const line = useMemo(() => lineOption(rows), [rows])
  const ex = (c: ChartKey) => {
    const l = expand(c)
    return <a {...l} className="shrink-0 text-[11px] text-dim hover:text-ink underline underline-offset-2" aria-label="Expand chart to full screen">Expand ⤢</a>
  }
  return (
    <>
      <Card title="Burning calendar" sub={`Monthly hotspots for the selected area, ${span}`} action={ex('calendar')} onTitle={expand('calendar').onClick}>
        <Calendar rows={rows} meta={meta} onPickMonth={onPickMonth} selected={selected} />
      </Card>
      <Card title="Monthly hotspots" sub={`Hotspots per month (VIIRS-equivalent) with ${span} median and mean ± 1σ by calendar month`} action={ex('monthly')} onTitle={expand('monthly').onClick}>
        <ReactECharts option={line} style={{ height: 210 }} notMerge />
      </Card>
      <Card title="Before vs after harmonization" sub="Hotspots per month: raw sensor counts vs the harmonized record (VIIRS-equivalent)" action={ex('before-after')} onTitle={expand('before-after').onClick}>
        <BeforeAfter rows={rows} meta={meta} />
      </Card>
    </>
  )
}

function Status({ l, what }: { l: { loading: boolean; error?: string; data?: unknown }; what: string }) {
  if (l.error) return <p role="alert" className="text-[12px] text-accent border border-accent/40 rounded-md p-2">Could not load {what}: {l.error}</p>
  if (l.loading && !l.data) return <p className="text-[12px] text-faint" role="status">Loading {what}…</p>
  return null
}

function Card({ title, sub, action, children, onTitle }: { title: string; sub?: string; action?: ReactNode; children: ReactNode; onTitle?: (e: React.MouseEvent) => void }) {
  return (
    <section className="bg-panel border border-line rounded-md p-3">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <h2 className={`text-[12px] font-semibold text-ink ${onTitle ? 'cursor-pointer hover:underline' : ''}`} onClick={onTitle}>{title}</h2>
          {sub && <p className="text-[11px] text-faint">{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function Kpis({ s, rows }: { s: Summary; rows?: SeriesRow[] }) {
  const vs = (cur: number, med: number) => {
    if (!(med > 0)) return { text: '—', color: undefined }
    const d = ((cur - med) / med) * 100
    if (Math.abs(d) < 5) return { text: '≈ normal', color: undefined }
    return { text: `${d > 0 ? '▲ +' : '▼ −'}${Math.abs(Math.round(d))}%`, color: d > 0 ? ACCENT : BELOW }
  }
  const sel = (rows ?? []).filter(r => r.month >= s.start && r.month <= s.end)
  let cards: [string, ReactNode, ReactNode?][]
  if (s.start === s.end && sel.length) {
    const r = sel[0], mon = MONTHS[+r.month.slice(5, 7) - 1], yr = r.month.slice(0, 4)
    const same = (rows ?? []).filter(x => x.month.slice(5, 7) === r.month.slice(5, 7)).map(x => x.hotspots).sort((x, y) => y - x)
    const rank = same.indexOf(r.hotspots) + 1
    const yearTotal = (rows ?? []).filter(x => x.month.startsWith(yr)).reduce((t, x) => t + x.hotspots, 0)
    const ord = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4) % 4] ?? 'th'}`
    const v = vs(r.hotspots, r.hist_median)
    cards = [
      [`Hotspots, ${monthLabel(r.month)}`, fmt(r.hotspots), 'VIIRS-equivalent'],
      [`vs median for ${mon}`, <span style={{ color: v.color }}>{v.text}</span>, `median ${fmt(r.hist_median)}`],
      ['Rank', `${ord(rank)} of ${same.length}`, `highest ${mon} since ${rows![0].month.slice(0, 4)}`],
      [`Share of ${yr}`, yearTotal ? `${Math.round((r.hotspots / yearTotal) * 100)}%` : '—', `of ${fmt(yearTotal)} in ${yr}`],
    ]
  } else {
    const total = sel.reduce((t, x) => t + x.hotspots, 0), normal = sel.reduce((t, x) => t + x.hist_median, 0)
    const v = vs(total, normal)
    cards = [
      ['Total hotspots', fmt(s.total), `${sel.length} months, VIIRS-equivalent`],
      ['Peak month in range', s.peak_month ? monthLabel(s.peak_month) : '—', `${fmt(s.peak_month_hotspots)} hotspots`],
      ['vs normal', <span style={{ color: v.color }}>{v.text}</span>, `normal ${fmt(normal)}`],
      ['Anomalous months', fmt(s.anomalous_months), '|z| > 2'],
    ]
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      {cards.map(([k, v, sub]) => (
        <div key={k} className="bg-panel border border-line rounded-md px-3 py-2">
          <div className="text-[11px] text-dim">{k}</div>
          <div className="num text-[18px] leading-7 text-ink">{v}</div>
          {sub && <div className="text-[11px] text-faint">{sub}</div>}
        </div>
      ))}
    </div>
  )
}

function MethodCard({ meta, nYears }: { meta: Meta; nYears: number }) {
  const noModisOnly = meta.viirs_start <= meta.first_month
  const fy = meta.first_month.slice(0, 4), ly = meta.last_month.slice(0, 4)
  const notes = [!meta.first_month.endsWith('-01') && `${fy} partial`, !meta.last_month.endsWith('-12') && `${ly} partial`].filter(Boolean)
  const coverage = `${meta.region ? `${meta.region}, ` : ''}${fy}–${ly}${notes.length ? ` (${notes.join(', ')})` : ''}`
  const nTiles = Object.keys(meta.factor_by_tile ?? {}).length
  return (
    <Card title="Method" sub="Harmonization of MODIS to the VIIRS S-NPP scale">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 mb-2 text-[11px]">
        <dt className="text-dim">Coverage</dt><dd className="num text-ink">{coverage}</dd>
        <dt className="text-dim">Global factor k</dt><dd className="num text-ink">{meta.factor_global.toFixed(3)}</dd>
        <dt className="text-dim">R² on overlap</dt><dd className="num text-ink">{meta.r2_overlap.toFixed(3)}</dd>
        <dt className="text-dim">Record</dt><dd className="num text-ink">{meta.first_month} – {meta.last_month}</dd>
        <dt className="text-dim">VIIRS from</dt><dd className="num text-ink">{meta.viirs_start}</dd>
      </dl>
      <div className="text-[10px] text-faint mb-1">{nTiles ? `${meta.region ?? 'Domain'}-wide` : 'Domain'} k by calendar month</div>
      <div className="grid grid-cols-6 gap-1 mb-2" aria-label="Factor k by calendar month">
        {MONTHS.map((m, i) => (
          <div key={m} className="bg-bg border border-line rounded-sm px-1 py-0.5 text-center">
            <div className="text-[9px] text-faint">{m}</div>
            <div className="num text-[11px]">{meta.factor_by_month[String(i + 1).padStart(2, '0')]?.toFixed(2) ?? '—'}</div>
          </div>
        ))}
      </div>
      {nTiles > 0 && (
        <p className="num text-[11px] text-dim mb-2">
          {nTiles} tiles of {meta.tile_deg}°, {nTiles * 12 - (meta.tile_months_fallback ?? 0)} of {nTiles * 12} tile-months fitted locally
        </p>
      )}
      <p className="text-[11px] text-dim leading-relaxed">{meta.method}</p>
      {meta.rows && (
        <p className="num text-[10px] text-faint leading-relaxed mt-2">
          {Object.entries(meta.rows).map(([s, r]) => `${s}: ${fmt(r.clean)} hotspots used (${fmt(r.duplicates + (r.nrt_overlap ?? 0))} duplicates removed)`).join(' · ')}
        </p>
      )}
      {nYears < 6 && (
        <p className="text-[11px] text-ink leading-relaxed mt-2 border-l-2 border-accent pl-2">
          The current record covers only {meta.first_month.slice(0, 4)}–{meta.last_month.slice(0, 4)} ({nYears} years).
          Historical medians are based on {nYears} values per calendar month, and with fewer than 6 years |z| cannot
          exceed 2 (maximum √(n−1) = {Math.sqrt(nYears - 1).toFixed(2)}), so anomaly flags cannot trigger yet.
        </p>
      )}
      {noModisOnly && (
        <p className="text-[11px] text-dim leading-relaxed mt-2">
          VIIRS covers the whole record, so harmonized values equal VIIRS; the factors are fitted for reference.
        </p>
      )}
      <DataNotes meta={meta} />
      <p className="text-[10px] text-faint mt-2">Source: NASA FIRMS MCD14ML (MODIS), VNP14IMGML (VIIRS S-NPP).</p>
    </Card>
  )
}

function DataNotes({ meta }: { meta: Meta }) {
  const notes = meta.month_notes ?? {}
  // "VIIRS data gap (3–6 Nov)" -> "3–6 Nov 2024"
  const gaps = (meta.gap_months ?? []).map(m => `${notes[m]?.match(/data gap \(([^)]*)\)/)?.[1] ?? monthLabel(m)} ${m.slice(0, 4)}`)
  const prov = meta.provisional_months ?? []
  const fit = meta.fit_window
  if (!gaps.length && !prov.length && !(fit && fit[1] < meta.last_month)) return null
  return (
    <section className="mt-3 border-t border-line pt-2" aria-labelledby="data-notes">
      <h3 id="data-notes" className="text-[11px] font-semibold text-ink mb-1">Data notes</h3>
      <ul className="text-[11px] text-dim leading-relaxed list-disc pl-4 space-y-1">
        {fit && fit[1] < meta.last_month && (
          <li>
            Factors are fitted on {monthLabel(fit[0])} – {monthLabel(fit[1])} only. After {fit[1].slice(0, 4)} the Aqua
            satellite's overpass drifted later in the afternoon and Terra's earlier, so MODIS sees a different share of
            the day's burning than VIIRS and a factor fitted on those years would be biased. The harmonized series uses
            VIIRS for those years and is not affected.
          </li>
        )}
        {gaps.length > 0 && (
          <li>
            VIIRS S-NPP outages (days with almost no detections anywhere in the record): {gaps.join('; ')}.
            These months are undercounted and are never flagged as anomalies.
          </li>
        )}
        {prov.length > 0 && (
          <li>
            {monthLabel(prov[0])}{prov.length > 1 ? ` – ${monthLabel(prov[prov.length - 1])}` : ''} come from near-real-time
            (NRT) data and are provisional until the standard archive is released.
          </li>
        )}
      </ul>
    </section>
  )
}


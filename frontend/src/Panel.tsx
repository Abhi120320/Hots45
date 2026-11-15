import React, { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import ReactECharts from 'echarts-for-react'
import AreaControls, { PRESETS as AREA_PRESETS } from './Area'
import Calendar from './Calendar'
import { downloadUrl, lineOption } from './charts'
import BeforeAfter from './BeforeAfter'
import type { ChartKey } from './url'
import { areaParams, regionLabel, url, useApi, type Area, type BBox, type Intensity, type LandCover, type Meta, type Outlook, type Region, type SeriesRow, type Summary, type TopArea } from './api'
import { FireTypeFilter, WhatIsBurning } from './LandCover'
import { MetricToggle, unitOf, type Metric } from './Metric'
import { OutlookCard } from './Outlook'
import { Empty, Kpi, KpiGrid, Section, State, buttonCls } from './ui'
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
  fireType: string
  setFireType: (v: string) => void
  metric: Metric
  setMetric: (m: Metric) => void
}

const intersects = (a: BBox, b: BBox) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3])

export default memo(function Panel(p: Props) {
  const ap = areaParams(p.area)
  const cov = p.meta.coverage_bbox
  const box = p.area ? ('region' in p.area ? p.area.region.bbox : p.area.bbox) : undefined
  const outside = !!(box && cov && !intersects(box, cov))
  const series = useApi<SeriesRow[]>(outside ? null : url('/api/series', ap))
  const met = p.metric === 'frp' ? 'frp' : undefined // KPIs and calendar: hotspot counts or total FRP (MW)
  const unit = unitOf(p.metric)
  const summary = useApi<Summary>(outside ? null : url('/api/summary', { ...ap, start: p.start, end: p.end, metric: met }), 200)
  const frpSeries = useApi<SeriesRow[]>(outside || !met ? null : url('/api/series', { ...ap, metric: met }))
  const inten = useApi<Intensity>(outside || !met ? null : url('/api/intensity', { ...ap, start: p.start, end: p.end }), 300)
  const rows = series.data
  const group = p.fireType === 'all' || met ? undefined : p.fireType
  const groupSeries = useApi<SeriesRow[]>(outside || !group ? null : url('/api/series', { ...ap, group }))
  const outlook = useApi<Outlook>(outside ? null : url('/api/outlook', ap), 300)
  const lc = useApi<LandCover>(outside || !p.meta.land_cover ? null : url('/api/landcover', { ...ap, start: p.start, end: p.end }), 200)
  const firstYear = +p.meta.first_month.slice(0, 4), lastYear = +p.meta.last_month.slice(0, 4)
  const nYears = lastYear - firstYear + 1
  const { onSeries } = p
  useEffect(() => onSeries(outside ? undefined : rows), [rows, onSeries, outside])

  const label = !p.area ? 'Full data extent'
    : 'region' in p.area ? `${regionLabel(p.area.region)} · ${p.area.region.kind}`
      : AREA_PRESETS.find(pr => pr.bbox.join() === (p.area as { bbox: BBox }).bbox.join())?.name
        ?? `${p.area.bbox[1]}–${p.area.bbox[3]}°N, ${p.area.bbox[0]}–${p.area.bbox[2]}°E`
  const empty = summary.data && summary.data.total === 0

  return (
    <div className="flex flex-col gap-6 p-4">
      <Section title="Area">
        <AreaControls meta={p.meta} area={p.area} setArea={p.setArea} drawing={p.drawing} setDrawing={p.setDrawing} />
      </Section>

      {outside ? (
        <Empty>
          This area is outside our data coverage ({p.meta.region ?? 'data area'}: {cov?.[0]}–{cov?.[2]}°E, {cov?.[1]}–{cov?.[3]}°N),
          so there are no hotspots to show. Pick an area inside it.
        </Empty>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-ink truncate" title={label}>{label}</h2>
            <MetricToggle meta={p.meta} value={p.metric} onChange={p.setMetric} />
            <State l={summary} what="summary" lines={4} />
            {met && <State l={frpSeries} what="FRP series" />}
            {summary.data && <Kpis s={summary.data} rows={met ? frpSeries.data : rows} unit={unit} intensity={met ? inten.data : undefined} />}
          </div>
          {p.meta.land_cover && (
            <Section title="What is burning" sub="Share of hotspots by land cover in this period">
              <State l={lc} what="land cover" />
              {lc.data && <WhatIsBurning lc={lc.data} />}
            </Section>
          )}
          <Section title="Outlook" sub={`Statistical outlook after ${monthLabel(p.meta.last_complete_month ?? p.meta.last_month)} · hotspots`}>
            <State l={outlook} what="outlook" />
            {outlook.data && <OutlookCard o={outlook.data} />}
          </Section>
          <TopAreas start={p.start} end={p.end} view={p.view} area={p.area} setArea={p.setArea} />
          {empty && <Empty>No fires in this area for this period. Try a larger area or a longer range.</Empty>}
          <State l={series} what="monthly series" height={240} />
          {group && <State l={groupSeries} what="filtered series" />}
          {rows && <Charts rows={rows} calRows={met ? frpSeries.data : group ? groupSeries.data : rows} unit={unit} meta={p.meta} onPickMonth={p.onPickMonth} selected={[p.start, p.end]} expand={p.expand}
            filter={<div className="flex flex-wrap gap-2"><MetricToggle meta={p.meta} value={p.metric} onChange={p.setMetric} />
              {!met && <FireTypeFilter meta={p.meta} value={p.fireType} onChange={p.setFireType} compact />}</div>}
            groupLabel={p.meta.land_cover?.groups.find(g => g.key === group)?.label} />}
        </>
      )}

      <MethodCard meta={p.meta} nYears={nYears} />

      <Section title="Download" sub={`CSV, UTC dates${p.area && 'region' in p.area ? ' · hotspots inside the exact outline' : ''}`}>
        <div className="flex flex-wrap gap-2">
          <HotspotsCsv href={url('/api/download', { ...ap, start: p.start, end: p.end })} name={`hots45_hotspots_${p.start}_${p.end}.csv`} />
          <a className={buttonCls('secondary')} href={url('/api/download/series', ap)} download>Monthly series CSV</a>
        </div>
      </Section>
    </div>
  )
})

function HotspotsCsv({ href, name }: { href: string; name: string }) {
  const [st, setSt] = useState<{ busy?: boolean; err?: string }>({})
  useEffect(() => setSt({}), [href]) // a new selection clears the old message
  const go = () => {
    setSt({ busy: true })
    downloadUrl(href, name).then(() => setSt({}), e => setSt({ err: e.message }))
  }
  return (
    <>
      <button onClick={go} disabled={st.busy} aria-busy={st.busy} className={buttonCls('secondary')}>
        {st.busy ? 'Preparing CSV…' : 'Hotspots CSV'}
      </button>
      {st.err && <p role="alert" className="basis-full text-sm text-ink"><span className="text-accent font-semibold">Error · </span>Download failed: {st.err}</p>}
    </>
  )
}

function TopAreas({ start, end, view, area, setArea }: {
  start: string; end: string; view?: BBox; area: Area; setArea: (a: Area) => void
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
    <Section title="Top 10 fire areas" sub={`Districts (or states) in ${area ? 'the selected area' : view ? 'the current map view' : 'the whole record'}`}>
      <State l={top} what="top areas" lines={5} />
      {top.data && top.data.length === 0 && <Empty>No fires in this area for this period.</Empty>}
      <ol className="flex flex-col">
        {(top.data ?? []).map((t, i) => (
          <li key={t.id}>
            <button onClick={() => pick(t)} aria-pressed={selectedId === t.id}
              className={`w-full h-8 grid grid-cols-[24px_1fr_auto_56px] gap-2 items-center text-left px-2 rounded-md text-sm ${selectedId === t.id ? 'bg-accent/15' : 'hover:bg-ink/5'}`}>
              <span className="num text-xs text-dim text-right">{i + 1}</span>
              <span className="truncate"><span className="text-ink">{t.name}</span><span className="text-dim"> · {t.parent}</span></span>
              <span className="num text-ink text-right">{fmt(t.hotspots)}</span>
              <span className="num text-xs text-dim text-right">{t.share.toFixed(1)}%</span>
            </button>
          </li>
        ))}
      </ol>
      {!!top.data?.length && <p className="text-xs text-dim mt-2">Hotspots (VIIRS-equivalent) and share of the view's total. Click to fly there and select its outline.</p>}
    </Section>
  )
}

function Charts({ rows, calRows, unit, meta, onPickMonth, selected, expand, filter, groupLabel }: {
  rows: SeriesRow[]; calRows?: SeriesRow[]; unit: string; meta: Meta; onPickMonth: (m: string) => void; selected: [string, string]; expand: Props['expand']
  filter: ReactNode; groupLabel?: string
}) {
  const span = `${meta.first_month.slice(0, 4)}–${meta.last_month.slice(0, 4)}`
  const line = useMemo(() => lineOption(rows), [rows])
  const ex = (c: ChartKey) => {
    const l = expand(c)
    return <a {...l} className={buttonCls('ghost', 'shrink-0 -mt-2 -mr-2')} aria-label="Expand chart to full screen">Expand</a>
  }
  return (
    <>
      <Section title="Burning calendar" sub={`Monthly ${unit === 'MW' ? 'total FRP (MW)' : `${groupLabel ? `${groupLabel.toLowerCase()} ` : ''}hotspots`} for the selected area, ${span}`} action={ex('calendar')} onTitle={expand('calendar').onClick}>
        <div className="mb-2">{filter}</div>
        {calRows && <Calendar rows={calRows} meta={meta} onPickMonth={onPickMonth} selected={selected} unit={unit} />}
      </Section>
      <Section title="Monthly hotspots" sub={`Hotspots per month (VIIRS-equivalent) with ${span} median and mean ± 1σ by calendar month`} action={ex('monthly')} onTitle={expand('monthly').onClick}>
        <ReactECharts option={line} style={{ height: 210 }} notMerge />
      </Section>
      <Section title="Before vs after harmonization" sub="Hotspots per month: raw sensor counts vs the harmonized record (VIIRS-equivalent)" action={ex('before-after')} onTitle={expand('before-after').onClick}>
        <BeforeAfter rows={rows} meta={meta} />
      </Section>
    </>
  )
}

function Kpis({ s, rows, unit, intensity }: { s: Summary; rows?: SeriesRow[]; unit: string; intensity?: Intensity }) {
  const frp = unit === 'MW'
  const u = (v: number) => `${fmt(v)}${frp ? ' MW' : ''}`
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
      [frp ? `Fire energy (ΣFRP), ${monthLabel(r.month)}` : `Hotspots, ${monthLabel(r.month)}`, u(r.hotspots), 'VIIRS-equivalent'],
      [`vs median for ${mon}`, <span style={{ color: v.color }}>{v.text}</span>, `median ${u(r.hist_median)}`],
      ['Rank', `${ord(rank)} of ${same.length}`, `highest ${mon} since ${rows![0].month.slice(0, 4)}`],
      [`Share of ${yr}`, yearTotal ? `${Math.round((r.hotspots / yearTotal) * 100)}%` : '—', `of ${u(yearTotal)} in ${yr}`],
    ]
  } else {
    const total = sel.reduce((t, x) => t + x.hotspots, 0), normal = sel.reduce((t, x) => t + x.hist_median, 0)
    const v = vs(total, normal)
    cards = frp ? [
      ['Total fire energy this period', u(s.total), `ΣFRP · ${sel.length} months`],
      ['Fire energy vs normal', <span style={{ color: v.color }}>{v.text}</span>, `normal ${u(normal)}`],
      ['Peak month in range', s.peak_month ? monthLabel(s.peak_month) : '—', u(s.peak_month_hotspots)],
    ] : [
      ['Total hotspots', fmt(s.total), `${sel.length} months · VIIRS-equiv.`],
      ['Peak month in range', s.peak_month ? monthLabel(s.peak_month) : '—', `${fmt(s.peak_month_hotspots)} hotspots`],
      ['vs normal', <span style={{ color: v.color }}>{v.text}</span>, `normal ${fmt(normal)}`],
      ['Anomalous months', fmt(s.anomalous_months), '|z| > 2'],
    ]
  }
  if (frp) {  // per-hotspot FRP is shown per sensor only: MODIS (1 km) and VIIRS (375 m) pixels see different fires
    const one = (x?: Intensity['sensors']['MODIS']) => (x ? `${fmt(x.mean, 1)}` : '—')
    const m = intensity?.sensors.MODIS, vi = intensity?.sensors.VIIRS
    cards.push(['FRP per hotspot, per sensor', <span className="text-sm">MODIS {one(m)} · VIIRS {one(vi)}</span>,
      `MW mean; 90th pct ${m ? fmt(m.p90, 0) : '—'} · ${vi ? fmt(vi.p90, 0) : '—'}. Not comparable across sensors`])
  }
  return (
    <KpiGrid>{cards.map(([k, v, sub]) => <Kpi key={k} label={k} value={v} sub={sub} />)}</KpiGrid>
  )
}

function MethodCard({ meta, nYears }: { meta: Meta; nYears: number }) {
  const noModisOnly = meta.viirs_start <= meta.first_month
  const fy = meta.first_month.slice(0, 4), ly = meta.last_month.slice(0, 4)
  const notes = [!meta.first_month.endsWith('-01') && `${fy} partial`, !meta.last_month.endsWith('-12') && `${ly} partial`].filter(Boolean)
  const coverage = `${meta.region ? `${meta.region}, ` : ''}${fy}–${ly}${notes.length ? ` (${notes.join(', ')})` : ''}`
  const nTiles = Object.keys(meta.factor_by_tile ?? {}).length
  return (
    <Section title="Method" sub="Harmonization of MODIS to the VIIRS S-NPP scale">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 mb-2 text-xs">
        <dt className="text-dim">Coverage</dt><dd className="num text-ink">{coverage}</dd>
        <dt className="text-dim">Global factor k</dt><dd className="num text-ink">{meta.factor_global.toFixed(3)}</dd>
        <dt className="text-dim">R² on overlap</dt><dd className="num text-ink">{meta.r2_overlap.toFixed(3)}</dd>
        <dt className="text-dim">Record</dt><dd className="num text-ink">{meta.first_month} – {meta.last_month}</dd>
        <dt className="text-dim">VIIRS from</dt><dd className="num text-ink">{meta.viirs_start}</dd>
      </dl>
      <div className="text-xs text-dim mb-1">{nTiles ? `${meta.region ?? 'Domain'}-wide` : 'Domain'} k by calendar month</div>
      <div className="grid grid-cols-6 gap-1 mb-2" aria-label="Factor k by calendar month">
        {MONTHS.map((m, i) => (
          <div key={m} className="bg-bg border border-line rounded-sm px-1 py-1 text-center">
            <div className="text-xs text-dim">{m}</div>
            <div className="num text-xs">{meta.factor_by_month[String(i + 1).padStart(2, '0')]?.toFixed(2) ?? '—'}</div>
          </div>
        ))}
      </div>
      {nTiles > 0 && (
        <p className="num text-xs text-dim mb-2">
          {nTiles} tiles of {meta.tile_deg}°, {nTiles * 12 - (meta.tile_months_fallback ?? 0)} of {nTiles * 12} tile-months fitted locally
        </p>
      )}
      <p className="text-xs text-dim leading-relaxed">{meta.method}</p>
      {meta.rows && (
        <p className="num text-xs text-dim leading-relaxed mt-2">
          {Object.entries(meta.rows).map(([s, r]) => `${s}: ${fmt(r.clean)} hotspots used (${fmt(r.duplicates + (r.nrt_overlap ?? 0))} duplicates removed)`).join(' · ')}
        </p>
      )}
      {nYears < 6 && (
        <p className="text-xs text-ink leading-relaxed mt-2 border-l-2 border-accent pl-2">
          The current record covers only {meta.first_month.slice(0, 4)}–{meta.last_month.slice(0, 4)} ({nYears} years).
          Historical medians are based on {nYears} values per calendar month, and with fewer than 6 years |z| cannot
          exceed 2 (maximum √(n−1) = {Math.sqrt(nYears - 1).toFixed(2)}), so anomaly flags cannot trigger yet.
        </p>
      )}
      {noModisOnly && (
        <p className="text-xs text-dim leading-relaxed mt-2">
          VIIRS covers the whole record, so harmonized values equal VIIRS; the factors are fitted for reference.
        </p>
      )}
      {meta.frp && <FrpNote meta={meta} />}
      {meta.land_cover && <p className="text-xs text-dim leading-relaxed mt-2">{meta.land_cover.note} Each hotspot is labelled with the previous year's map ({meta.land_cover.map_years[0]}–{meta.land_cover.map_years[meta.land_cover.map_years.length - 1]}), because a fire changes the land cover it burns.</p>}
      <DataNotes meta={meta} />
      <p className="text-xs text-dim mt-2">Source: NASA FIRMS MCD14ML (MODIS), VNP14IMGML (VIIRS S-NPP).</p>
    </Section>
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
      <h3 id="data-notes" className="text-xs font-semibold text-ink mb-1">Data notes</h3>
      <ul className="text-xs text-dim leading-relaxed list-disc pl-4 space-y-1">
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


function FrpNote({ meta }: { meta: Meta }) {
  const f = meta.frp!
  const bad = (f.tiles ?? []).filter(t => t.unreliable)
  return (
    <section className="mt-3 border-t border-line pt-2" aria-labelledby="frp-note">
      <h3 id="frp-note" className="text-xs font-semibold text-ink mb-1">Intensity (Fire Radiative Power)</h3>
      <p className="text-xs text-dim leading-relaxed">
        FRP is the radiant power (MW) the satellite measures for each detection. &ldquo;Fire energy&rdquo; here is the sum of FRP over
        all detections: a proxy for how much burning happened, not energy in joules (each fire is seen only at overpass times).
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 my-2 text-xs">
        <dt className="text-dim">k<sub>FRP</sub> {meta.region ?? 'domain'}-wide</dt><dd className="num text-ink">{f.factor_global.toFixed(3)}</dd>
        <dt className="text-dim">R² on overlap</dt><dd className="num text-ink">{f.r2_overlap.toFixed(3)}</dd>
        <dt className="text-dim">Fit window</dt><dd className="num text-ink">{f.fit_window.join(' – ')}</dd>
      </dl>
      <p className="text-xs text-dim leading-relaxed">{f.method}</p>
      <p className="text-xs text-dim leading-relaxed mt-1">
        Limits: VIIRS sees more small fires (higher total FRP over croplands, k<sub>FRP</sub> up to ~2) but reports lower FRP than MODIS for
        large co-detected fires (k<sub>FRP</sub> below 1 in boreal and steppe tiles), so k<sub>FRP</sub> depends on the fire mix. Before {meta.viirs_start} the
        values are model estimates with roughly ±10–25% uncertainty in a given year.
        {bad.length > 0 && <> Less reliable tiles (VIIRS/MODIS ratio varies from year to year): {bad.map(t => `${t.tile}° (ratio ${t.yearly_ratio_range?.join('–')})`).join('; ')}.</>}
      </p>
    </section>
  )
}

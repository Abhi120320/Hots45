import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactECharts from 'echarts-for-react'
import { url, useApi, type BBox, type Meta, type SeriesRow, type Summary } from './api'
import { ACCENT, BELOW, CIVIDIS, MONTHS, SERIES, fmt, monthLabel, reducedMotion } from './colors'

export const PRESETS: { name: string; bbox: BBox }[] = [
  { name: 'India', bbox: [68, 6.5, 97.5, 35.5] },
  { name: 'Punjab–Haryana', bbox: [73.8, 28.4, 77.6, 32.6] },
  { name: 'Central India', bbox: [74, 18, 84, 26] },
]

const AXIS = { axisLine: { lineStyle: { color: '#262B33' } }, axisTick: { show: false }, axisLabel: { color: '#9AA3AE', fontSize: 10, fontFamily: 'IBM Plex Mono' }, splitLine: { lineStyle: { color: '#1B1F26' } } }
const TIP = { backgroundColor: '#14171C', borderColor: '#262B33', textStyle: { color: '#E6E8EB', fontSize: 11, fontFamily: 'IBM Plex Mono' }, extraCssText: 'border-radius:4px;box-shadow:none' }
const BASE = { backgroundColor: 'transparent', animation: !reducedMotion(), animationDuration: 250, textStyle: { fontFamily: 'IBM Plex Sans', color: '#9AA3AE' } }
const LEGEND = { top: 0, left: 0, itemWidth: 14, itemHeight: 2, icon: 'rect', textStyle: { color: '#9AA3AE', fontSize: 10 } }
const STAR = 'path://M50 0 61 35 98 35 68 57 79 91 50 70 21 91 32 57 2 35 39 35Z'
const pct = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${fmt(v, 0)}%`)

interface Props {
  meta: Meta
  bbox?: BBox
  setBBox: (b?: BBox) => void
  start: string
  end: string
  drawing: boolean
  setDrawing: (d: boolean) => void
  onSeries: (s?: SeriesRow[]) => void
}

export default function Panel(p: Props) {
  const series = useApi<SeriesRow[]>(url('/api/series', { bbox: p.bbox }))
  const summary = useApi<Summary>(url('/api/summary', { bbox: p.bbox, start: p.start, end: p.end }), 200)
  const rows = series.data
  const firstYear = +p.meta.first_month.slice(0, 4), lastYear = +p.meta.last_month.slice(0, 4)
  const nYears = lastYear - firstYear + 1
  const { onSeries } = p
  useEffect(() => onSeries(rows), [rows, onSeries])

  const area = p.bbox ? `${p.bbox[1]}–${p.bbox[3]}°N, ${p.bbox[0]}–${p.bbox[2]}°E` : 'Full data extent'
  const empty = summary.data && summary.data.total === 0

  return (
    <div className="flex flex-col gap-3 p-3">
      <AreaControls {...p} />

      <div className="text-[11px] text-dim -mb-1">
        <span className="text-ink font-medium">{area}</span> · <span className="num">{monthLabel(p.start)} – {monthLabel(p.end)}</span>
      </div>

      <Status l={summary} what="summary" />
      {summary.data && <Kpis s={summary.data} nYears={nYears} />}
      {empty && (
        <p className="border border-line rounded-md p-3 text-dim" role="status">
          No hotspots recorded in this area between {monthLabel(p.start)} and {monthLabel(p.end)}. Try a larger box or a longer range.
        </p>
      )}

      <Status l={series} what="monthly series" />
      {rows && <Charts rows={rows} meta={p.meta} nYears={nYears} />}

      <MethodCard meta={p.meta} nYears={nYears} />

      <Card title="Download" sub="CSV, UTC dates">
        <div className="flex flex-wrap gap-2">
          <a className="h-7 px-2.5 inline-flex items-center border border-line rounded-sm bg-raised hover:border-dim text-[12px]"
            href={url('/api/download', { bbox: p.bbox, start: p.start, end: p.end })} download>Hotspots CSV</a>
          <a className="h-7 px-2.5 inline-flex items-center border border-line rounded-sm bg-raised hover:border-dim text-[12px]"
            href={url('/api/download/series', { bbox: p.bbox })} download>Monthly series CSV</a>
        </div>
      </Card>
    </div>
  )
}

function Charts({ rows, meta, nYears }: { rows: SeriesRow[]; meta: Meta; nYears: number }) {
  const calRef = useRef<ReactECharts>(null)
  const span = `${meta.first_month.slice(0, 4)}–${meta.last_month.slice(0, 4)}`
  const cal = useCalendar(rows), line = useLine(rows), ba = useBeforeAfter(rows, meta)
  return (
    <>
      <Card title="Burning calendar" sub={`Hotspots (VIIRS-equivalent) per month · ★ |z| > 2 vs ${span} · dashed = data gap or provisional`}
        action={<button className="text-[11px] text-dim hover:text-ink underline underline-offset-2"
          aria-label="Download calendar as PNG"
          onClick={() => {
            const u = calRef.current?.getEchartsInstance().getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#14171C' })
            if (u) Object.assign(document.createElement('a'), { href: u, download: 'fireledger_calendar.png' }).click()
          }}>PNG</button>}>
        <ReactECharts ref={calRef} option={cal} style={{ height: 96 + nYears * 22 }} notMerge />
      </Card>
      <Card title="Monthly hotspots" sub={`Hotspots per month (VIIRS-equivalent) with ${span} median and mean ± 1σ by calendar month`}>
        <ReactECharts option={line} style={{ height: 210 }} notMerge />
      </Card>
      <Card title="Before vs after harmonization" sub="Hotspots per month: raw sensor counts vs the harmonized record (VIIRS-equivalent)">
        <ReactECharts option={ba} style={{ height: 210 }} notMerge />
      </Card>
    </>
  )
}

function Status({ l, what }: { l: { loading: boolean; error?: string; data?: unknown }; what: string }) {
  if (l.error) return <p role="alert" className="text-[12px] text-accent border border-accent/40 rounded-md p-2">Could not load {what}: {l.error}</p>
  if (l.loading && !l.data) return <p className="text-[12px] text-faint" role="status">Loading {what}…</p>
  return null
}

function Card({ title, sub, action, children }: { title: string; sub?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="bg-panel border border-line rounded-md p-3">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <h2 className="text-[12px] font-semibold text-ink">{title}</h2>
          {sub && <p className="text-[11px] text-faint">{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function AreaControls(p: Props) {
  const [v, setV] = useState<string[]>(['', '', '', ''])
  useEffect(() => setV(p.bbox ? p.bbox.map(String) : ['', '', '', '']), [p.bbox])
  const nums = v.map(Number)
  const valid = v.every(s => s.trim() !== '' && !Number.isNaN(+s)) && nums[0] < nums[2] && nums[1] < nums[3]
    && nums[0] >= -180 && nums[2] <= 180 && nums[1] >= -90 && nums[3] <= 90
  const chip = (on: boolean) => `h-7 px-2.5 text-[12px] border rounded-sm ${on ? 'border-accent text-ink bg-accent/15' : 'border-line bg-raised text-dim hover:text-ink hover:border-dim'}`
  return (
    <Card title="Area">
      <div className="flex flex-wrap gap-1.5 mb-2">
        {PRESETS.map(pr => (
          <button key={pr.name} className={chip(p.bbox?.join() === pr.bbox.join())} aria-pressed={p.bbox?.join() === pr.bbox.join()}
            onClick={() => p.setBBox(pr.bbox)}>{pr.name}</button>
        ))}
        <button className={chip(p.drawing)} aria-pressed={p.drawing} onClick={() => p.setDrawing(!p.drawing)}>
          {p.drawing ? 'Drawing… drag on map' : 'Draw box'}
        </button>
        <button className={chip(false)} onClick={() => p.setBBox(undefined)} disabled={!p.bbox}>Clear</button>
      </div>
      <form className="grid grid-cols-[repeat(4,1fr)_auto] gap-1.5 items-end"
        onSubmit={e => { e.preventDefault(); if (valid) p.setBBox(nums as BBox) }}>
        {['West °E', 'South °N', 'East °E', 'North °N'].map((l, i) => (
          <label key={l} className="text-[10px] text-faint">
            {l}
            <input className="num mt-0.5 w-full h-7 px-1.5 bg-bg border border-line rounded-sm text-[12px] text-ink"
              inputMode="decimal" value={v[i]} onChange={e => setV(v.map((x, j) => (j === i ? e.target.value : x)))} />
          </label>
        ))}
        <button type="submit" disabled={!valid}
          className="h-7 px-2.5 text-[12px] border border-line rounded-sm bg-raised hover:border-dim disabled:opacity-40">Apply</button>
      </form>
    </Card>
  )
}

function Kpis({ s, nYears }: { s: Summary; nYears: number }) {
  const d = s.latest_pct_vs_median
  const arrow = d == null ? '' : d > 0 ? '▲ ' : d < 0 ? '▼ ' : ''
  const cards: [string, ReactNode, ReactNode?][] = [
    ['Total hotspots', fmt(s.total), 'VIIRS-equivalent'],
    ['Peak month', s.peak_month ? monthLabel(s.peak_month) : '—', `${fmt(s.peak_month_hotspots)} hotspots`],
    ['Peak year', s.peak_year ?? '—', `${fmt(s.peak_year_hotspots)} hotspots`],
    ['Busiest calendar month', s.busiest_calendar_month ? MONTHS[s.busiest_calendar_month - 1] : '—', `mean ${fmt(s.busiest_calendar_month_mean)}`],
    [`${monthLabel(s.latest_month)} vs median`,
      <span style={{ color: d == null || d === 0 ? undefined : d > 0 ? ACCENT : BELOW }}>{arrow}{pct(d)}</span>,
      `${fmt(s.latest_hotspots)} vs ${fmt(s.latest_hist_median)} median`],
    ['Anomalous months', fmt(s.anomalous_months), nYears < 6 ? `needs ≥ 6 years (have ${nYears})` : '|z| > 2'],
  ]
  return (
    <div className="grid grid-cols-2 gap-2">
      {cards.map(([k, v, sub]) => (
        <div key={k} className="bg-panel border border-line rounded-md px-3 py-2">
          <div className="text-[11px] text-dim">{k}</div>
          <div className="num text-[18px] leading-7 text-ink">{v}</div>
          {sub && <div className="num text-[10px] text-faint">{sub}</div>}
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

/* ---------- chart options ---------- */

/** January labels only, thinned to about 8 so long records stay readable */
const yearTick = (rows: SeriesRow[]) => {
  const step = Math.max(1, Math.ceil(rows.length / 12 / 8))
  return (m: string) => (m.endsWith('-01') && +m.slice(0, 4) % step === 0 ? m.slice(0, 4) : '')
}

function useCalendar(rows: SeriesRow[]) {
  return useMemo(() => {
    const years = [...new Set(rows.map(r => r.month.slice(0, 4)))]
    const max = Math.max(1, ...rows.map(r => r.hotspots))
    const byKey = new Map(rows.map(r => [r.month, r]))
    const cell = (r: SeriesRow) => [+r.month.slice(5, 7) - 1, years.indexOf(r.month.slice(0, 4)), r.hotspots]
    return {
      ...BASE,
      grid: { left: 40, right: 8, top: 4, bottom: 52 },
      tooltip: {
        ...TIP,
        formatter: (q: any) => {
          const r = byKey.get(`${years[q.value[1]]}-${String(q.value[0] + 1).padStart(2, '0')}`)
          if (!r) return ''
          return `${monthLabel(r.month)}<br/>${fmt(r.hotspots)} hotspots<br/>${pct(r.pct_vs_median)} vs median (${fmt(r.hist_median)})`
            + `<br/>z ${r.z.toFixed(2)}${r.flag ? ` · ${r.flag}` : ''}<br/><span style="color:#9AA3AE">${r.source === 'VIIRS' ? 'VIIRS' : 'MODIS-scaled to VIIRS'}</span>`
            + (r.note ? `<br/><span style="color:#E8743B">${r.note}</span>` : '')
        },
      },
      xAxis: { type: 'category', data: MONTHS, ...AXIS, splitLine: { show: false } },
      yAxis: { type: 'category', data: years, inverse: true, ...AXIS, splitLine: { show: false } },
      visualMap: {
        min: 0, max, seriesIndex: 0, calculable: false, orient: 'horizontal', left: 40, bottom: 0, itemWidth: 10, itemHeight: 200,
        inRange: { color: CIVIDIS }, text: [fmt(max), '0'], textStyle: { color: '#9AA3AE', fontSize: 10, fontFamily: 'IBM Plex Mono' },
      },
      series: [
        {
          type: 'heatmap', data: rows.map(r => ({
            value: cell(r),
            itemStyle: r.flag ? { borderColor: r.flag === 'unusually high' ? ACCENT : BELOW, borderWidth: 2 }
              : r.note ? { borderColor: '#E6E8EB', borderWidth: 1, borderType: 'dashed' } : undefined,
          })),
          itemStyle: { borderColor: '#14171C', borderWidth: 1 }, emphasis: { itemStyle: { borderColor: '#E6E8EB', borderWidth: 1 } },
        },
        {
          type: 'scatter', symbol: STAR, symbolSize: 9, silent: true, z: 3,
          data: rows.filter(r => r.flag).map(r => ({ value: cell(r), itemStyle: { color: r.flag === 'unusually high' ? ACCENT : BELOW } })),
        },
      ],
    }
  }, [rows])
}

function useLine(rows: SeriesRow[]) {
  return useMemo(() => {
    const x = rows.map(r => r.month)
    const lo = rows.map(r => Math.max(0, r.mean - r.std))
    return {
      ...BASE,
      grid: { left: 52, right: 8, top: 30, bottom: 24 },
      legend: { ...LEGEND, data: ['Harmonized', 'Median', 'Mean ± 1σ', 'Anomaly'] },
      tooltip: { ...TIP, trigger: 'axis', valueFormatter: (v: number) => fmt(v) },
      xAxis: { type: 'category', data: x, ...AXIS, splitLine: { show: false }, axisLabel: { ...AXIS.axisLabel, formatter: yearTick(rows) , interval: 0 } },
      yAxis: { type: 'value', ...AXIS },
      series: [
        { name: 'band-lo', type: 'line', data: lo, stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, tooltip: { show: false } },
        { name: 'Mean ± 1σ', type: 'line', data: rows.map((r, i) => r.mean + r.std - lo[i]), stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(154,163,174,0.16)' }, itemStyle: { color: 'rgba(154,163,174,0.4)' } },
        { name: 'Median', type: 'line', data: rows.map(r => r.hist_median), symbol: 'none', lineStyle: { color: SERIES.median, width: 1, type: 'dashed' }, itemStyle: { color: SERIES.median } },
        { name: 'Harmonized', type: 'line', data: rows.map(r => r.hotspots), symbol: 'none', lineStyle: { color: SERIES.harmonized, width: 1.5 }, itemStyle: { color: SERIES.harmonized } },
        { name: 'Anomaly', type: 'scatter', symbol: STAR, symbolSize: 10, itemStyle: { color: SERIES.anomaly }, data: rows.map(r => (r.flag ? r.hotspots : null)) },
      ],
    }
  }, [rows])
}

function useBeforeAfter(rows: SeriesRow[], meta: Meta) {
  return useMemo(() => {
    const x = rows.map(r => r.month)
    const marks = meta.viirs_start > meta.first_month
      ? { markLine: { silent: true, symbol: 'none', label: { formatter: 'VIIRS starts', color: '#9AA3AE', fontSize: 10 }, lineStyle: { color: '#6B7480', type: 'dotted' }, data: [{ xAxis: meta.viirs_start }] } }
      : {}
    return {
      ...BASE,
      grid: { left: 52, right: 8, top: 30, bottom: 24 },
      legend: { ...LEGEND },
      tooltip: { ...TIP, trigger: 'axis', valueFormatter: (v: number) => fmt(v) },
      xAxis: { type: 'category', data: x, ...AXIS, splitLine: { show: false }, axisLabel: { ...AXIS.axisLabel, formatter: yearTick(rows), interval: 0 } },
      yAxis: { type: 'value', ...AXIS },
      series: [
        { name: 'MODIS raw', type: 'line', data: rows.map(r => r.modis), symbol: 'none', lineStyle: { color: SERIES.modis, width: 1 }, itemStyle: { color: SERIES.modis }, ...marks },
        { name: 'VIIRS raw', type: 'line', data: rows.map(r => (r.month < meta.viirs_start ? null : r.viirs)), symbol: 'none', lineStyle: { color: SERIES.viirs, width: 1 }, itemStyle: { color: SERIES.viirs } },
        { name: 'MODIS × k', type: 'line', data: rows.map(r => r.modis_scaled), symbol: 'none', lineStyle: { color: SERIES.modis, width: 1, type: 'dashed' }, itemStyle: { color: SERIES.modis } },
        { name: 'Harmonized', type: 'line', data: rows.map(r => r.hotspots), symbol: 'none', lineStyle: { color: SERIES.harmonized, width: 2 }, itemStyle: { color: SERIES.harmonized }, z: 1 },
      ],
    }
  }, [rows, meta])
}

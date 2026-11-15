import { useEffect, useMemo, useRef, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { areaParams, url, useApi, type Area, type Meta, type SeriesRow } from './api'
import AreaControls from './Area'
import Calendar from './Calendar'
import TimelineChart from './TimelineChart'
import { FireTypeFilter } from './LandCover'
import { MetricToggle, unitOf, type Metric } from './Metric'
import BeforeAfter from './BeforeAfter'
import { beforeAfterCsv, calendarCsv, downloadText, lineCsv, lineOption, svgToPng, toCsv } from './charts'
import { monthLabel } from './colors'
import type { TL, TLAction } from './timeline'
import { CHARTS, CHART_TITLES, type ChartKey } from './url'
import { Button, IconButton, Skeleton, ErrorMsg } from './ui'

interface Props {
  chart: ChartKey
  meta: Meta
  months: string[]
  tl: TL
  dispatch: (a: TLAction) => void
  lastComplete: number
  area: Area
  setArea: (a: Area) => void
  areaName: string
  go: (c: ChartKey) => void
  onBack: () => void
  onPreview: (m: string | null) => void
  fireType: string
  setFireType: (v: string) => void
  metric: Metric
  setMetric: (m: Metric) => void
}

export default function ChartView(p: Props) {
  const ap = useMemo(() => areaParams(p.area), [p.area])
  // the fire-type filter applies to the calendar and timeline only
  // ...and so does the Hotspots | Intensity (FRP) toggle; FRP is not split by land cover
  const filtered = p.chart === 'calendar' || p.chart === 'timeline'
  const met = filtered && p.metric === 'frp' ? 'frp' : undefined
  const group = filtered && !met && p.fireType !== 'all' ? p.fireType : undefined
  const gp = useMemo(() => ({ ...ap, group, metric: met }), [ap, group, met])
  const series = useApi<SeriesRow[]>(url('/api/series', gp))
  const rows = series.data
  const svg = useRef<SVGSVGElement | null>(null)
  const ec = useRef<any>(null)
  const shown = useRef<{ header: string[]; rows: unknown[][] } | null>(null)
  const [copied, setCopied] = useState(false)
  const [areaOpen, setAreaOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [bodyH, setBodyH] = useState(600)

  // Esc = back to map; Alt + ← / → = previous / next chart
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('input, [role=listbox]')) p.onBack()
      if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        const i = CHARTS.indexOf(p.chart) + (e.key === 'ArrowRight' ? 1 : -1)
        p.go(CHARTS[(i + CHARTS.length) % CHARTS.length])
      }
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [p])
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBodyH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const start = p.months[p.tl.a], end = p.months[p.tl.b]
  const period = start === end ? monthLabel(start) : `${monthLabel(start)} – ${monthLabel(end)}`
  const base = `hots45_${p.chart}_${(ap.region ?? (ap.bbox ? 'box' : 'all')).replace(/[^\w.-]/g, '_')}${group ? `_${group}` : ''}${met ? '_frp' : ''}`

  const [dlErr, setDlErr] = useState<string | null>(null)
  const downloadPng = () => {
    setDlErr(null)
    if (p.chart === 'calendar') { if (svg.current) svgToPng(svg.current, 3, `${base}.png`).catch(e => setDlErr(`PNG download failed: ${e.message}`)); return }
    const u = ec.current?.getDataURL({ type: 'png', pixelRatio: 3, backgroundColor: '#0B0D10' })
    if (u) Object.assign(document.createElement('a'), { href: u, download: `${base}.png` }).click()
    else setDlErr('PNG download failed: the chart is not ready yet.')
  }
  const downloadData = () => {
    if (!rows) return
    const csv = p.chart === 'calendar' ? calendarCsv(rows) : p.chart === 'monthly' ? lineCsv(rows)
      : p.chart === 'before-after' ? beforeAfterCsv(rows) : shown.current ? toCsv(shown.current.header, shown.current.rows) : lineCsv(rows)
    downloadText(`${base}.csv`, csv)
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(location.href); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* no clipboard */ }
  }

  const line = useMemo(() => (rows ? lineOption(rows, true) : null), [rows])
  const idx = CHARTS.indexOf(p.chart)

  return (
    <div className="fixed inset-0 z-50 bg-bg flex flex-col" role="dialog" aria-modal="true" aria-label={`${CHART_TITLES[p.chart]}, expanded`}>
      <header className="px-6 py-4 border-b border-line flex items-start gap-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-title font-semibold text-ink truncate">{CHART_TITLES[p.chart]} · {p.areaName}</h1>
          <p className="num text-base text-dim mt-1">{period}</p>
          <p className="text-xs text-dim mt-2 max-w-[110ch]">
            Hotspots are VIIRS-equivalent counts from NASA FIRMS (MODIS MCD14ML, VIIRS S-NPP VNP14IMGML), {p.meta.first_month} to {p.meta.last_month}.
            MODIS is scaled to VIIRS with factors fitted per 10° tile and calendar month ({p.meta.fit_window?.join(' to ') ?? 'overlap years'}); from {p.meta.viirs_start} values are VIIRS.
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2 shrink-0">
          {dlErr && <span role="alert" className="self-center text-sm text-ink"><span className="text-accent font-semibold">Error · </span>{dlErr}</span>}
          <Button onClick={downloadPng}>Download PNG</Button>
          <Button onClick={downloadData} disabled={!rows}>Download data</Button>
          <Button onClick={copy} aria-live="polite">{copied ? 'Link copied' : 'Copy link'}</Button>
          <Button variant="primary" onClick={p.onBack}>Back to map <span className="font-normal text-xs opacity-80">Esc</span></Button>
        </div>
      </header>

      <nav className="h-14 px-6 border-b border-line flex items-center gap-2" aria-label="Charts">
        <IconButton label="Previous chart" onClick={() => p.go(CHARTS[(idx - 1 + CHARTS.length) % CHARTS.length])}>‹</IconButton>
        <div role="tablist" className="inline-flex rounded-md border border-line bg-panel p-px">
          {CHARTS.map(c => (
            <button key={c} role="tab" aria-selected={c === p.chart} onClick={() => p.go(c)}
              className={`h-[30px] px-3 rounded-[5px] text-sm whitespace-nowrap ${c === p.chart ? 'bg-accent text-bg font-semibold' : 'text-dim hover:text-ink'}`}>{CHART_TITLES[c]}</button>
          ))}
        </div>
        <IconButton label="Next chart" onClick={() => p.go(CHARTS[(idx + 1) % CHARTS.length])}>›</IconButton>
        <span className="text-xs text-dim ml-2">Alt + ← / → to switch</span>
        <Button variant="ghost" className="ml-auto" aria-expanded={areaOpen} onClick={() => setAreaOpen(!areaOpen)}>
          {areaOpen ? 'Done' : 'Change area'}
        </Button>
      </nav>
      {areaOpen && (
        <div className="px-6 py-4 border-b border-line max-w-[560px]">
          <AreaControls meta={p.meta} area={p.area} setArea={a => { p.setArea(a); setAreaOpen(false) }} drawing={false} setDrawing={() => {}} />
        </div>
      )}

      <div ref={bodyRef} className="flex-1 min-h-0 overflow-auto px-6 py-4">
        {series.error && <ErrorMsg>Could not load data: {series.error}</ErrorMsg>}
        {!rows && !series.error && <Skeleton height={Math.max(320, bodyH - 64)} />}
        {rows && p.chart === 'calendar' && (
          <div className="mx-auto" style={{ maxWidth: Math.max(900, Math.min(1700, (bodyH - 140) * 1.55)) }}>
            <div className="mb-3 flex flex-wrap gap-2"><MetricToggle meta={p.meta} value={p.metric} onChange={p.setMetric} />
              {p.metric !== 'frp' && <FireTypeFilter meta={p.meta} value={p.fireType} onChange={p.setFireType} />}</div>
            <Calendar rows={rows} meta={p.meta} large unit={unitOf(met ?? 'hotspots')} selected={[start, end]} svgRefOut={el => { svg.current = el }}
              onPickMonth={m => p.dispatch({ type: 'month', i: p.months.indexOf(m) })} />
          </div>
        )}
        {rows && p.chart === 'monthly' && line && <ReactECharts option={line} style={{ height: Math.max(360, bodyH - 32) }} notMerge onChartReady={c => { ec.current = c }} />}
        {rows && p.chart === 'before-after' && <BeforeAfter rows={rows} meta={p.meta} large height={Math.max(420, bodyH - 60)} onReady={c => { ec.current = c }} />}
        {p.chart === 'timeline' && (
          <TimelineChart meta={p.meta} months={p.months} tl={p.tl} dispatch={p.dispatch} lastComplete={p.lastComplete} rows={rows}
            area={gp} areaKey={`${ap.region ?? ap.bbox?.join(',') ?? 'all'}|${p.fireType}`} areaName={p.areaName} onPreview={p.onPreview}
            fireType={p.fireType} setFireType={p.setFireType} metric={p.metric} setMetric={p.setMetric}
            height={Math.max(320, bodyH - 150)} large chartOut={c => { ec.current = c }} onShown={s => { shown.current = s }} />
        )}
      </div>

    </div>
  )
}

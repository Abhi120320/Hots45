import { useEffect, useMemo, useRef, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { areaParams, url, useApi, type Area, type Meta, type SeriesRow } from './api'
import AreaControls from './Area'
import Calendar from './Calendar'
import TimelineChart from './TimelineChart'
import BeforeAfter from './BeforeAfter'
import { beforeAfterCsv, calendarCsv, downloadText, lineCsv, lineOption, svgToPng, toCsv } from './charts'
import { monthLabel } from './colors'
import type { TL, TLAction } from './timeline'
import { CHARTS, CHART_TITLES, type ChartKey } from './url'

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
}

export default function ChartView(p: Props) {
  const ap = useMemo(() => areaParams(p.area), [p.area])
  const series = useApi<SeriesRow[]>(url('/api/series', ap))
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
  const base = `hots45_${p.chart}_${(ap.region ?? (ap.bbox ? 'box' : 'all')).replace(/[^\w.-]/g, '_')}`

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
  const btn = 'h-9 px-3 border border-line rounded-sm bg-raised hover:border-dim text-[14px] text-ink'
  const idx = CHARTS.indexOf(p.chart)

  return (
    <div className="fixed inset-0 z-50 bg-bg flex flex-col" role="dialog" aria-modal="true" aria-label={`${CHART_TITLES[p.chart]}, expanded`}>
      <header className="px-6 pt-4 pb-3 border-b border-line flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-semibold text-ink leading-tight">{CHART_TITLES[p.chart]} · {p.areaName}</h1>
          <p className="num text-[15px] text-dim">{period}</p>
          <p className="text-[12px] text-faint mt-1 max-w-[110ch]">
            Hotspots are VIIRS-equivalent counts from NASA FIRMS (MODIS MCD14ML, VIIRS S-NPP VNP14IMGML), {p.meta.first_month} to {p.meta.last_month}.
            MODIS is scaled to VIIRS with factors fitted per 10° tile and calendar month ({p.meta.fit_window?.join(' to ') ?? 'overlap years'}); from {p.meta.viirs_start} values are VIIRS.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {dlErr && <span role="alert" className="self-center text-[12px] text-accent">{dlErr}</span>}
          <button className={btn} onClick={downloadPng}>Download PNG</button>
          <button className={btn} onClick={downloadData} disabled={!rows}>Download data</button>
          <button className={btn} onClick={copy} aria-live="polite">{copied ? 'Link copied' : 'Copy link'}</button>
          <button className={`${btn} border-accent`} onClick={p.onBack}>Back to map <span className="text-faint text-[12px]">Esc</span></button>
        </div>
      </header>

      <nav className="px-6 py-2 border-b border-line flex items-center gap-2" aria-label="Charts">
        <button className={btn} aria-label="Previous chart" onClick={() => p.go(CHARTS[(idx - 1 + CHARTS.length) % CHARTS.length])}>‹</button>
        <div role="tablist" className="flex gap-1">
          {CHARTS.map(c => (
            <button key={c} role="tab" aria-selected={c === p.chart} onClick={() => p.go(c)}
              className={`h-9 px-3 rounded-sm text-[14px] ${c === p.chart ? 'bg-accent text-bg font-medium' : 'text-dim hover:text-ink'}`}>{CHART_TITLES[c]}</button>
          ))}
        </div>
        <button className={btn} aria-label="Next chart" onClick={() => p.go(CHARTS[(idx + 1) % CHARTS.length])}>›</button>
        <span className="text-[12px] text-faint ml-2">Alt + ← / → to switch</span>
        <button className="ml-auto text-[14px] text-dim hover:text-ink underline underline-offset-2" aria-expanded={areaOpen} onClick={() => setAreaOpen(!areaOpen)}>
          {areaOpen ? 'Done' : 'Change area'}
        </button>
      </nav>
      {areaOpen && (
        <div className="px-6 py-3 border-b border-line max-w-[560px]">
          <AreaControls meta={p.meta} area={p.area} setArea={a => { p.setArea(a); setAreaOpen(false) }} drawing={false} setDrawing={() => {}} />
        </div>
      )}

      <div ref={bodyRef} className="flex-1 min-h-0 overflow-auto px-6 py-4">
        {series.error && <p role="alert" className="text-accent">Could not load data: {series.error}</p>}
        {!rows && !series.error && <p className="text-dim" role="status">Loading…</p>}
        {rows && p.chart === 'calendar' && (
          <div className="mx-auto" style={{ maxWidth: Math.max(900, Math.min(1700, (bodyH - 140) * 1.55)) }}>
            <Calendar rows={rows} meta={p.meta} large selected={[start, end]} svgRefOut={el => { svg.current = el }}
              onPickMonth={m => p.dispatch({ type: 'month', i: p.months.indexOf(m) })} />
          </div>
        )}
        {rows && p.chart === 'monthly' && line && <ReactECharts option={line} style={{ height: Math.max(360, bodyH - 32) }} notMerge onChartReady={c => { ec.current = c }} />}
        {rows && p.chart === 'before-after' && <BeforeAfter rows={rows} meta={p.meta} large height={Math.max(420, bodyH - 60)} onReady={c => { ec.current = c }} />}
        {p.chart === 'timeline' && (
          <TimelineChart meta={p.meta} months={p.months} tl={p.tl} dispatch={p.dispatch} lastComplete={p.lastComplete} rows={rows}
            area={ap} areaKey={ap.region ?? ap.bbox?.join(',') ?? 'all'} areaName={p.areaName} onPreview={p.onPreview}
            height={Math.max(320, bodyH - 150)} large chartOut={c => { ec.current = c }} onShown={s => { shown.current = s }} />
        )}
      </div>

    </div>
  )
}

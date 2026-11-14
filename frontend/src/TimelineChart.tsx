import React, { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import ReactECharts from 'echarts-for-react'
import { url, useApi, type BBox, type Meta, type SeriesRow } from './api'
import { fmt, monthLabel } from './colors'
import { abbr } from './Calendar'
import { peakIndex, type TL, type TLAction } from './timeline'

interface DailyRow { date: string; hotspots: number; median: number; pct_vs_median: number | null; note: string }
interface Season { text: string; data_through?: string }

const DAILY_MAX_DAYS = 120 // zoomed in this far -> daily counts from points.parquet
const DAY = 86_400_000
const ms = (m: string) => Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1, 1)
const monthEnd = (m: string) => Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1) // exclusive
const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const PRESETS = [
  { kind: 'stubble', label: 'Peak stubble season (Oct–Nov)', months: ['10', '11'] },
  { kind: 'spring', label: 'Spring burning (Mar–May)', months: ['03', '05'] },
  { kind: 'last12', label: 'Last 12 months' },
  { kind: 'all', label: 'Full record' },
] as const
const HINT_KEY = 'hots45.timelineHint'
const EVENTS_KEY = 'hots45.events'

function hatch() {
  const c = document.createElement('canvas')
  c.width = c.height = 6
  const g = c.getContext('2d')!
  g.strokeStyle = 'rgba(154,163,174,0.55)'
  g.lineWidth = 1
  g.beginPath(); g.moveTo(0, 6); g.lineTo(6, 0); g.stroke()
  return c
}

interface Props {
  meta: Meta
  months: string[]
  tl: TL
  dispatch: (a: TLAction) => void
  lastComplete: number
  rows?: SeriesRow[]
  area: { region?: string; bbox?: BBox }
  areaKey: string
  areaName: string
  onPreview: (m: string | null) => void
  height?: number // expanded view: fill the screen
  large?: boolean
  expandHref?: string // side/bottom chart: link to the expanded view
  onExpand?: (e: React.MouseEvent) => void
  onShown?: (csv: { header: string[]; rows: unknown[][] }) => void // what is on screen, for "Download data"
  chartOut?: (c: any) => void // echarts instance, for "Download PNG"
}

export default memo(function TimelineChart(p: Props) {
  const { months, tl, dispatch } = p
  const n = months.length
  const chartRef = useRef<ReactECharts>(null)
  const [expanded, setExpanded] = useState(false)
  const [win, setWin] = useState<[number, number]>([ms(months[0]), monthEnd(months[n - 1])])
  const [px, setPx] = useState<{ x0: number; x1: number; top: number; h: number } | null>(null)
  const [drag, setDrag] = useState<{ kind: 'move' | 'a' | 'b'; x: number; a: number; b: number } | null>(null)
  const [hint, setHint] = useState(() => { try { return !localStorage.getItem(HINT_KEY) } catch { return true } })
  const [labels, setLabels] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem(EVENTS_KEY) ?? '{}') } catch { return {} } })
  const [editing, setEditing] = useState<{ id: string; value: string; x: number; y: number } | null>(null)
  const saveLabel = (id: string, v: string | null) => {
    const next = { ...labels }
    if (v && v.trim()) next[id] = v.trim(); else delete next[id] // empty / reset = automatic label
    setLabels(next)
    try { localStorage.setItem(EVENTS_KEY, JSON.stringify(next)) } catch { /* ignore */ }
    setEditing(null)
  }
  const dismissHint = () => { setHint(false); try { localStorage.setItem(HINT_KEY, '1') } catch { /* ignore */ } }

  const daily = win[1] - win[0] <= DAILY_MAX_DAYS * DAY
  const dStart = iso(Math.max(win[0] - 7 * DAY, ms(months[0]))), dEnd = iso(Math.min(win[1] + 7 * DAY, monthEnd(months[n - 1]) - DAY))
  const dailyApi = useApi<DailyRow[]>(daily ? url('/api/daily', { ...p.area, start: dStart, end: dEnd }) : null, 150)
  const season = useApi<Season>(url('/api/season', p.area), 300)
  const dataThrough = monthEnd(p.meta.last_month) - DAY

  // ---------- derived context ----------
  const rows = p.rows
  const events = useMemo(() => {
    const out: { id: string; a: string; b: string; kind: 'high' | 'low' }[] = []
    for (const r of rows ?? []) {
      if (!r.flag) continue
      const kind = r.flag === 'unusually high' ? 'high' : 'low'
      const prev = out[out.length - 1]
      if (prev && prev.kind === kind && ms(r.month) === monthEnd(prev.b)) prev.b = r.month
      else out.push({ id: `${p.areaKey}:${r.month}`, a: r.month, b: r.month, kind })
    }
    return out
  }, [rows, p.areaKey])
  const evLabel = (e: (typeof events)[number]) => labels[e.id]
    ?? `${e.kind === 'high' ? 'Unusually high' : 'Unusually low'}: ${e.a === e.b ? monthLabel(e.a) : `${monthLabel(e.a).slice(0, 3)}–${monthLabel(e.b)}`}`

  const option = useMemo(() => {
    const monthly = (rows ?? []).map(r => [ms(r.month) + 14 * DAY, r.hotspots])
    const median = (rows ?? []).map(r => [ms(r.month) + 14 * DAY, r.hist_median])
    const dly = dailyApi.data ?? []
    const vals = daily ? dly.map(d => [Date.parse(`${d.date}T12:00:00Z`), d.hotspots]) : monthly
    const med = daily ? dly.map(d => [Date.parse(`${d.date}T12:00:00Z`), d.median]) : median
    // peaks in the visible window
    const visible = vals.filter(v => v[0] >= win[0] && v[0] <= win[1]).sort((a, b) => b[1] - a[1])
    const peaks = visible.slice(0, daily ? 3 : 3).filter(v => v[1] > 0)
    const maxMed = Math.max(1, ...(rows ?? []).map(r => r.hist_median))
    void maxMed
    const shade = (rows ?? []).filter(r => r.flag) // only significant anomalies (|z| > 2)
      .map(r => [{ xAxis: ms(r.month), itemStyle: { color: r.flag === 'unusually high' ? 'rgba(178,24,43,0.22)' : 'rgba(33,102,172,0.24)' } }, { xAxis: monthEnd(r.month) }])
    const gaps = (p.meta.data_gaps ?? []).map(g => [{ xAxis: Date.parse(`${g.start}T00:00:00Z`) }, { xAxis: Date.parse(`${g.end}T00:00:00Z`) + DAY }])
    const prov = p.meta.provisional_months ?? []
    // event labels: all of them when zoomed to <= 6 years, otherwise the 3 strongest (sum of hotspots above median)
    const spanYears = (win[1] - win[0]) / (365 * DAY)
    const strength = (e: (typeof events)[number]) => (rows ?? []).filter(r => r.month >= e.a && r.month <= e.b).reduce((s, r) => s + Math.abs(r.hotspots - r.hist_median), 0)
    // Label budget: 1 peak + strongest events, max 3, spaced >= 1/6 of the window apart and clear of the y-axis
    const span = win[1] - win[0], minGap = span / 6, edge = win[0] + span * 0.04
    const topPeak = peaks[0]
    const placed: number[] = topPeak ? [topPeak[0]] : []
    const labelled = new Set<string>()
    void spanYears
    for (const e of [...events].sort((x, y) => strength(y) - strength(x))) {
      const x = ms(e.a)
      if (placed.length >= 3 || x < edge || x > win[1] || placed.some(px => Math.abs(px - x) < minGap)) continue
      placed.push(x); labelled.add(e.id)
    }
    const a = months[tl.a], b = months[tl.b]
    return {
      animation: false,
      grid: { left: p.large ? 72 : 52, right: 16, top: 26, bottom: 46 },
      textStyle: { fontFamily: 'IBM Plex Sans', color: '#9AA3AE' },
      tooltip: {
        trigger: 'axis', backgroundColor: '#14171C', borderColor: '#262B33', textStyle: { color: '#E6E8EB', fontSize: p.large ? 14 : 11, fontFamily: 'IBM Plex Mono' },
        extraCssText: 'border-radius:4px;box-shadow:none', axisPointer: { type: 'line', lineStyle: { color: '#E6E8EB', width: 1, type: 'dashed' } },
        formatter: (ps: any[]) => {
          const t = ps[0]?.value?.[0]
          if (t == null) return ''
          if (daily) {
            const d = dly.find(x => x.date === iso(t))
            if (!d) return ''
            return `${dayLabel(d.date)}<br/>${fmt(d.hotspots)} hotspots<br/>normal ${fmt(d.median)}${d.pct_vs_median == null ? '' : ` · ${d.pct_vs_median > 0 ? '+' : ''}${Math.round(d.pct_vs_median)}%`}${d.note ? `<br/><span style="color:#E8743B">${d.note}</span>` : ''}`
          }
          const m = new Date(t).toISOString().slice(0, 7)
          const r = rows?.find(x => x.month === m)
          if (!r) return ''
          return `${monthLabel(m)}<br/>${fmt(r.hotspots)} hotspots<br/>median ${fmt(r.hist_median)}${r.pct_vs_median == null ? '' : ` · ${r.pct_vs_median > 0 ? '+' : ''}${Math.round(r.pct_vs_median)}%`}${r.note ? `<br/><span style="color:#E8743B">${r.note}</span>` : ''}<br/><span style="color:#8A939E">click to show this month</span>`
        },
      },
      xAxis: {
        type: 'time', min: win[0], max: win[1], axisLine: { lineStyle: { color: '#262B33' } }, splitLine: { show: false },
        axisLabel: { color: '#9AA3AE', fontSize: p.large ? 14 : 10, fontFamily: 'IBM Plex Mono', hideOverlap: true },
        minorTick: { show: true, splitNumber: 4, lineStyle: { color: '#262B33' } },
      },
      yAxis: {
        type: 'value', splitNumber: p.large ? 6 : 3, axisLabel: { color: '#8A939E', fontSize: p.large ? 13 : 10, fontFamily: 'IBM Plex Mono', formatter: (v: number) => (p.large ? fmt(v) : abbr(v)) },
        splitLine: { lineStyle: { color: '#1B1F26' } },
        name: daily ? 'hotspots / day' : 'hotspots / month', nameTextStyle: { color: '#8A939E', fontSize: 10, align: 'left' },
      },
      dataZoom: [
        { type: 'inside', filterMode: 'none', minValueSpan: 14 * DAY, startValue: win[0], endValue: win[1] },
        { type: 'slider', filterMode: 'none', height: 16, bottom: 6, startValue: win[0], endValue: win[1], borderColor: '#262B33',
          fillerColor: 'rgba(232,116,59,0.15)', handleStyle: { color: '#E8743B' }, textStyle: { color: '#8A939E', fontSize: 9 },
          dataBackground: { lineStyle: { color: '#6B7480' }, areaStyle: { color: 'rgba(107,116,128,0.3)' } },
          labelFormatter: (v: number) => new Date(v).toISOString().slice(0, daily ? 10 : 7) },
      ],
      series: [
        {
          name: 'Hotspots', type: (win[1] - win[0]) / (365 * DAY) > 3 ? 'line' : 'bar', data: vals, barMaxWidth: daily ? 10 : 6, barCategoryGap: '10%',
          itemStyle: { color: '#D9DCE1' }, symbol: 'none', lineStyle: { color: '#D9DCE1', width: 1 }, areaStyle: { color: 'rgba(217,220,225,0.18)' },
          emphasis: { itemStyle: { color: '#E8743B' } }, large: !daily,
          markArea: { silent: true, data: shade },
          markPoint: {
            symbol: 'pin', symbolSize: 0,
            label: { show: true, color: '#E6E8EB', fontSize: 10, fontFamily: 'IBM Plex Mono', position: 'insideTop', distance: 4, backgroundColor: 'rgba(20,23,28,0.85)', padding: [1, 4], borderRadius: 2 },
            data: peaks.slice(0, 1).map((v, i) => ({ coord: v, value: v[1], label: { offset: [0, -13 * i], formatter: `${i === 0 ? 'Peak: ' : ''}${daily ? dayLabel(iso(v[0])) : monthLabel(new Date(v[0]).toISOString().slice(0, 7))} · ${fmt(v[1])}` } })),
          },
        },
        { name: 'Normal (median)', type: 'line', data: med, symbol: 'none', lineStyle: { color: '#9AA3AE', width: 1, type: 'dashed' }, z: 3 },
        {
          // context-only series: gaps, provisional, events, selection, data-through marker
          name: 'context', type: 'line', data: [], silent: false,
          markArea: {
            data: [
              ...gaps.map(g => [{ ...g[0], itemStyle: { color: { image: hatch(), repeat: 'repeat' } } }, g[1]]),
              ...(prov.length ? [[{ xAxis: ms(prov[0]), name: 'provisional (NRT)', itemStyle: { color: 'rgba(154,163,174,0.10)' }, label: { show: false } }, { xAxis: monthEnd(prov[prov.length - 1]) }]] : []),
              ...events.map(e => [{
                xAxis: ms(e.a), name: `event:${e.id}`, itemStyle: { color: 'rgba(0,0,0,0)', borderColor: e.kind === 'high' ? 'rgba(232,116,59,0.7)' : 'rgba(86,180,233,0.7)', borderWidth: 1, borderType: 'dotted' },
                label: { show: labelled.has(e.id), position: 'insideTopLeft', fontFamily: 'IBM Plex Sans', formatter: evLabel(e), color: e.kind === 'high' ? '#E8743B' : '#56B4E9', fontSize: 9, overflow: 'truncate', width: 140 },
              }, { xAxis: monthEnd(e.b) }]),
              [{ xAxis: ms(a), itemStyle: { color: 'rgba(232,116,59,0.22)' } }, { xAxis: monthEnd(b) }],
            ],
          },
          markLine: {
            silent: true, symbol: 'none', lineStyle: { color: '#8A939E', type: 'solid', width: 1 },
            label: { show: false },
            data: [{ xAxis: dataThrough }],
          },
        },
      ],
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, dailyApi.data, daily, win, events, labels, tl.a, tl.b, p.meta, months, p.large])

  // ---------- selection overlay (drag band / handles) ----------
  const place = useCallback(() => {
    const c = chartRef.current?.getEchartsInstance()
    if (!c) return
    const x0 = c.convertToPixel({ xAxisIndex: 0 }, ms(months[tl.a])) as number
    const x1 = c.convertToPixel({ xAxisIndex: 0 }, monthEnd(months[tl.b])) as number
    const h = c.getHeight()
    setPx({ x0, x1, top: 26, h: h - 26 - 46 })
  }, [months, tl.a, tl.b])
  useEffect(() => { const id = requestAnimationFrame(place); return () => cancelAnimationFrame(id) }, [place, option, expanded])

  const monthAt = (x: number) => {
    const c = chartRef.current?.getEchartsInstance()
    const t = c?.convertFromPixel({ xAxisIndex: 0 }, x) as number | undefined
    if (t == null || Number.isNaN(t)) return null
    const m = new Date(t).toISOString().slice(0, 7)
    const i = months.indexOf(m)
    return i >= 0 ? i : t < ms(months[0]) ? 0 : n - 1
  }
  const onDown = (kind: 'move' | 'a' | 'b') => (e: PointerEvent) => {
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setDrag({ kind, x: e.clientX, a: tl.a, b: tl.b })
    dismissHint()
  }
  const onMove = (e: PointerEvent) => {
    if (!drag) return
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const i = monthAt(e.clientX - box.left)
    const i0 = monthAt(drag.x - box.left)
    if (i == null || i0 == null) return
    if (tl.mode === 'month' || drag.kind === 'move') {
      const d = i - i0
      if (tl.mode === 'month') dispatch({ type: 'month', i: Math.max(0, Math.min(n - 1, drag.a + d)) })
      else dispatch({ type: 'range', a: Math.max(0, Math.min(n - 1 - (drag.b - drag.a), drag.a + d)), b: Math.max(drag.b - drag.a, Math.min(n - 1, drag.b + d)) })
    } else if (drag.kind === 'a') dispatch({ type: 'range', a: Math.min(i, drag.b), b: drag.b })
    else dispatch({ type: 'range', a: drag.a, b: Math.max(i, drag.a) })
  }
  const keyOn = (which: 'move' | 'a' | 'b') => (e: KeyboardEvent) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const step = e.shiftKey ? 12 * d : d
    if (which === 'move' || tl.mode === 'month') dispatch({ type: 'step', d: step })
    else if (which === 'a') dispatch({ type: 'range', a: Math.min(tl.b, tl.a + step), b: tl.b })
    else dispatch({ type: 'range', a: tl.a, b: Math.max(tl.a, tl.b + step) })
  }

  // ---------- chart events: zoom, hover preview, click to jump, rename events ----------
  const previewT = useRef<number>(0)
  const onEvents = useMemo(() => ({
    datazoom: () => {
      const c = chartRef.current?.getEchartsInstance()
      const dz = (c?.getOption() as any)?.dataZoom?.[0]
      if (dz?.startValue != null) setWin([dz.startValue, dz.endValue])
    },
    updateAxisPointer: (e: any) => {
      const t = e.axesInfo?.[0]?.value
      clearTimeout(previewT.current)
      if (t == null || drag) return
      previewT.current = window.setTimeout(() => {
        const m = new Date(t).toISOString().slice(0, 7)
        if (months.includes(m)) p.onPreview(m)
      }, 250)
    },
    globalout: () => { clearTimeout(previewT.current); p.onPreview(null) },
    click: (e: any) => {
      if (e.componentType === 'markArea' && typeof e.name === 'string' && e.name.startsWith('event:')) {
        const id = e.name.slice(6)
        setEditing({ id, value: labels[id] ?? '', x: e.event?.offsetX ?? 80, y: e.event?.offsetY ?? 30 })
      }
    },
  }), [months, p, labels, drag])
  useEffect(() => {
    const c = chartRef.current?.getEchartsInstance()
    if (!c) return
    const zr = c.getZr()
    const onClick = (e: any) => {
      if (e.target) return // bars/marks handle their own clicks
      const i = monthAt(e.offsetX)
      if (i != null && e.offsetY > 26 && e.offsetY < c.getHeight() - 46) { dispatch({ type: 'month', i }); p.onPreview(null) }
    }
    zr.on('click', onClick)
    return () => { zr.off('click', onClick) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [months, dispatch])
  // bars also jump on click
  useEffect(() => {
    const c = chartRef.current?.getEchartsInstance()
    if (!c) return
    const h = (e: any) => { if (e.seriesName === 'Hotspots') { const i = months.indexOf(new Date(e.value[0]).toISOString().slice(0, 7)); if (i >= 0) dispatch({ type: 'month', i }) } }
    c.on('click', h)
    return () => { c.off('click', h) }
  }, [months, dispatch])

  // ---------- presets / year ----------
  const lc = months[p.lastComplete]
  const seasonYears = useMemo(() => [...new Set(months.map(m => +m.slice(0, 4)))].filter(y => months.includes(`${y}-03`) && `${y}-11` <= lc).reverse(), [months, lc])
  const [year, setYear] = useState(seasonYears[0])
  // follow the selection's year, so a preset chosen elsewhere (map, expanded view, URL) stays highlighted
  const selYear = +months[tl.b].slice(0, 4)
  useEffect(() => { if (seasonYears.includes(selYear)) setYear(selYear) }, [selYear, seasonYears])
  const values = useMemo(() => rows?.map(r => r.hotspots), [rows])
  const presetRange = (k: (typeof PRESETS)[number]['kind'], y: number): [number, number] =>
    k === 'all' ? [0, n - 1] : k === 'last12' ? [Math.max(0, p.lastComplete - 11), p.lastComplete]
      : k === 'stubble' ? [months.indexOf(`${y}-10`), months.indexOf(`${y}-11`)] : [months.indexOf(`${y}-03`), months.indexOf(`${y}-05`)]
  const applyPreset = (k: (typeof PRESETS)[number]['kind'], y = year) => {
    const [a, b] = presetRange(k, y)
    if (a < 0 || b < 0) return
    if (tl.mode === 'month') dispatch({ type: 'month', i: peakIndex(values, a, b) }) // Month mode: the window's peak month
    else dispatch({ type: 'range', a, b })
    setWin(w => (ms(months[a]) >= w[0] && monthEnd(months[b]) <= w[1] ? w : [ms(months[0]), monthEnd(months[n - 1])]))
  }
  const matchedPreset = tl.mode === 'range' ? PRESETS.find(pr => { const [a, b] = presetRange(pr.kind, year); return a === tl.a && b === tl.b })?.kind : undefined
  // "Custom" is on when the user picks it, or when the selection matches no preset (e.g. after dragging the band).
  // The year dropdown only works in Custom (and in Month mode, where it jumps to that year's peak month).
  const [customPicked, setCustomPicked] = useState(false)
  const custom = tl.mode === 'range' && (customPicked || !matchedPreset)
  const activePreset = custom ? undefined : matchedPreset
  const yearEnabled = custom || tl.mode === 'month' 
  const onYear = (y: number) => {
    setYear(y)
    if (tl.mode === 'month') { // jump to that year's peak month for the selected area
      const a = months.indexOf(`${y}-01`), b = Math.min(months.indexOf(`${y}-12`) >= 0 ? months.indexOf(`${y}-12`) : n - 1, p.lastComplete)
      if (a >= 0) dispatch({ type: 'month', i: peakIndex(values, a, b) })
      return
    }
    // Range mode: a period longer than a year (e.g. Full record) becomes that whole year;
    // otherwise move the period to the same months of the new year (same length)
    const len = tl.b - tl.a
    if (len >= 12) {
      const a0 = months.indexOf(`${y}-01`), b0 = Math.min(months.indexOf(`${y}-12`) >= 0 ? months.indexOf(`${y}-12`) : n - 1, p.lastComplete)
      if (a0 >= 0) dispatch({ type: 'range', a: a0, b: b0 })
      return
    }
    const a = Math.max(0, Math.min(n - 1 - len, tl.a + (y - selYear) * 12))
    dispatch({ type: 'range', a, b: a + len })
  }

  // ---------- Play ----------
  useEffect(() => {
    if (!tl.playing) return
    const t = setInterval(() => dispatch({ type: 'tick' }), 800 / tl.speed)
    return () => clearInterval(t)
  }, [tl.playing, tl.speed, dispatch])

  const label = tl.mode === 'month' ? monthLabel(months[tl.a]) : `${monthLabel(months[tl.a])} – ${monthLabel(months[tl.b])}`
  const btn = 'h-7 px-2.5 border border-line rounded-sm bg-raised hover:border-dim text-[12px]'
  const chartH = p.height ?? (expanded ? 240 : 120)
  useEffect(() => { p.chartOut?.(chartRef.current?.getEchartsInstance()) })
  // report exactly what is visible (daily rows when zoomed in, monthly otherwise)
  const { onShown } = p
  useEffect(() => {
    if (!onShown) return
    if (daily && dailyApi.data) {
      onShown({ header: ['date', 'hotspots', 'normal_median', 'pct_vs_normal', 'note'],
        rows: dailyApi.data.filter(d => Date.parse(d.date) >= win[0] && Date.parse(d.date) < win[1]).map(d => [d.date, d.hotspots, d.median, d.pct_vs_median, d.note]) })
    } else if (rows) {
      onShown({ header: ['month', 'hotspots', 'median', 'pct_vs_median', 'flag', 'note'],
        rows: rows.filter(r => monthEnd(r.month) > win[0] && ms(r.month) < win[1]).map(r => [r.month, r.hotspots, r.hist_median, r.pct_vs_median, r.flag, r.note]) })
    }
  }, [onShown, daily, dailyApi.data, rows, win])

  return (
    <section className="border-t border-line bg-panel px-4 pt-2 pb-1" aria-label="Timeline">
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <p className="text-[12px] text-ink" aria-live="polite">
          <span className="text-faint">Data through {dayLabel(iso(dataThrough))} · Fire season · {p.areaName}: </span>
          {season.data?.text ?? (season.loading ? 'computing…' : season.error ? 'unavailable' : '')}
        </p>
        <div className="flex gap-3 shrink-0">
        {p.expandHref && (
          <a href={p.expandHref} onClick={p.onExpand} className="text-[11px] text-dim hover:text-ink underline underline-offset-2"
            aria-label="Expand the timeline to full screen">Expand ⤢</a>
        )}
        <button className="text-[11px] text-dim hover:text-ink underline underline-offset-2"
          onClick={() => setWin([ms(months[tl.a]) - 7 * DAY, monthEnd(months[tl.b]) + 7 * DAY])}>Zoom to selection</button>
        {(win[0] > ms(months[0]) || win[1] < monthEnd(months[n - 1])) && (
          <button className="text-[11px] text-dim hover:text-ink underline underline-offset-2"
            onClick={() => setWin([ms(months[0]), monthEnd(months[n - 1])])}>Full record</button>
        )}
        <button className="text-[11px] text-dim hover:text-ink underline underline-offset-2" aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}>{expanded ? 'Smaller chart' : 'Larger chart'}</button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mb-1 text-[12px]">
        <button className={`${btn} w-16`} aria-pressed={tl.playing} onClick={() => { dismissHint(); dispatch({ type: tl.playing ? 'pause' : 'play' }) }}>
          {tl.playing ? 'Pause' : 'Play'}
        </button>
        <label className="sr-only" htmlFor="speed">Playback speed</label>
        <select id="speed" className={`${btn} num`} value={tl.speed} onChange={e => dispatch({ type: 'speed', speed: +e.target.value })}>
          {[0.5, 1, 2, 4].map(s => <option key={s} value={s}>{s}×</option>)}
        </select>
        <div className="flex border border-line rounded-sm overflow-hidden" role="group" aria-label="Timeline mode">
          {(['month', 'range'] as const).map(m => (
            <button key={m} aria-pressed={tl.mode === m} onClick={() => dispatch({ type: 'mode', mode: m })}
              className={`h-7 px-2.5 text-[12px] ${tl.mode === m ? 'bg-accent text-bg font-medium' : 'bg-raised text-dim hover:text-ink'}`}>
              {m === 'month' ? 'Month' : 'Range'}
            </button>
          ))}
        </div>
        <span id="tl-label" className="num text-[15px] font-medium text-ink mx-2 min-w-[190px]" aria-live="polite">{label}</span>
        {PRESETS.map(pr => (
          <button key={pr.kind} aria-pressed={activePreset === pr.kind} onClick={() => { setCustomPicked(false); applyPreset(pr.kind) }}
            className={`h-7 px-2.5 border rounded-sm text-[12px] ${activePreset === pr.kind ? 'border-accent bg-accent/15 text-ink' : 'border-line bg-raised text-dim hover:text-ink hover:border-dim'}`}>
            {pr.label}
          </button>
        ))}
        {tl.mode === 'range' && (
          <button aria-pressed={custom} onClick={() => setCustomPicked(true)}
            className={`h-7 px-2.5 border rounded-sm text-[12px] ${custom ? 'border-accent bg-accent/15 text-ink' : 'border-line bg-raised text-dim hover:text-ink hover:border-dim'}`}>
            Custom
          </button>
        )}
        <label className="sr-only" htmlFor="season-year">Year (choose Custom to change)</label>
        <select id="season-year" className={`${btn} num disabled:opacity-40 disabled:cursor-not-allowed`} value={year} disabled={!yearEnabled}
          title={yearEnabled ? 'Move the selected period to another year' : 'Choose Custom to change the year'}
          onChange={e => onYear(+e.target.value)}>
          {seasonYears.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        {hint && (
          <span className="text-[11px] text-faint ml-1">
            Drag the band to move · drag edges to resize · scroll to zoom · Play to animate
            <button className="ml-1 text-dim hover:text-ink" aria-label="Dismiss hint" onClick={dismissHint}>✕</button>
          </span>
        )}
      </div>

      <div className="relative" onPointerMove={onMove} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}>
        <ReactECharts ref={chartRef} option={option} style={{ height: chartH }} notMerge onEvents={onEvents} />
        {editing && (
          <div className="absolute z-20 flex items-center gap-1 bg-panel border border-accent rounded-sm p-1" style={{ left: Math.max(4, editing.x - 80), top: Math.max(4, editing.y - 14) }}>
            <label className="sr-only" htmlFor="event-label">Event label</label>
            <input id="event-label" autoFocus value={editing.value} placeholder="Automatic label"
              onChange={e => setEditing({ ...editing, value: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') saveLabel(editing.id, editing.value); if (e.key === 'Escape') { e.stopPropagation(); setEditing(null) } }}
              className="h-6 w-56 px-1.5 bg-bg border border-line rounded-sm text-[12px] text-ink" />
            <button className="h-6 px-1.5 text-[11px] text-dim hover:text-ink" onClick={() => saveLabel(editing.id, null)}>Reset</button>
            <button className="h-6 px-1.5 text-[11px] text-dim hover:text-ink" aria-label="Cancel" onClick={() => setEditing(null)}>✕</button>
          </div>
        )}
        {px && px.x1 > 0 && (
          <div className="absolute pointer-events-none" style={{ left: 0, right: 0, top: px.top, height: px.h }}>
            <div role="slider" tabIndex={0} aria-label={tl.mode === 'month' ? 'Selected month' : 'Selected range'}
              aria-valuetext={label} aria-valuemin={0} aria-valuemax={n - 1} aria-valuenow={tl.a}
              onPointerDown={onDown('move')} onKeyDown={keyOn('move')}
              className="absolute top-0 bottom-0 pointer-events-auto cursor-grab active:cursor-grabbing border-x-2 border-accent focus:outline-accent"
              style={{ left: Math.max(0, px.x0), width: Math.max(3, px.x1 - px.x0) }}>
              {tl.mode === 'range' && (['a', 'b'] as const).map(h => (
                <div key={h} role="slider" tabIndex={0} aria-label={h === 'a' ? 'Range start' : 'Range end'}
                  aria-valuetext={monthLabel(months[h === 'a' ? tl.a : tl.b])} aria-valuemin={0} aria-valuemax={n - 1} aria-valuenow={h === 'a' ? tl.a : tl.b}
                  onPointerDown={onDown(h)} onKeyDown={keyOn(h)}
                  className="absolute top-1/2 -translate-y-1/2 w-6 h-7 grid place-items-center cursor-ew-resize pointer-events-auto"
                  style={h === 'a' ? { left: -13 } : { right: -13 }}>
                  <span className="block w-2.5 h-7 rounded-sm bg-accent" aria-hidden />
                </div>
              ))}
              {drag && (
                <div className="absolute -top-6 left-1/2 -translate-x-1/2 num text-[11px] text-ink bg-panel border border-line rounded-sm px-1.5 whitespace-nowrap">
                  {label}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <p className="text-[10px] text-faint pb-0.5">
        Monthly hotspots, {p.areaName} (VIIRS-equivalent){daily ? ' · daily counts at this zoom' : ''} · dashed = normal (median) ·
        red/blue = significant anomaly (|z| &gt; 2) · hatched = data gap · grey = provisional · dotted = significant anomaly (click to rename)
      </p>
    </section>
  )
})

// ECharts options shared by the side panel (compact) and the expanded chart view (large).
import type { Meta, SeriesRow } from './api'
import { FS, SERIES, T, abbr, fmt, reducedMotion } from './colors'

const STAR = 'path://M50 0 61 35 98 35 68 57 79 91 50 70 21 91 32 57 2 35 39 35Z'

function theme(large: boolean) {
  const fs = FS(large)
  return {
    fs,
    AXIS: { axisLine: { lineStyle: { color: T.line } }, axisTick: { show: false }, axisLabel: { color: T.dim, fontSize: fs, fontFamily: T.mono, hideOverlap: true }, splitLine: { lineStyle: { color: T.line } } },
    TIP: { backgroundColor: T.panel, borderColor: T.line, textStyle: { color: T.ink, fontSize: fs, fontFamily: T.mono }, padding: [8, 12], extraCssText: 'border-radius:6px;box-shadow:none' },
    BASE: { backgroundColor: 'transparent', animation: !reducedMotion(), animationDuration: 250, textStyle: { fontFamily: T.sans, color: T.dim } },
    LEGEND: { top: 0, left: 0, itemWidth: large ? 22 : 14, itemHeight: large ? 3 : 2, icon: 'rect', textStyle: { color: T.dim, fontSize: fs } },
    grid: large ? { left: 80, right: 32, top: 48, bottom: 80 } : { left: 52, right: 8, top: 30, bottom: 24 },
    // large: zoom/pan with the wheel and an overview slider; crosshair tooltips
    zoom: large ? [{ type: 'inside' }, { type: 'slider', height: 22, bottom: 16, borderColor: T.line, fillerColor: 'rgba(232,116,59,0.15)', handleStyle: { color: T.accent }, textStyle: { color: T.dim, fontSize: fs } }] : undefined,
    pointer: large ? { type: 'cross', label: { backgroundColor: T.line, fontFamily: T.mono } } : undefined,
  }
}

/** January labels only; compact charts thin them to ~8 so long records stay readable */
const yearTick = (rows: SeriesRow[], large: boolean) => {
  const step = Math.max(1, Math.ceil(rows.length / 12 / (large ? 24 : 8)))
  return (m: string) => (m.endsWith('-01') && +m.slice(0, 4) % step === 0 ? m.slice(0, 4) : '')
}

export function lineOption(rows: SeriesRow[], large = false) {
  const t = theme(large)
  const x = rows.map(r => r.month)
  const lo = rows.map(r => Math.max(0, r.mean - r.std))
  return {
    ...t.BASE,
    grid: t.grid,
    legend: { ...t.LEGEND, data: ['Harmonized', 'Median', 'Mean ± 1σ', 'Anomaly'] },
    tooltip: { ...t.TIP, trigger: 'axis', axisPointer: t.pointer, valueFormatter: (v: number) => fmt(v) },
    dataZoom: t.zoom,
    xAxis: { type: 'category', data: x, ...t.AXIS, splitLine: { show: false }, axisLabel: { ...t.AXIS.axisLabel, formatter: yearTick(rows, large), interval: 0 } },
    yAxis: { type: 'value', ...t.AXIS, axisLabel: { ...t.AXIS.axisLabel, formatter: abbr }, name: large ? 'Hotspots per month (VIIRS-equivalent)' : undefined, nameTextStyle: { fontSize: t.fs, color: T.dim, align: 'left' } },
    series: [
      { name: 'band-lo', type: 'line', data: lo, stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, tooltip: { show: false } },
      { name: 'Mean ± 1σ', type: 'line', data: rows.map((r, i) => r.mean + r.std - lo[i]), stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(154,163,174,0.16)' }, itemStyle: { color: 'rgba(154,163,174,0.4)' } },
      { name: 'Median', type: 'line', data: rows.map(r => r.hist_median), symbol: 'none', lineStyle: { color: SERIES.median, width: large ? 1.5 : 1, type: 'dashed' }, itemStyle: { color: SERIES.median } },
      { name: 'Harmonized', type: 'line', data: rows.map(r => r.hotspots), symbol: 'none', lineStyle: { color: SERIES.harmonized, width: large ? 2 : 1.5 }, itemStyle: { color: SERIES.harmonized } },
      {
        name: 'Anomaly', type: 'scatter', symbol: STAR, symbolSize: large ? 14 : 10, itemStyle: { color: SERIES.anomaly },
        data: rows.map(r => (r.flag ? r.hotspots : null)),
        label: large ? { show: true, position: 'top', color: T.accent, fontSize: t.fs, formatter: (p: any) => (p.value == null ? '' : rows[p.dataIndex].month) } : undefined,
      },
    ],
  }
}

export function beforeAfterOption(rows: SeriesRow[], meta: Meta, large = false, yearly = true, height = 440) {
  const t = theme(large)
  const fs = t.fs
  const vs = meta.viirs_start
  // yearly totals (cleaner) or the raw monthly series
  type P = { x: string; modis: number; viirs: number | null; k: number; h: number }
  const pts: P[] = []
  if (yearly) {
    const by = new Map<string, P>()
    for (const r of rows) {
      const y = r.month.slice(0, 4)
      const q = by.get(y) ?? { x: y, modis: 0, viirs: null, k: 0, h: 0 }
      q.modis += r.modis; q.k += r.modis_scaled; q.h += r.hotspots
      if (r.month >= vs) q.viirs = (q.viirs ?? 0) + r.viirs
      by.set(y, q)
    }
    pts.push(...by.values())
  } else for (const r of rows) pts.push({ x: r.month, modis: r.modis, viirs: r.month >= vs ? r.viirs : null, k: r.modis_scaled, h: r.hotspots })
  const xs = pts.map(q => q.x)
  const switchAt = yearly ? vs.slice(0, 4) : vs
  // validation: monthly MODIS x k vs VIIRS inside the fit window
  const [f0, f1] = meta.fit_window ?? [vs, meta.last_month]
  const val = rows.filter(r => r.month >= f0 && r.month <= f1 && r.viirs > 0 && r.modis_scaled > 0).map(r => [r.modis_scaled, r.viirs])
  const mean = val.reduce((s2, v) => s2 + v[1], 0) / Math.max(1, val.length)
  const ssr = val.reduce((s2, v) => s2 + (v[1] - v[0]) ** 2, 0), sst = val.reduce((s2, v) => s2 + (v[1] - mean) ** 2, 0)
  const r2 = sst > 0 ? 1 - ssr / sst : NaN
  const vmax = Math.max(1, ...val.flat())
  const L = large ? 90 : 46, R = large ? 32 : 10
  const top = large ? 56 : 34 // room for the legend so it never overlaps
  // pixel layout (titles need numeric positions): Before / After share an x-axis, Validation below with room for its axes
  const usable = height - top - (large ? 70 : 44), gap = large ? 46 : 36
  const h0 = Math.round(usable * 0.3), h1 = Math.round(usable * 0.27), h2 = usable - h0 - h1 - 2 * gap - (large ? 30 : 22)
  const g = [{ top, height: h0 }, { top: top + h0 + gap - 14, height: h1 }, { top: top + h0 + h1 + 2 * gap + (large ? 16 : 10), height: h2 }]
  const grid = g.map((x, i) => ({ ...x, left: i === 2 ? (large ? '30%' : L + 40) : L, right: i === 2 ? (large ? '30%' : R + 70) : R }))
  const title = (txt: string, i: number) => ({ text: txt, left: L, top: g[i].top - (large ? 22 : 16), textStyle: { fontSize: fs, color: T.dim, fontWeight: 600 } })
  const xAxis = (i: number) => ({ type: 'category', gridIndex: i, data: xs, ...t.AXIS, splitLine: { show: false },
    axisLabel: { ...t.AXIS.axisLabel, show: i === 1, interval: yearly ? (large ? 1 : 3) : 'auto', formatter: (v: string) => (yearly ? v : v.endsWith('-01') ? v.slice(0, 4) : '') } })
  const yAxis = (i: number) => ({ type: 'value', gridIndex: i, ...t.AXIS, splitNumber: 2, axisLabel: { ...t.AXIS.axisLabel, formatter: abbr } })
  const marker = (label: boolean) => ({ silent: true, symbol: 'none', lineStyle: { color: T.ink, type: 'dotted', width: 1 },
    label: { show: label, formatter: '← MODIS (converted)  |  VIIRS →', color: T.dim, fontSize: fs, position: 'insideStartTop', distance: 4 }, data: [{ xAxis: switchAt }] })
  return {
    ...t.BASE,
    title: [title('Before: raw sensor counts (note the jump when VIIRS starts)', 0), title('After: harmonized, VIIRS-equivalent', 1),
      title(`Validation ${f0.slice(0, 4)}–${f1.slice(0, 4)}: monthly MODIS × k vs VIIRS · R² ${Number.isNaN(r2) ? '—' : r2.toFixed(3)}`, 2)],
    legend: { ...t.LEGEND, top: 0, data: ['MODIS raw', 'VIIRS raw', 'MODIS × k', 'Harmonized'] },
    tooltip: { ...t.TIP, trigger: 'axis', axisPointer: t.pointer, valueFormatter: (v: number) => fmt(v) },
    axisPointer: { link: [{ xAxisIndex: [0, 1] }] }, // shared x-axis between Before and After
    dataZoom: large ? [{ type: 'inside', xAxisIndex: [0, 1] }] : undefined,
    grid,
    xAxis: [xAxis(0), xAxis(1), { type: 'value', gridIndex: 2, ...t.AXIS, name: 'MODIS × k', nameLocation: 'middle', nameGap: large ? 28 : 20, nameTextStyle: { fontSize: fs }, axisLabel: { ...t.AXIS.axisLabel, formatter: abbr } }],
    yAxis: [yAxis(0), yAxis(1), { ...yAxis(2), name: 'VIIRS', nameLocation: 'middle', nameGap: large ? 46 : 32, nameTextStyle: { fontSize: fs } }],
    series: [
      { name: 'MODIS raw', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: pts.map(q => q.modis), symbol: 'none', lineStyle: { color: T.dim, width: 1.5 }, itemStyle: { color: T.dim }, markLine: marker(false) },
      { name: 'VIIRS raw', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: pts.map(q => q.viirs), symbol: 'none', lineStyle: { color: '#3BB273', width: 1.5 }, itemStyle: { color: '#3BB273' } },
      { name: 'Harmonized', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: pts.map(q => q.h), symbol: 'none', lineStyle: { color: '#F2F3F5', width: large ? 3 : 2.5 }, itemStyle: { color: '#F2F3F5' }, markLine: marker(true), z: 3 },
      { name: 'MODIS × k', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: pts.map(q => q.k), symbol: 'none', lineStyle: { color: T.accent, width: 1.5, type: 'dashed' }, itemStyle: { color: T.accent }, z: 2 },
      { name: 'Validation', type: 'scatter', xAxisIndex: 2, yAxisIndex: 2, data: val, symbolSize: large ? 6 : 4, itemStyle: { color: 'rgba(232,116,59,0.7)' }, tooltip: { trigger: 'item', formatter: (q: any) => `MODIS × k ${fmt(q.value[0])}<br/>VIIRS ${fmt(q.value[1])}` },
        markLine: { silent: true, symbol: 'none', lineStyle: { color: T.dim, type: 'dashed' }, label: { formatter: '1:1', color: T.dim, fontSize: fs }, data: [[{ coord: [0, 0] }, { coord: [vmax, vmax] }]] } },
    ],
  }
}

// ---------- CSV of exactly what each chart shows ----------
const csvCell = (v: unknown) => (v == null ? '' : typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v))
export const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n')

export const calendarCsv = (rows: SeriesRow[]) => toCsv(
  ['year', 'month', 'hotspots', 'median_for_month', 'pct_vs_median', 'z', 'flag', 'source', 'note'],
  rows.map(r => [r.month.slice(0, 4), r.month.slice(5, 7), r.hotspots, r.hist_median, r.pct_vs_median, r.z, r.flag, r.source, r.note]))

export const lineCsv = (rows: SeriesRow[]) => toCsv(
  ['month', 'hotspots', 'median', 'mean', 'std', 'flag'],
  rows.map(r => [r.month, r.hotspots, r.hist_median, r.mean, r.std, r.flag]))

export const beforeAfterCsv = (rows: SeriesRow[]) => toCsv(
  ['month', 'modis_raw', 'viirs_raw', 'modis_x_k', 'harmonized', 'source'],
  rows.map(r => [r.month, r.modis, r.viirs, r.modis_scaled, r.hotspots, r.source]))

export function downloadText(name: string, text: string, type = 'text/csv') {
  const u = URL.createObjectURL(new Blob([text], { type }))
  Object.assign(document.createElement('a'), { href: u, download: name }).click()
  setTimeout(() => URL.revokeObjectURL(u), 1000)
}

/** Render an SVG element to a PNG at k x its viewBox size (dark background) and download it. Rejects on failure. */
export function svgToPng(svg: SVGSVGElement, k: number, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const vb = svg.viewBox.baseVal
    const clone = svg.cloneNode(true) as SVGSVGElement
    clone.setAttribute('width', String(vb.width * k))
    clone.setAttribute('height', String(vb.height * k))
    const src = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }))
    const img = new Image()
    img.onload = () => {
      try {
        const c = Object.assign(document.createElement('canvas'), { width: vb.width * k, height: vb.height * k })
        const ctx = c.getContext('2d')!
        ctx.fillStyle = T.panel
        ctx.fillRect(0, 0, c.width, c.height)
        ctx.drawImage(img, 0, 0)
        Object.assign(document.createElement('a'), { href: c.toDataURL('image/png'), download: name }).click()
        resolve()
      } catch (e) { reject(e) } finally { URL.revokeObjectURL(src) }
    }
    img.onerror = () => { URL.revokeObjectURL(src); reject(new Error('the chart image could not be rendered')) }
    img.src = src
  })
}

/** Fetch a server file and save it; throws with the server's reason (e.g. "too many hotspots") on failure. */
export async function downloadUrl(u: string, name: string) {
  const r = await fetch(u)
  if (!r.ok) {
    const detail = await r.json().then(j => j.detail as string).catch(() => `HTTP ${r.status}`)
    throw new Error(detail)
  }
  const href = URL.createObjectURL(await r.blob())
  Object.assign(document.createElement('a'), { href, download: name }).click()
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}

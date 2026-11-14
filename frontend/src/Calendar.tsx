import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Meta, SeriesRow } from './api'
import { MONTHS, fmt, monthLabel } from './colors'
import { svgToPng } from './charts'

// ColorBrewer YlOrRd (colour-blind safe): pale cream = few fires -> dark red = most. ZERO is near-white, not blue.
const FIRE = ['#ffffb2', '#fed976', '#feb24c', '#fd8d3c', '#f03b20', '#bd0026']
const ZERO = '#f6f3ea'
// ColorBrewer RdBu: blue below normal, white normal, red above
const DIVERGING = ['#2166ac', '#67a9cf', '#d1e5f0', '#f7f7f7', '#fddbc7', '#ef8a62', '#b2182b']
const PCT_BREAKS = [-50, -25, -10, 10, 33, 100] // ÷2, ÷1.33, -10%, +10%, ×1.33, ×2 — symmetric as ratios
const PCT_LABELS = ['≤ −50%', '−50 to −25%', '−25 to −10%', 'within ±10%', '+10 to +33%', '+33 to +100%', '≥ +100%']
const NO_BASE = '#d9d6cf' // median is 0: no "normal" to compare against

/** 850, 1.2k, 12k, 1.2M */
export const abbr = (v: number) => {
  const a = Math.abs(v)
  if (a < 1000) return String(Math.round(v))
  if (a < 9950) return `${(v / 1000).toFixed(1)}k`
  if (a < 999_500) return `${Math.round(v / 1000)}k`
  return `${(v / 1e6).toFixed(1)}M`
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const inkOn = (fill: string) => (luminance(fill) > 0.3 ? '#1b1b1b' : '#ffffff')

/** two significant figures, so legend ranges read cleanly */
const nice = (v: number) => {
  if (v < 10) return Math.round(v)
  const p = 10 ** (Math.floor(Math.log10(v)) - 1)
  return Math.round(v / p) * p
}

function fireClasses(values: number[]) {
  const nz = values.filter(v => v > 0).sort((a, b) => a - b)
  // Log-spaced (equal-ratio) breaks from the 10th percentile to the max: quantile breaks put every busy
  // season month into one top class, because most months of the year are quiet.
  const lo = Math.max(1, nz[Math.floor(0.1 * (nz.length - 1))] ?? 1), hi = nz[nz.length - 1] ?? 1
  const breaks: number[] = [] // lower bounds of classes 2..6
  for (let i = 1; i < 6; i++) {
    const b = nice(lo * (hi / lo) ** (i / 6))
    if (b > (breaks[breaks.length - 1] ?? 0)) breaks.push(b)
  }
  const classOf = (v: number) => (v <= 0 ? -1 : breaks.filter(b => v >= b).length)
  // spread available classes across the ramp so few classes still run light -> dark
  const color = (v: number) => (v <= 0 ? ZERO : FIRE[Math.round((classOf(v) * 5) / Math.max(1, breaks.length))])
  return { breaks, classOf, color, max: nz[nz.length - 1] ?? 0 }
}

const pctColor = (p: number | null) => (p == null ? NO_BASE : DIVERGING[PCT_BREAKS.filter(b => p > b).length])
const pctText = (p: number | null) => (p == null ? '—' : Math.abs(p) >= 1000 ? `×${Math.round(p / 100 + 1)}` : `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(Math.round(p))}`)

/** Fire season = contiguous months (wrapping Dec->Jan) around the peak with mean >= half the peak. */
function season(mean: number[]) {
  const peak = mean.indexOf(Math.max(...mean))
  const hot = (i: number) => mean[(i + 12) % 12] >= 0.5 * mean[peak]
  let a = peak, b = peak
  while (hot(a - 1) && (peak - a) < 11) a--
  while (hot(b + 1) && (b - a) < 11) b++
  const inRun = new Set(Array.from({ length: b - a + 1 }, (_, k) => (a + k + 12) % 12))
  const also = mean.map((_, i) => i).filter(i => !inRun.has(i) && hot(i))
  const name = (i: number) => MONTHS[(i + 12) % 12]
  return { peak, label: a === b ? name(a) : `${name(a)}–${name(b)}`, also: also.map(name) }
}

interface Props {
  rows: SeriesRow[]
  meta: Meta
  onPickMonth: (m: string) => void
  selected?: [string, string] // highlighted months (the timeline selection)
  large?: boolean // expanded view: wider cells, bigger text, full numbers
  svgRefOut?: (el: SVGSVGElement | null) => void
}

export default function Calendar({ rows, meta, onPickMonth, selected, large = false, svgRefOut }: Props) {
  const [mode, setMode] = useState<'hotspots' | 'normal'>('hotspots')
  const [numbers, setNumbers] = useState(true)
  const [newestFirst, setNewestFirst] = useState(true)
  const [focus, setFocus] = useState<{ y: number; m: number } | null>(null)
  const [tip, setTip] = useState<{ row: SeriesRow; x: number; y: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const d = useMemo(() => {
    const byMonth = new Map(rows.map(r => [r.month, r]))
    const yearsAsc = [...new Set(rows.map(r => r.month.slice(0, 4)))]
    const years = newestFirst ? [...yearsAsc].reverse() : yearsAsc
    const cls = fireClasses(rows.map(r => r.hotspots))
    const totals = Object.fromEntries(yearsAsc.map(y => [y, rows.filter(r => r.month.startsWith(y)).reduce((s, r) => s + r.hotspots, 0)]))
    const complete = (y: string) => byMonth.has(`${y}-01`) && byMonth.has(`${y}-12`)
    const fullYears = yearsAsc.filter(complete)
    const worst = (fullYears.length ? fullYears : yearsAsc).reduce((a, b) => (totals[b] > totals[a] ? b : a))
    const mean = MONTHS.map((_, i) => {
      const v = rows.filter(r => +r.month.slice(5, 7) === i + 1).map(r => r.hotspots)
      return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0
    })
    const s = season(mean)
    const last = byMonth.get(meta.last_complete_month ?? meta.last_month) ?? rows[rows.length - 1]
    return { byMonth, years, cls, totals, complete, worst, mean, season: s, last, maxTotal: Math.max(...Object.values(totals)) }
  }, [rows, meta, newestFirst])

  // ---------- layout (viewBox units = px at 408 wide) ----------
  const W = large ? 1200 : 408, LABEL = large ? 58 : 30, BAR = large ? 170 : 62, GAP = large ? 14 : 6
  const cw = (W - LABEL - GAP - BAR) / 12, ch = large ? 22 : 17, top = large ? 26 : 14
  const F = large ? { cell: 12.5, axis: 13, small: 11.5, tiny: 9, barText: 12 } : { cell: 7.6, axis: 8.5, small: 7, tiny: 5.5, barText: 7.5 }
  const num = (v: number) => (large ? fmt(v) : abbr(v))
  const gridH = d.years.length * ch
  const bottom = top + gridH + 6, bottomH = large ? 64 : 34
  const H = bottom + bottomH + 14
  const x = (m: number) => LABEL + m * cw
  const y = (i: number) => top + i * ch
  const maxMean = Math.max(...d.mean, 1)

  const fillOf = (r: SeriesRow) => (mode === 'hotspots' ? d.cls.color(r.hotspots) : pctColor(r.pct_vs_median))
  const textOf = (r: SeriesRow) => (mode === 'hotspots' ? (r.hotspots > 0 ? num(r.hotspots) : '0') : pctText(r.pct_vs_median) + (large && r.pct_vs_median != null ? '%' : ''))
  const isGap = (r: SeriesRow) => r.note.includes('data gap')
  const isProv = (r: SeriesRow) => r.note.includes('provisional')

  const cellKey = (yi: number, m: number) => `${d.years[yi]}-${String(m + 1).padStart(2, '0')}`
  const show = (yi: number, m: number) => {
    const r = d.byMonth.get(cellKey(yi, m))
    const box = svgRef.current?.getBoundingClientRect()
    if (!r || !box) return setTip(null)
    const scale = box.width / W
    setTip({ row: r, x: (x(m) + cw / 2) * scale, y: y(yi) * scale })
  }
  const onKey = (e: KeyboardEvent, yi: number, m: number) => {
    const mv: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const k = cellKey(yi, m)
      if (d.byMonth.has(k)) onPickMonth(k)
      return
    }
    const step = mv[e.key]
    if (!step) return
    e.preventDefault()
    const ny = Math.min(d.years.length - 1, Math.max(0, yi + step[0])), nm = Math.min(11, Math.max(0, m + step[1]))
    setFocus({ y: ny, m: nm })
    const next = svgRef.current?.querySelector<SVGGElement>(`[data-cell="${ny}-${nm}"]`)
    next?.focus()
    show(ny, nm)
  }

  const [pngErr, setPngErr] = useState<string | null>(null)
  const exportPng = () => { setPngErr(null); if (svgRef.current) svgToPng(svgRef.current, large ? 3 : 2, 'hots45_calendar.png').catch(e => setPngErr(`PNG download failed: ${e.message}`)) }

  // ---------- plain-language summary ----------
  const L = d.last
  const lastTxt = L.pct_vs_median == null ? 'no normal to compare (median is 0)'
    : Math.abs(L.pct_vs_median) < 10 ? 'about normal'
      : `${Math.abs(Math.round(L.pct_vs_median))}% ${L.pct_vs_median < 0 ? 'below' : 'above'} normal`
  const seasonTxt = d.mean.every(v => v === 0) ? 'no fires recorded'
    : `${d.season.label}${d.season.also.length ? ` (also ${d.season.also.join(', ')})` : ''}`

  const chip = (on: boolean) => `h-6 px-2 text-[11px] ${on ? 'bg-accent text-bg font-medium' : 'text-dim hover:text-ink'}`
  const firstFocusable = focus ?? { y: 0, m: 0 }

  return (
    <div>
      <p className={`${large ? "text-[16px]" : "text-[12px]"} text-ink leading-relaxed mb-2`} aria-live="polite">
        Fire season: <b>{seasonTxt}</b>. Worst year: <b>{d.worst}</b> ({abbr(d.totals[d.worst])} hotspots).
        {' '}Latest complete month ({monthLabel(L.month)}): <b>{lastTxt}</b>{isProv(L) ? ' (provisional)' : ''}.
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="flex border border-line rounded-sm overflow-hidden" role="group" aria-label="Calendar colour mode">
          <button className={chip(mode === 'hotspots')} aria-pressed={mode === 'hotspots'} onClick={() => setMode('hotspots')}>Hotspots</button>
          <button className={chip(mode === 'normal')} aria-pressed={mode === 'normal'} onClick={() => setMode('normal')}>Compared to normal</button>
        </div>
        <label className="flex items-center gap-1 text-[11px] text-dim">
          <input type="checkbox" checked={numbers} onChange={e => setNumbers(e.target.checked)} className="accent-[#E8743B]" /> Numbers
        </label>
        <button className="text-[11px] text-dim hover:text-ink underline underline-offset-2" onClick={() => setNewestFirst(!newestFirst)}>
          {newestFirst ? 'Newest first' : 'Oldest first'} ⇅
        </button>
        <button className="ml-auto text-[11px] text-dim hover:text-ink underline underline-offset-2" onClick={exportPng} aria-label="Download calendar as PNG">PNG</button>
        {pngErr && <span role="alert" className="text-[11px] text-accent">{pngErr}</span>}
      </div>

      <div className="relative">
        <svg ref={el => { svgRef.current = el; svgRefOut?.(el) }} viewBox={`0 0 ${W} ${H}`} width="100%" role="grid" onMouseLeave={() => setTip(null)}
          aria-label={`Burning calendar, ${d.years.length} years by 12 months. Arrow keys move between months, Enter shows that month on the map.`}
          style={{ fontFamily: 'IBM Plex Mono, ui-monospace, monospace' }}>
          <defs>
            {['dark', 'light'].map(t => (
              <pattern key={t} id={`hatch-${t}`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="4" stroke={t === 'dark' ? '#1b1b1b' : '#ffffff'} strokeWidth="1.2" strokeOpacity="0.45" />
              </pattern>
            ))}
          </defs>

          {/* month header; peak month highlighted */}
          {MONTHS.map((m, i) => (
            <text key={m} x={x(i) + cw / 2} y={top - 4} textAnchor="middle" fontSize={F.axis}
              fill={i === d.season.peak ? '#E8743B' : '#9AA3AE'} fontWeight={i === d.season.peak ? 700 : 400}>{m}</text>
          ))}
          <text x={LABEL + 12 * cw + GAP} y={top - 4} fontSize={F.small} fill="#8A939E">Year total</text>

          {d.years.map((yr, yi) => (
            <g key={yr} role="row">
              <text x={LABEL - 4} y={y(yi) + ch / 2 + 3} textAnchor="end" fontSize={F.axis}
                fill={yr === d.worst ? '#E8743B' : '#9AA3AE'} fontWeight={yr === d.worst ? 700 : 400}>{yr}</text>
              {MONTHS.map((_, m) => {
                const r = d.byMonth.get(cellKey(yi, m))
                const cx = x(m), cy = y(yi)
                if (!r) return <rect key={m} x={cx + 0.5} y={cy + 0.5} width={cw - 1} height={ch - 1} fill="#1B1F26" />
                const fill = fillOf(r), ink = inkOn(fill)
                const isFocus = focus?.y === yi && focus?.m === m
                const isSel = !!selected && r.month >= selected[0] && r.month <= selected[1]
                return (
                  <g key={m} role="gridcell" data-cell={`${yi}-${m}`} style={{ cursor: 'pointer', outline: 'none' }}
                    tabIndex={firstFocusable.y === yi && firstFocusable.m === m ? 0 : -1}
                    aria-label={`${monthLabel(r.month)}: ${fmt(r.hotspots)} hotspots, ${r.pct_vs_median == null ? 'no median' : `${pctText(r.pct_vs_median)}% vs median`}${r.flag ? `, ${r.flag}` : ''}${r.note ? `, ${r.note}` : ''}`}
                    onMouseEnter={() => show(yi, m)} onFocus={() => { setFocus({ y: yi, m }); show(yi, m) }}
                    onClick={() => onPickMonth(r.month)} onKeyDown={e => onKey(e, yi, m)}>
                    <rect x={cx + 0.5} y={cy + 0.5} width={cw - 1} height={ch - 1} rx="1.5" fill={fill}
                      stroke={isFocus ? '#E6E8EB' : isSel ? '#E8743B' : 'none'} strokeWidth={isSel && !isFocus ? 2 : 1.5} />
                    {isGap(r) && <rect x={cx + 0.5} y={cy + 0.5} width={cw - 1} height={ch - 1} rx="1.5" fill={`url(#hatch-${ink === '#ffffff' ? 'light' : 'dark'})`} />}
                    {numbers && (
                      <text x={cx + cw / 2} y={cy + ch / 2 + F.cell * 0.36} textAnchor="middle" fontSize={F.cell} fill={ink}>{textOf(r)}</text>
                    )}
                    {mode === 'hotspots' && r.flag && (
                      <circle cx={cx + cw - (large ? 6 : 3.2)} cy={cy + (large ? 6 : 3.2)} r={large ? 3.5 : 1.9} fill={ink} stroke={fill} strokeWidth="0.6" />
                    )}
                    {isProv(r) && <text x={cx + 3} y={cy + ch - 3} fontSize={F.tiny} fontWeight="700" fill={ink}>P</text>}
                  </g>
                )
              })}
              {/* right margin: year total */}
              <rect x={LABEL + 12 * cw + GAP} y={y(yi) + 4} height={ch - 8} rx="1"
                width={Math.max(1, (d.totals[yr] / d.maxTotal) * (BAR - (large ? 74 : 30)))} fill={yr === d.worst ? '#E8743B' : '#6B7480'} />
              <text x={LABEL + 12 * cw + GAP + (d.totals[yr] / d.maxTotal) * (BAR - (large ? 74 : 30)) + 4} y={y(yi) + ch / 2 + F.barText * 0.36}
                fontSize={F.barText} fill={yr === d.worst ? '#E8743B' : '#9AA3AE'}>
                {num(d.totals[yr])}{d.complete(yr) ? '' : '*'}
              </text>
            </g>
          ))}

          {/* bottom margin: mean per calendar month (the fire season) */}
          {d.mean.map((v, i) => {
            const h = (v / maxMean) * (bottomH - (large ? 18 : 10))
            return (
              <g key={i}>
                <rect x={x(i) + 3} y={bottom + bottomH - (large ? 18 : 10) - h} width={cw - 6} height={Math.max(0.5, h)} rx="1"
                  fill={i === d.season.peak ? '#E8743B' : '#6B7480'} />
                <text x={x(i) + cw / 2} y={bottom + bottomH - 1} textAnchor="middle" fontSize={F.small} fill={i === d.season.peak ? '#E8743B' : '#8A939E'}>
                  {num(Math.round(v))}
                </text>
              </g>
            )
          })}
          <text x={LABEL - 4} y={bottom + bottomH - 1} textAnchor="end" fontSize={F.small} fill="#8A939E">{large ? 'Avg' : 'avg'}</text>
        </svg>

        {tip && (
          <div className="absolute z-10 pointer-events-none num text-[11px] leading-relaxed bg-panel border border-line rounded-sm px-2.5 py-1.5 w-max max-w-[240px]"
            style={{ left: Math.min(tip.x, 200), top: tip.y - 8, transform: 'translate(-30%, -100%)' }} role="tooltip">
            <div className="text-ink font-medium">{monthLabel(tip.row.month)}</div>
            <div>{fmt(tip.row.hotspots)} hotspots</div>
            <div className="text-dim">median for {MONTHS[+tip.row.month.slice(5, 7) - 1]}: {fmt(tip.row.hist_median)}</div>
            <div className="text-dim">{tip.row.pct_vs_median == null ? 'no median to compare' : `${pctText(tip.row.pct_vs_median)}% vs median`}{tip.row.flag ? ` · ${tip.row.flag}` : ''}</div>
            <div className="text-dim">{tip.row.source === 'VIIRS' ? 'VIIRS' : 'MODIS scaled to VIIRS'}</div>
            {tip.row.note && <div className="text-accent">{tip.row.note}</div>}
            <div className="text-faint text-[10px]">Click to show on the map</div>
          </div>
        )}
      </div>

      {/* legend */}
      <div className={`mt-2 flex flex-wrap gap-x-2 gap-y-1 items-center num ${large ? "text-[13px]" : "text-[10px]"} text-dim`} aria-label="Colour legend">
        {mode === 'hotspots' ? (
          <>
            <span className="inline-flex items-center gap-1"><i className="w-3 h-2.5 rounded-[2px] inline-block" style={{ background: ZERO }} />0</span>
            {[0, ...d.cls.breaks].map((b, i, arr) => (
              <span key={b} className="inline-flex items-center gap-1">
                <i className="w-3 h-2.5 rounded-[2px] inline-block" style={{ background: d.cls.color(Math.max(b, 1)) }} />
                {i + 1 < arr.length ? `${abbr(Math.max(1, b))}–${abbr(arr[i + 1])}` : `≥ ${abbr(b)}`}
              </span>
            ))}
          </>
        ) : (
          DIVERGING.map((c, i) => (
            <span key={c} className="inline-flex items-center gap-1"><i className="w-3 h-2.5 rounded-[2px] inline-block border border-line" style={{ background: c }} />{PCT_LABELS[i]}</span>
          ))
        )}
      </div>
      <p className="mt-1 text-[10px] text-faint">
        {mode === 'hotspots' ? 'Hotspots per month (VIIRS-equivalent). ● significant anomaly (|z| > 2) · ' : 'Numbers: % vs the median for that month; grey = median is 0. '}
        <span className="inline-block w-3 h-2 align-middle mr-0.5" style={{ background: 'repeating-linear-gradient(45deg,#9AA3AE 0 1px,transparent 1px 3px)' }} />data gap · <b>P</b> provisional (NRT) · * partial year
      </p>
    </div>
  )
}

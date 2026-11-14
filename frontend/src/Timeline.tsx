import { useEffect } from 'react'
import { monthLabel } from './colors'

export type Mode = 'month' | 'range'

interface Props {
  months: string[]
  mode: Mode
  setMode: (m: Mode) => void
  idx: number
  setIdx: (f: (i: number) => number) => void
  range: [number, number]
  setRange: (r: [number, number]) => void
  playing: boolean
  setPlaying: (p: boolean) => void
  speed: number
  setSpeed: (s: number) => void
  spark?: number[]
  sparkLabel: string
}

const btn = 'h-7 px-2.5 border border-line rounded-sm bg-raised hover:border-dim text-[12px]'

export default function Timeline(p: Props) {
  const n = p.months.length

  useEffect(() => {
    if (!p.playing) return
    const t = setInterval(() => p.setIdx(i => (i + 1) % n), 800 / p.speed)
    return () => clearInterval(t)
  }, [p.playing, p.speed, n, p.setIdx])

  const max = Math.max(1, ...(p.spark ?? [0]))
  const pts = (p.spark ?? []).map((v, i) => `${(i / Math.max(1, n - 1)) * 1000},${40 - (v / max) * 38}`).join(' ')
  const years = p.months.filter(m => m.endsWith('-01'))
  const label = p.mode === 'month'
    ? monthLabel(p.months[p.idx])
    : `${monthLabel(p.months[p.range[0]])} – ${monthLabel(p.months[p.range[1]])}`

  return (
    <div className="border-t border-line bg-panel px-4 pt-2 pb-2 flex items-center gap-4">
      <div className="flex items-center gap-1.5 shrink-0">
        <button className={`${btn} w-16`} aria-pressed={p.playing}
          onClick={() => { if (!p.playing) p.setMode('month'); p.setPlaying(!p.playing) }}>
          {p.playing ? 'Pause' : 'Play'}
        </button>
        <label className="sr-only" htmlFor="speed">Playback speed</label>
        <select id="speed" className={`${btn} num`} value={p.speed} onChange={e => p.setSpeed(+e.target.value)}>
          {[0.5, 1, 2, 4].map(s => <option key={s} value={s}>{s}×</option>)}
        </select>
        <div className="flex border border-line rounded-sm overflow-hidden ml-1" role="group" aria-label="Timeline mode">
          {(['month', 'range'] as Mode[]).map(m => (
            <button key={m} aria-pressed={p.mode === m}
              className={`h-7 px-2.5 text-[12px] ${p.mode === m ? 'bg-accent text-bg font-medium' : 'bg-raised text-dim hover:text-ink'}`}
              onClick={() => { p.setPlaying(false); p.setMode(m) }}>
              {m === 'month' ? 'Month' : 'Range'}
            </button>
          ))}
        </div>
      </div>

      <div className="num text-[15px] font-medium w-[230px] shrink-0" aria-live="polite">{label}</div>

      <div className="flex-1 min-w-0">
        <div className="relative h-10">
          <svg viewBox="0 0 1000 40" preserveAspectRatio="none" className="absolute inset-0 w-full h-full" aria-hidden>
            <polyline points={pts} fill="none" stroke="#6B7480" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </svg>
          {p.mode === 'month' ? (
            <input type="range" aria-label="Month" className="absolute inset-x-0 bottom-0 w-full"
              min={0} max={n - 1} value={p.idx} aria-valuetext={monthLabel(p.months[p.idx])}
              onChange={e => { p.setPlaying(false); const v = +e.target.value; p.setIdx(() => v) }} />
          ) : (
            <div className="dual absolute inset-x-0 bottom-0 h-5">
              <input type="range" aria-label="Range start" min={0} max={n - 1} value={p.range[0]}
                aria-valuetext={monthLabel(p.months[p.range[0]])}
                onChange={e => p.setRange([Math.min(+e.target.value, p.range[1]), p.range[1]])} />
              <input type="range" aria-label="Range end" min={0} max={n - 1} value={p.range[1]}
                aria-valuetext={monthLabel(p.months[p.range[1]])}
                onChange={e => p.setRange([p.range[0], Math.max(+e.target.value, p.range[0])])} />
              <div className="absolute top-[9px] h-[2px] bg-accent pointer-events-none"
                style={{ left: `${(p.range[0] / Math.max(1, n - 1)) * 100}%`, right: `${100 - (p.range[1] / Math.max(1, n - 1)) * 100}%` }} />
            </div>
          )}
        </div>
        <div className="relative h-3.5 num text-[10px] text-faint" aria-hidden>
          {years.map(m => (
            <span key={m} className="absolute -translate-x-1/2" style={{ left: `${(p.months.indexOf(m) / Math.max(1, n - 1)) * 100}%` }}>
              {m.slice(0, 4)}
            </span>
          ))}
        </div>
      </div>
      <div className="text-[10px] text-faint w-[120px] shrink-0 leading-tight">Sparkline: {p.sparkLabel}, monthly hotspots</div>
    </div>
  )
}

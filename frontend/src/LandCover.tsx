import type { LandCover, Meta } from './api'
import { fmt, lcColor } from './colors'
import { Segmented, Select } from './ui'

/** "All fires | Forest | Cropland | …" — groups come from meta.land_cover; hidden when land cover is not built.
 *  compact: a dropdown, for one-row toolbars (timeline). */
export function FireTypeFilter({ meta, value, onChange, compact }: { meta: Meta; value: string; onChange: (v: string) => void; compact?: boolean }) {
  const groups = meta.land_cover?.groups
  if (!groups) return null
  const opts = [{ key: 'all', label: 'All fires' }, ...groups]
  if (compact) return <Select label="Fire type" value={value} onChange={onChange} options={opts.map(g => ({ value: g.key, label: g.label }))} />
  return (
    <Segmented label="Fire type" value={value} onChange={onChange}
      options={opts.map(g => ({ value: g.key, label: <>{g.key !== 'all' && <span className="h-2 w-2 rounded-sm" style={{ background: lcColor(g.key) }} aria-hidden />}{g.label}</> }))} />
  )
}

/** Stacked bar of shares + plain-language summary, all from /api/landcover. */
export function WhatIsBurning({ lc }: { lc: LandCover }) {
  const shown = lc.groups.filter(g => g.hotspots > 0).sort((a, b) => b.share - a.share)
  return (
    <>
      <p className="text-sm text-ink mb-2" aria-live="polite">{lc.text}</p>
      {lc.total > 0 && (
        <>
          <div className="flex h-3 rounded-sm overflow-hidden mb-2" role="img"
            aria-label={shown.map(g => `${g.label} ${g.share.toFixed(1)}%`).join(', ')}>
            {shown.map(g => <div key={g.key} style={{ width: `${g.share}%`, background: lcColor(g.key) }} title={`${g.label} ${g.share.toFixed(1)}%`} />)}
          </div>
          <ul className="grid grid-cols-[12px_1fr_auto_48px] gap-x-2 gap-y-1 items-center text-xs">
            {shown.map(g => (
              <li key={g.key} className="contents">
                <span className="h-2 w-3 rounded-sm" style={{ background: lcColor(g.key) }} aria-hidden />
                <span className="text-ink">{g.label}</span>
                <span className="num text-dim">{fmt(g.hotspots)}</span>
                <span className="num text-ink text-right">{g.share.toFixed(g.share < 10 ? 1 : 0)}%</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="text-xs text-dim mt-2">{lc.note} Each hotspot uses the previous year's map.</p>
    </>
  )
}

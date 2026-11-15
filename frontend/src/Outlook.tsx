import type { Outlook } from './api'
import { fmt, monthLabel } from './colors'
import { Disclosure } from './ui'

const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const pct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v)}%`)

/** "Next month: likely below normal (60–80% chance)", the range, season dates and how reliable it has been here. */
export function OutlookCard({ o }: { o: Outlook }) {
  const [first, ...rest] = o.months
  const b = o.backtest
  const skillOf = (h: number) => b?.by_horizon[h] && 1 - b.by_horizon[h].mae_model / b.by_horizon[h].mae_reference
  if (!first) return <p className="text-xs text-dim">Not enough history in this area for an outlook (needs at least 3 VIIRS-era years of the same month).</p>
  const line = (m: Outlook['months'][number]) => (
    <>expected <span className="num text-ink">{fmt(m.pred)}</span> hotspots (80% range <span className="num">{fmt(m.lo)}–{fmt(m.hi)}</span>; normal <span className="num">{fmt(m.normal)}</span>)</>
  )
  return (
    <>
      <p className="text-sm text-ink" aria-live="polite">
        Next month ({monthLabel(first.month)}): <b>{first.text}</b>
      </p>
      <p className="text-xs text-dim mb-2">{line(first)}{first.using === 'reference' && ' · historical median shown'}</p>
      <ul className="text-xs text-dim space-y-1 mb-2">
        {rest.map(m => (
          <li key={m.month}><span className="text-ink">{monthLabel(m.month)}</span>: {m.text}; {line(m)}{m.using === 'reference' && ' · historical median shown'}</li>
        ))}
      </ul>
      {o.season && (
        <p className="text-xs text-dim mb-2">
          {o.season.underway ? 'Season underway' : 'Next season'}: starts ~<span className="text-ink">{day(o.season.start.date)}</span> ({day(o.season.start.lo)}–{day(o.season.start.hi)}),
          peaks ~<span className="text-ink">{day(o.season.peak.date)}</span> ({day(o.season.peak.lo)}–{day(o.season.peak.hi)}),
          ends ~<span className="text-ink">{day(o.season.end.date)}</span> ({day(o.season.end.lo)}–{day(o.season.end.hi)}) · typical of {o.season.years} VIIRS-era seasons.
        </p>
      )}
      {o.provisional_inputs.length > 0 && <p className="text-xs text-accent mb-1">Based partly on provisional (near-real-time) data for {[...o.provisional_inputs].sort().map(monthLabel).join(', ')}.</p>}
      <Disclosure summary="How reliable is this?">
        {b ? (
          <div className="space-y-2">
            <p>
              Backtest for this area, {monthLabel(b.period[0])} – {monthLabel(b.period[1])}: {b.n} forecasts, each made only from data before it.
              Average error <span className="num text-ink">{fmt(b.mae_model)}</span> hotspots vs <span className="num">{fmt(b.mae_reference)}</span> for
              the plain historical median ({b.skill >= 0 ? `${Math.round(b.skill * 100)}% better` : `${Math.round(-b.skill * 100)}% worse`}).
              1/2/3 months ahead: {[1, 2, 3].map(h => { const s = skillOf(h); return s == null ? '—' : `${s >= 0 ? '+' : '−'}${Math.abs(Math.round(s * 100))}%` }).join(' / ')}.
            </p>
            <p>
              Actual value inside the 80% range: {pct(b.coverage_model_calibrated)} of {b.n_calibrated} forecasts since {b.calibrated_from ? monthLabel(b.calibrated_from) : '—'}{' '}
              ({pct(b.coverage_model)} including the first years, when too few past errors existed to size the range).
            </p>
            {o.using !== 'model' && (
              <p className="text-ink">
                {o.using === 'reference' ? 'The model did not beat the historical median here, so the outlook shows the historical median.'
                  : 'For horizons where the model did not beat the historical median here, the outlook shows the historical median.'}
              </p>
            )}
            <p>
              Method: median of the same month in VIIRS-era years, adjusted by a robust trend (Sen's slope, used only if Mann-Kendall
              p &lt; 0.05{first.trend.applied ? `; applied here: ×${first.trend.factor.toFixed(2)}` : '; not significant here'}) and by how the last
              3 months compare with normal ({first.persistence.ratio.toFixed(2)}×), with a weight learned from past forecasts. It cannot foresee
              droughts or El Niño years that start from a quiet period.
            </p>
          </div>
        ) : <p>Too little history in this area for a backtest.</p>}
      </Disclosure>
      <p className="text-xs text-dim mt-2">{o.disclaimer}</p>
    </>
  )
}

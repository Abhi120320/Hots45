import type { Meta } from './api'
import { Segmented } from './ui'

export type Metric = 'hotspots' | 'frp'
/** unit word next to a number: "1,200 hotspots" / "1,200 MW" */
export const unitOf = (m: Metric) => (m === 'frp' ? 'MW' : 'hotspots')

/** "Hotspots | Intensity (FRP)" — shown on the calendar, timeline and KPIs; hidden until FRP is built. */
export function MetricToggle({ meta, value, onChange }: { meta: Meta; value: Metric; onChange: (m: Metric) => void }) {
  if (!meta.frp) return null
  return <Segmented label="Measure" value={value} onChange={onChange}
    options={[{ value: 'hotspots', label: 'Hotspots' }, { value: 'frp', label: 'Intensity (FRP)' }]} />
}

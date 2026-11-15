import { useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import type { Meta, SeriesRow } from './api'
import { beforeAfterOption } from './charts'
import { Segmented } from './ui'

export default function BeforeAfter({ rows, meta, large = false, height, onReady }: {
  rows: SeriesRow[]; meta: Meta; large?: boolean; height?: number; onReady?: (c: any) => void
}) {
  const [yearly, setYearly] = useState(true)
  const h = height ?? 460
  const option = useMemo(() => beforeAfterOption(rows, meta, large, yearly, h), [rows, meta, large, yearly, h])
  return (
    <div>
      <div className="flex justify-end mb-2">
        <Segmented label="Totals" value={yearly ? 'y' : 'm'} onChange={v => setYearly(v === 'y')} options={[{ value: 'y', label: 'Yearly' }, { value: 'm', label: 'Monthly' }]} />
      </div>
      <ReactECharts option={option} style={{ height: h }} notMerge onChartReady={onReady} />
    </div>
  )
}

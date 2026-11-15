import { useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import type { Meta, SeriesRow } from './api'
import { beforeAfterOption } from './charts'

export default function BeforeAfter({ rows, meta, large = false, height, onReady }: {
  rows: SeriesRow[]; meta: Meta; large?: boolean; height?: number; onReady?: (c: any) => void
}) {
  const [yearly, setYearly] = useState(true)
  const h = height ?? 460
  const option = useMemo(() => beforeAfterOption(rows, meta, large, yearly, h), [rows, meta, large, yearly, h])
  const chip = (on: boolean) => `px-2 ${large ? 'h-8 text-[14px]' : 'h-6 text-[11px]'} ${on ? 'bg-accent text-bg font-medium' : 'text-dim hover:text-ink'}`
  return (
    <div>
      <div className="flex justify-end mb-1">
        <div className="flex border border-line rounded-sm overflow-hidden" role="group" aria-label="Totals">
          <button className={chip(yearly)} aria-pressed={yearly} onClick={() => setYearly(true)}>Yearly</button>
          <button className={chip(!yearly)} aria-pressed={!yearly} onClick={() => setYearly(false)}>Monthly</button>
        </div>
      </div>
      <ReactECharts option={option} style={{ height: h }} notMerge onChartReady={onReady} />
    </div>
  )
}

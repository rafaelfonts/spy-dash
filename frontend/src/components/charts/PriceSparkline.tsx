import { useMemo } from 'react'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceLine,
} from 'recharts'
import type { PricePoint } from '../../store/marketStore'

interface PriceSparklineProps {
  data: PricePoint[]
  color?: string
  height?: number
  showTooltip?: boolean
}

function formatHHMM(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/New_York',
  })
}

// Generate X-axis tick values at 30-min boundaries (NYSE session: 09:30–16:00 ET)
function buildXTicks(data: PricePoint[]): number[] {
  if (data.length < 2) return []
  const first = data[0].t
  const last = data[data.length - 1].t
  const ticks: number[] = []
  // Start from the nearest 30-min boundary >= first point
  const d = new Date(first)
  d.setSeconds(0, 0)
  const minutes = d.getMinutes()
  const nextHalfHour = minutes < 30 ? 30 : 60
  d.setMinutes(nextHalfHour)
  let t = d.getTime()
  while (t <= last) {
    ticks.push(t)
    t += 30 * 60 * 1000
  }
  return ticks
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null
  const { t, v } = payload[0].payload as { t: number; v: number }
  return (
    <div className="bg-bg-elevated border border-border rounded px-2 py-1 text-xs pointer-events-none">
      <div className="text-text-secondary">{formatHHMM(t)}</div>
      <div className="text-text-primary font-mono">${v.toFixed(2)}</div>
    </div>
  )
}

export function PriceSparkline({
  data,
  color = '#00ff88',
  height = 48,
  showTooltip = true,
}: PriceSparklineProps) {
  const chartData = useMemo(
    () => data.map((pt) => ({ t: pt.t, v: pt.p })),
    [data],
  )

  if (data.length < 2) {
    return (
      <div
        className="skeleton w-full rounded opacity-30"
        style={{ height }}
      />
    )
  }

  const firstPrice = data[0].p
  const lastPrice = data[data.length - 1].p
  const isPositive = lastPrice >= firstPrice
  const lineColor = isPositive ? '#00ff88' : '#ff4444'
  const gradientId = `gradient-${color.replace('#', '')}`

  const xTicks = buildXTicks(data)

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={lineColor} stopOpacity={0.3} />
            <stop offset="95%" stopColor={lineColor} stopOpacity={0} />
          </linearGradient>
        </defs>

        <XAxis
          dataKey="t"
          type="number"
          domain={['dataMin', 'dataMax']}
          scale="time"
          ticks={xTicks}
          tickFormatter={formatHHMM}
          tick={{ fill: '#6b7280', fontSize: 9 }}
          tickLine={false}
          axisLine={false}
          height={14}
        />

        <YAxis
          domain={['auto', 'auto']}
          hide
        />

        {showTooltip && (
          <Tooltip
            content={<CustomTooltip />}
            cursor={{ stroke: '#4b5563', strokeWidth: 1 }}
          />
        )}

        {/* Reference line at session open price */}
        <ReferenceLine
          y={firstPrice}
          stroke="#374151"
          strokeDasharray="3 3"
          strokeWidth={1}
        />

        <Area
          type="monotone"
          dataKey="v"
          stroke={lineColor}
          strokeWidth={1.5}
          fill={`url(#${gradientId})`}
          dot={false}
          animationDuration={0}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

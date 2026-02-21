import { useMemo } from 'react'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  Tooltip,
  ReferenceLine,
} from 'recharts'

interface PriceSparklineProps {
  data: number[]
  color?: string
  height?: number
  showTooltip?: boolean
}

export function PriceSparkline({
  data,
  color = '#00ff88',
  height = 48,
  showTooltip = false,
}: PriceSparklineProps) {
  const chartData = useMemo(
    () => data.map((value, index) => ({ index, value })),
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

  const first = data[0]
  const last = data[data.length - 1]
  const isPositive = last >= first
  const lineColor = isPositive ? '#00ff88' : '#ff4444'
  const gradientId = `gradient-${color.replace('#', '')}`

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={lineColor} stopOpacity={0.3} />
            <stop offset="95%" stopColor={lineColor} stopOpacity={0} />
          </linearGradient>
        </defs>

        {showTooltip && (
          <Tooltip
            content={({ active, payload }) =>
              active && payload?.[0] ? (
                <div className="bg-bg-elevated border border-border px-2 py-1 rounded text-xs font-mono text-text-primary">
                  ${(payload[0].value as number).toFixed(2)}
                </div>
              ) : null
            }
          />
        )}

        <Area
          type="monotone"
          dataKey="value"
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

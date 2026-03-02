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

// Calculate NYSE session open (09:30) and close (16:00) epoch ms for the given reference timestamp
function sessionBounds(referenceTs: number): [number, number] {
  const ref = new Date(referenceTs)
  // Compute UTC↔NY offset by comparing UTC ms to NY local parse
  const utcMs = ref.getTime()
  const nyMs = new Date(ref.toLocaleString('en-US', { timeZone: 'America/New_York' })).getTime()
  const offsetMs = utcMs - nyMs

  const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(ref)
  const open = new Date(`${nyDate}T09:30:00`).getTime() + offsetMs
  const close = new Date(`${nyDate}T16:00:00`).getTime() + offsetMs
  return [open, close]
}

// Generate exactly 5 evenly-spaced X-axis ticks across the session
function buildXTicks(open: number, close: number): number[] {
  return [0, 1, 2, 3, 4].map(i => open + Math.round(i * (close - open) / 4))
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
  // Session bounds derived from first data point's calendar date in ET
  const refTs = data.length > 0 ? data[0].t : Date.now()
  const [sessionOpen, sessionClose] = sessionBounds(refTs)

  // Map all data — no explicit filter needed. The XAxis domain={[sessionOpen, sessionClose]}
  // applies an SVG clipPath so points outside 09:30–16:00 are invisible.
  // This avoids skeleton when only post-close ticks are available (e.g. VIX extended hours).
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

  const xTicks = buildXTicks(sessionOpen, sessionClose)

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={chartData} margin={{ top: 2, right: 4, left: 4, bottom: 2 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={lineColor} stopOpacity={0.3} />
            <stop offset="95%" stopColor={lineColor} stopOpacity={0} />
          </linearGradient>
        </defs>

        <XAxis
          dataKey="t"
          type="number"
          domain={[sessionOpen, sessionClose]}
          scale="time"
          ticks={xTicks}
          interval={0}
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

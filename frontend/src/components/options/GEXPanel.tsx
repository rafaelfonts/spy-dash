import { memo, useMemo } from 'react'
import { motion } from 'framer-motion'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  LabelList,
} from 'recharts'
import { useMarketStore } from '../../store/marketStore'

function fmtM(v: number): string {
  return `$${Math.abs(v).toFixed(1)}M`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function GEXCustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const callGex = payload.find((p: any) => p.dataKey === 'callGex')?.value ?? 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const putGex = payload.find((p: any) => p.dataKey === 'putGex')?.value ?? 0
  const net = callGex - putGex
  return (
    <div className="bg-bg-elevated border border-border rounded px-2 py-1.5 text-xs pointer-events-none">
      <div className="text-text-secondary mb-1 font-num">Strike {label}</div>
      <div className="text-[#00ff88]">Call: +${callGex.toFixed(1)}M</div>
      <div className="text-red-400">Put: -${putGex.toFixed(1)}M</div>
      <div className={`mt-0.5 font-semibold ${net >= 0 ? 'text-[#00ff88]' : 'text-red-400'}`}>
        Net: {net >= 0 ? '+' : ''}{net.toFixed(1)}M
      </div>
    </div>
  )
}

const REFERENCE_LINES = [
  { color: '#ffffff', label: 'Preço' },
  { color: '#ffcc00', label: 'Flip Point' },
  { color: '#cc44ff', label: 'Put Wall' },
  { color: '#4488ff', label: 'Call Wall' },
  { color: '#00ffcc', label: 'Max Gamma' },
]

export const GEXPanel = memo(function GEXPanel() {
  const gex = useMarketStore((s) => s.gexProfile)
  const spyLast = useMarketStore((s) => s.spy.last)

  const chartData = useMemo(() => {
    if (!gex || !spyLast) return []
    return gex.byStrike
      .filter((s) => Math.abs(s.strike - spyLast) <= 15)
      .sort((a, b) => a.strike - b.strike)
      .map((s) => ({
        strike: s.strike,
        callGex: s.callGEX,
        putGex: Math.abs(s.putGEX),
        netGex: s.netGEX,
      }))
  }, [gex, spyLast])

  if (!gex) {
    return (
      <motion.section
        className="card mt-4 opacity-50"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 0.5, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-display font-bold text-text-primary tracking-wide">
            Gamma Exposure (GEX)
          </span>
          <span className="text-[10px] text-text-muted">Desabilitado</span>
        </div>
        <p className="text-xs text-text-secondary leading-relaxed">
          GEX requer dados de open interest via Tradier API.{' '}
          Adicione{' '}
          <code className="text-[11px] bg-surface-2 px-1 rounded">TRADIER_API_KEY=&lt;key&gt;</code>{' '}
          no <code className="text-[11px] bg-surface-2 px-1 rounded">backend/.env</code> e reinicie o servidor.{' '}
          Conta gratuita em{' '}
          <span className="text-text-primary font-medium">tradier.com</span>.
        </p>
      </motion.section>
    )
  }

  if (chartData.length === 0) {
    return (
      <motion.section
        className="card mt-4"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-display font-bold text-text-primary tracking-wide">
            Gamma Exposure (GEX)
          </span>
        </div>
        <p className="text-xs text-text-secondary">Sem dados próximos ao ATM.</p>
      </motion.section>
    )
  }

  const isPositive = gex.regime === 'positive'
  const regimeColor = isPositive ? 'text-[#00ff88]' : 'text-red-400'
  const regimeLabel = isPositive ? 'POSITIVO' : 'NEGATIVO'
  const regimeDesc = isPositive
    ? 'MMs suprimem volatilidade'
    : 'MMs amplificam volatilidade'

  const currentPriceStrike = spyLast != null ? Math.round(spyLast) : null

  return (
    <motion.section
      className="card mt-4"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-display font-bold text-text-primary tracking-wide">
            Gamma Exposure (GEX)
          </span>
          <span className={`text-[10px] font-semibold tracking-widest uppercase ${regimeColor}`}>
            {regimeLabel}
          </span>
        </div>
        <span className="text-[10px] text-text-muted">
          {new Date(gex.calculatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {/* Key metrics */}
      <div className="grid grid-cols-4 gap-3 mb-4 text-center">
        <div>
          <div className="text-[10px] text-text-muted uppercase tracking-wider">GEX Total</div>
          <div className={`text-sm font-bold font-num ${regimeColor}`}>
            {gex.totalGEX >= 0 ? '+' : ''}{fmtM(gex.totalGEX)}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-text-muted uppercase tracking-wider">Flip Point</div>
          <div className="text-sm font-bold font-num text-text-primary">
            {gex.flipPoint ?? '—'}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-text-muted uppercase tracking-wider">Max Gamma</div>
          <div className="text-sm font-bold font-num text-text-primary">
            {gex.maxGammaStrike}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-text-muted uppercase tracking-wider">Regime</div>
          <div className={`text-[10px] font-semibold ${regimeColor}`}>
            {regimeDesc}
          </div>
        </div>
      </div>

      {/* Recharts bar chart */}
      <div className="border-t border-border-subtle pt-3" style={{ height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            barGap={1}
            barCategoryGap="20%"
            margin={{ top: 28, right: 12, left: 0, bottom: 4 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="rgba(255,255,255,0.04)"
              vertical={false}
            />
            <XAxis
              dataKey="strike"
              tick={{ fill: '#8888aa', fontSize: 9 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: '#8888aa', fontSize: 9 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `$${v}M`}
              width={44}
            />
            <Tooltip
              content={<GEXCustomTooltip />}
              cursor={{ fill: 'rgba(255,255,255,0.03)' }}
            />

            {/* Call bars — green */}
            <Bar
              dataKey="callGex"
              name="Call GEX"
              fill="#00ff88"
              fillOpacity={0.75}
              maxBarSize={18}
              isAnimationActive={false}
            >
              <LabelList
                dataKey="callGex"
                position="top"
                formatter={(v: number) => (v > 0.5 ? `$${v.toFixed(1)}` : '')}
                fill="#00ff88"
                fontSize={7}
              />
            </Bar>

            {/* Put bars — red */}
            <Bar
              dataKey="putGex"
              name="Put GEX"
              fill="#ff4444"
              fillOpacity={0.65}
              maxBarSize={18}
              isAnimationActive={false}
            >
              <LabelList
                dataKey="putGex"
                position="top"
                formatter={(v: number) => (v > 0.5 ? `$${v.toFixed(1)}` : '')}
                fill="#ff7777"
                fontSize={7}
              />
            </Bar>

            {/* Current price */}
            {currentPriceStrike != null && (
              <ReferenceLine
                x={currentPriceStrike}
                stroke="#ffffff"
                strokeWidth={1.5}
                strokeDasharray="4 2"
                label={{
                  value: `Preço $${spyLast!.toFixed(0)}`,
                  position: 'insideTopRight',
                  fill: '#ffffff',
                  fontSize: 9,
                }}
              />
            )}

            {/* Flip Point */}
            {gex.flipPoint != null && (
              <ReferenceLine
                x={gex.flipPoint}
                stroke="#ffcc00"
                strokeWidth={1}
                strokeDasharray="4 2"
                label={{
                  value: `Flip ${gex.flipPoint}`,
                  position: 'insideTopLeft',
                  fill: '#ffcc00',
                  fontSize: 9,
                }}
              />
            )}

            {/* Put Wall */}
            <ReferenceLine
              x={gex.putWall}
              stroke="#cc44ff"
              strokeWidth={1}
              strokeDasharray="4 2"
              label={{
                value: `Put Wall ${gex.putWall}`,
                position: 'insideTopLeft',
                fill: '#cc44ff',
                fontSize: 9,
              }}
            />

            {/* Call Wall */}
            <ReferenceLine
              x={gex.callWall}
              stroke="#4488ff"
              strokeWidth={1}
              strokeDasharray="4 2"
              label={{
                value: `Call Wall ${gex.callWall}`,
                position: 'insideTopRight',
                fill: '#4488ff',
                fontSize: 9,
              }}
            />

            {/* Max Gamma Strike */}
            <ReferenceLine
              x={gex.maxGammaStrike}
              stroke="#00ffcc"
              strokeWidth={1}
              strokeDasharray="3 3"
              label={{
                value: `Max γ ${gex.maxGammaStrike}`,
                position: 'insideTopRight',
                fill: '#00ffcc',
                fontSize: 9,
              }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Legend for reference lines */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
        {REFERENCE_LINES.map(({ color, label }) => (
          <span key={label} className="flex items-center gap-1 text-[9px] text-text-muted">
            <span
              className="inline-block w-4 border-t border-dashed"
              style={{ borderColor: color }}
            />
            {label}
          </span>
        ))}
      </div>
    </motion.section>
  )
})

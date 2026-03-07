import { useState } from 'react'
import { useMarketStore } from '../../store/marketStore'
import type { AnalysisStructuredOutput, NoTradeData, DANData } from '../../store/marketStore'

// ---------------------------------------------------------------------------
// Regime Score Gauge (semicircle SVG, adapted from FearGreedGauge)
// ---------------------------------------------------------------------------

function getScoreZone(score: number): { color: string; label: string } {
  if (score >= 7) return { color: '#00ff88', label: 'Favorável' }
  if (score >= 5) return { color: '#ffcc00', label: 'Neutro' }
  return { color: '#ff4444', label: 'Desfavorável' }
}

function RegimeGaugeSVG({ score }: { score: number }) {
  const zone = getScoreZone(score)
  const cx = 60
  const cy = 60
  const r = 48
  const strokeWidth = 10
  const circumference = Math.PI * r

  const bgPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`
  const fillRatio = score / 10
  const fillLength = fillRatio * circumference

  const angle = Math.PI * fillRatio
  const nx = cx - r * Math.cos(angle)
  const ny = cy - r * Math.sin(angle)

  return (
    <svg width="120" height="66" viewBox="0 0 120 66" className="overflow-visible">
      <path
        d={bgPath}
        fill="none"
        stroke="rgba(255,255,255,0.06)"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <path
        d={bgPath}
        fill="none"
        stroke={zone.color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={`${fillLength} ${circumference}`}
        style={{ filter: `drop-shadow(0 0 4px ${zone.color}60)` }}
      />
      <circle
        cx={nx}
        cy={ny}
        r={5}
        fill={zone.color}
        style={{ filter: `drop-shadow(0 0 3px ${zone.color})` }}
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

const VANNA_COLORS: Record<string, string> = {
  tailwind: '#00ff88',
  neutral: '#888888',
  headwind: '#ff4444',
}

const CHARM_COLORS: Record<string, string> = {
  significant: '#ffcc00',
  moderate: '#4488ff',
  neutral: '#888888',
}

const GEX_COLORS: Record<string, string> = {
  stronger_positive: '#00ff88',
  weaker_positive: '#88dd88',
  unchanged: '#888888',
  weaker_negative: '#ff8800',
  stronger_negative: '#ff4444',
}

const GEX_LABELS: Record<string, string> = {
  stronger_positive: 'GEX+ forte',
  weaker_positive: 'GEX+ fraco',
  unchanged: 'GEX sem mudança',
  weaker_negative: 'GEX− fraco',
  stronger_negative: 'GEX− forte',
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="text-[10px] font-semibold px-2 py-0.5 rounded"
      style={{ color, background: `${color}20`, border: `1px solid ${color}40` }}
    >
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Price Distribution Bar
// ---------------------------------------------------------------------------

function PriceDistributionBar({
  dist,
  spyLast,
}: {
  dist: NonNullable<AnalysisStructuredOutput['price_distribution']>
  spyLast: number | null
}) {
  const { p10, p25, p50, p75, p90, expected_range_1sigma } = dist
  const range = p90 - p10
  if (range <= 0) return null

  const toPercent = (v: number) => `${Math.max(0, Math.min(100, ((v - p10) / range) * 100)).toFixed(1)}%`

  const spyClamped = spyLast !== null
    ? Math.max(p10, Math.min(p90, spyLast))
    : null

  return (
    <div className="mt-3">
      <div className="text-[10px] text-text-muted mb-1 flex justify-between">
        <span>Distribuição de Preços (~21D)</span>
        <span className="font-mono text-[9px]">1σ: {expected_range_1sigma}</span>
      </div>

      {/* Bar */}
      <div className="relative h-4 rounded bg-white/5 overflow-hidden">
        {/* p25–p75 fill */}
        <div
          className="absolute top-0 bottom-0 bg-white/10 rounded"
          style={{ left: toPercent(p25), width: `${((p75 - p25) / range) * 100}%` }}
        />
        {/* p50 line */}
        <div
          className="absolute top-0 bottom-0 w-px bg-white/50"
          style={{ left: toPercent(p50) }}
        />
        {/* SPY last marker */}
        {spyClamped !== null && (
          <div
            className="absolute top-0 bottom-0 w-0.5 rounded"
            style={{
              left: toPercent(spyClamped),
              background: '#ffcc00',
              boxShadow: '0 0 4px #ffcc00',
            }}
          />
        )}
      </div>

      {/* Labels */}
      <div className="relative h-4 mt-0.5">
        {[
          { v: p10, label: `$${p10}` },
          { v: p25, label: `$${p25}` },
          { v: p50, label: `$${p50}` },
          { v: p75, label: `$${p75}` },
          { v: p90, label: `$${p90}` },
        ].map(({ v, label }) => (
          <span
            key={v}
            className="absolute text-[9px] text-text-muted -translate-x-1/2"
            style={{ left: toPercent(v) }}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DAN Badge
// ---------------------------------------------------------------------------

const DAN_BIAS_COLORS: Record<DANData['danBias'], string> = {
  call_dominated: '#00ff88',
  put_dominated:  '#ff4444',
  neutral:        '#888888',
}

const DAN_BIAS_LABELS: Record<DANData['danBias'], string> = {
  call_dominated: 'DAN Calls',
  put_dominated:  'DAN Puts',
  neutral:        'DAN Neutro',
}

function DANBadge({ dan }: { dan: DANData }) {
  const color = DAN_BIAS_COLORS[dan.danBias]
  const label = DAN_BIAS_LABELS[dan.danBias]
  const netSign = dan.netDAN >= 0 ? '+' : ''

  return (
    <span
      className="text-[10px] font-semibold px-2 py-0.5 rounded"
      style={{ color, background: `${color}20`, border: `1px solid ${color}40` }}
      title={`Call DAN: +$${dan.callDAN.toFixed(1)}M | Put DAN: $${dan.putDAN.toFixed(1)}M`}
    >
      {label} {netSign}${Math.abs(dan.netDAN).toFixed(0)}M
    </span>
  )
}

// ---------------------------------------------------------------------------
// NoTrade Semaphore
// ---------------------------------------------------------------------------

const NO_TRADE_COLORS: Record<NoTradeData['noTradeLevel'], string> = {
  clear: '#00ff88',
  caution: '#ffcc00',
  avoid: '#ff4444',
}

const NO_TRADE_LABELS: Record<NoTradeData['noTradeLevel'], string> = {
  clear: 'Operável',
  caution: 'Cautela',
  avoid: 'Não Operar',
}

function NoTradeSignal({ noTrade }: { noTrade: NoTradeData }) {
  const [expanded, setExpanded] = useState(false)
  const color = NO_TRADE_COLORS[noTrade.noTradeLevel]
  const label = NO_TRADE_LABELS[noTrade.noTradeLevel]

  return (
    <div
      className="rounded-lg p-2.5 cursor-pointer select-none"
      style={{ background: `${color}10`, border: `1px solid ${color}30` }}
      onClick={() => noTrade.activeVetos.length > 0 && setExpanded((v) => !v)}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Semaphore dot */}
          <div
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ background: color, boxShadow: `0 0 6px ${color}` }}
          />
          <span className="text-[11px] font-semibold" style={{ color }}>
            {label}
          </span>
          {noTrade.activeVetos.length > 0 && (
            <span className="text-[10px] text-text-muted">
              ({noTrade.activeVetos.length} veto{noTrade.activeVetos.length > 1 ? 's' : ''})
            </span>
          )}
        </div>
        {noTrade.activeVetos.length > 0 && (
          <span className="text-[10px] text-text-muted">{expanded ? '▲' : '▼'}</span>
        )}
      </div>

      {expanded && noTrade.activeVetos.length > 0 && (
        <ul className="mt-2 space-y-1">
          {noTrade.activeVetos.map((v, i) => (
            <li key={i} className="text-[10px] text-text-muted flex gap-1.5">
              <span style={{ color }}>•</span>
              <span>{v}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main card
// ---------------------------------------------------------------------------

export function RegimeDashboard() {
  const output = useMarketStore((s) => s.lastAnalysisOutput)
  const spyLast = useMarketStore((s) => s.spy.last)
  const noTrade = useMarketStore((s) => s.noTrade)
  const dan = useMarketStore((s) => s.dan)

  if (!output) return null

  const {
    regime_score,
    vanna_regime,
    charm_pressure,
    price_distribution,
    gex_vs_yesterday,
  } = output

  const zone = getScoreZone(regime_score)

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">
        Regime Dashboard
      </div>

      <div className="flex items-start gap-4">
        {/* Gauge */}
        <div className="flex flex-col items-center shrink-0">
          <RegimeGaugeSVG score={regime_score} />
          <div className="text-xl font-num font-bold -mt-1" style={{ color: zone.color }}>
            {regime_score}/10
          </div>
          <div className="text-[10px]" style={{ color: zone.color }}>
            {zone.label}
          </div>
        </div>

        {/* Badges grid */}
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {vanna_regime && (
              <Badge
                label={`Vanna: ${vanna_regime}`}
                color={VANNA_COLORS[vanna_regime] ?? '#888'}
              />
            )}
            {charm_pressure && (
              <Badge
                label={`Charm: ${charm_pressure}`}
                color={CHARM_COLORS[charm_pressure] ?? '#888'}
              />
            )}
            {gex_vs_yesterday && (
              <Badge
                label={GEX_LABELS[gex_vs_yesterday] ?? gex_vs_yesterday}
                color={GEX_COLORS[gex_vs_yesterday] ?? '#888'}
              />
            )}
            {dan && <DANBadge dan={dan} />}
          </div>

          {/* Score scale legend */}
          <div className="flex gap-3 text-[9px]">
            <span style={{ color: '#ff4444' }}>0–4 avoid</span>
            <span style={{ color: '#ffcc00' }}>5–6 wait</span>
            <span style={{ color: '#00ff88' }}>7–10 trade</span>
          </div>
        </div>
      </div>

      {/* NoTrade semaphore */}
      {noTrade && (
        <NoTradeSignal noTrade={noTrade} />
      )}

      {/* Price distribution bar */}
      {price_distribution && (
        <PriceDistributionBar dist={price_distribution} spyLast={spyLast} />
      )}
    </div>
  )
}

import { useState } from 'react'
import { useMarketStore } from '../../store/marketStore'
import type { AnalysisStructuredOutput, NoTradeData, DANData } from '../../store/marketStore'

// ---------------------------------------------------------------------------
// Zone helpers
// ---------------------------------------------------------------------------

function getScoreZone(score: number): { color: string; label: string } {
  if (score >= 7) return { color: '#00ff88', label: 'Favorável' }
  if (score >= 5) return { color: '#ffcc00', label: 'Neutro' }
  return { color: '#ff4444', label: 'Desfavorável' }
}

// ---------------------------------------------------------------------------
// Translations
// ---------------------------------------------------------------------------

const VANNA_LABELS: Record<string, string> = {
  tailwind: 'Impulso',
  neutral:  'Neutro',
  headwind: 'Resistência',
}

const VANNA_COLORS: Record<string, string> = {
  tailwind: '#00ff88',
  neutral:  '#888888',
  headwind: '#ff4444',
}

const CHARM_LABELS: Record<string, string> = {
  significant: 'Intensa',
  moderate:    'Moderada',
  neutral:     'Neutra',
}

const CHARM_COLORS: Record<string, string> = {
  significant: '#ffcc00',
  moderate:    '#4488ff',
  neutral:     '#888888',
}

const GEX_COLORS: Record<string, string> = {
  stronger_positive: '#00ff88',
  weaker_positive:   '#88dd88',
  unchanged:         '#888888',
  weaker_negative:   '#ff8800',
  stronger_negative: '#ff4444',
}

const GEX_LABELS: Record<string, string> = {
  stronger_positive: 'GEX+ forte',
  weaker_positive:   'GEX+ fraco',
  unchanged:         'GEX sem mudança',
  weaker_negative:   'GEX: fraco',
  stronger_negative: 'GEX: forte',
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

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
// Regime Score Block (replaces semicircle gauge — distinct from FearGreedGauge)
// ---------------------------------------------------------------------------

interface RegimeScoreBlockProps {
  score: number
  vannaRegime: 'tailwind' | 'neutral' | 'headwind'
  charmPressure: 'significant' | 'moderate' | 'neutral'
  gexVsYesterday: string | null
}

function RegimeScoreBlock({ score, vannaRegime, charmPressure, gexVsYesterday }: RegimeScoreBlockProps) {
  const zone = getScoreZone(score)
  const cursorPct = (score / 10) * 100

  return (
    <div className="flex items-start gap-4">
      {/* Large score number */}
      <div className="shrink-0 flex flex-col items-center pt-0.5 min-w-[2.5rem]">
        <div className="text-4xl font-bold font-num leading-none" style={{ color: zone.color }}>
          {score}
        </div>
        <div className="text-[11px] text-text-muted font-num mt-0.5">/10</div>
      </div>

      {/* Zone bar + badges */}
      <div className="flex-1 min-w-0 space-y-2">
        {/* Zone label */}
        <div className="text-[13px] font-semibold leading-none" style={{ color: zone.color }}>
          {zone.label}
        </div>

        {/* Horizontal zone bar with cursor */}
        <div className="relative py-1.5">
          <div className="flex h-1.5 rounded-full overflow-hidden">
            <div className="w-[40%] rounded-l-full" style={{ background: '#ff444428' }} />
            <div className="w-[20%]" style={{ background: '#ffcc0028' }} />
            <div className="flex-1 rounded-r-full" style={{ background: '#00ff8828' }} />
          </div>
          {/* Cursor dot */}
          <div
            className="absolute top-1/2 w-3 h-3 rounded-full border-2 pointer-events-none"
            style={{
              left: `${cursorPct}%`,
              transform: 'translate(-50%, -50%)',
              background: zone.color,
              borderColor: 'var(--color-bg-base, #0d0d0d)',
              boxShadow: `0 0 6px ${zone.color}80`,
            }}
          />
        </div>

        {/* Zone scale legend (translated) */}
        <div className="flex justify-between text-[9px] -mt-1">
          <span style={{ color: '#ff4444' }}>0–4 evitar</span>
          <span style={{ color: '#ffcc00' }}>5–6 aguardar</span>
          <span style={{ color: '#00ff88' }}>7–10 operar</span>
        </div>

        {/* Regime badges */}
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {vannaRegime && (
            <Badge
              label={`Vanna: ${VANNA_LABELS[vannaRegime] ?? vannaRegime}`}
              color={VANNA_COLORS[vannaRegime] ?? '#888'}
            />
          )}
          {charmPressure && (
            <Badge
              label={`Charm: ${CHARM_LABELS[charmPressure] ?? charmPressure}`}
              color={CHARM_COLORS[charmPressure] ?? '#888'}
            />
          )}
          {gexVsYesterday && (
            <Badge
              label={GEX_LABELS[gexVsYesterday] ?? gexVsYesterday}
              color={GEX_COLORS[gexVsYesterday] ?? '#888'}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Price Distribution Bar (fixed edge label clipping)
// ---------------------------------------------------------------------------

type PriceDistShape = NonNullable<AnalysisStructuredOutput['price_distribution']>

function PriceDistributionBar({
  dist,
  spyLast,
}: {
  dist: PriceDistShape
  spyLast: number | null
}) {
  const { p10, p25, p50, p75, p90, expected_range_1sigma } = dist
  const range = p90 - p10
  if (range <= 0) return null

  const rawPct  = (v: number) => ((v - p10) / range) * 100
  const toPercent = (v: number) => `${Math.max(0, Math.min(100, rawPct(v))).toFixed(1)}%`

  // Adaptive transform to prevent edge labels from clipping outside the card
  const getLabelTransform = (v: number): string => {
    const pct = rawPct(v)
    if (pct <= 5)  return 'translateX(0)'
    if (pct >= 95) return 'translateX(-100%)'
    return 'translateX(-50%)'
  }

  const spyClamped = spyLast !== null
    ? Math.max(p10, Math.min(p90, spyLast))
    : null

  return (
    <div className="border-t border-border-subtle pt-3">
      <div className="text-[10px] text-text-muted mb-2 flex justify-between">
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
        {/* p50 median line */}
        <div
          className="absolute top-0 bottom-0 w-px bg-white/40"
          style={{ left: toPercent(p50) }}
        />
        {/* SPY live marker */}
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

      {/* Price labels — edge-aware transform to prevent overflow */}
      <div className="relative h-4 mt-0.5">
        {[
          { v: p10 },
          { v: p25 },
          { v: p50 },
          { v: p75 },
          { v: p90 },
        ].map(({ v }) => (
          <span
            key={v}
            className="absolute text-[9px] text-text-muted"
            style={{
              left: toPercent(v),
              transform: getLabelTransform(v),
            }}
          >
            ${v}
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
  clear:   '#00ff88',
  caution: '#ffcc00',
  avoid:   '#ff4444',
}

const NO_TRADE_LABELS: Record<NoTradeData['noTradeLevel'], string> = {
  clear:   'Operável',
  caution: 'Cautela',
  avoid:   'Não Operar',
}

function NoTradeSignal({ noTrade, marketClosed }: { noTrade: NoTradeData; marketClosed: boolean }) {
  const [expanded, setExpanded] = useState(false)

  const color = marketClosed ? '#555555' : NO_TRADE_COLORS[noTrade.noTradeLevel]
  const label = marketClosed ? 'Fora do horário' : NO_TRADE_LABELS[noTrade.noTradeLevel]
  const canExpand = !marketClosed && noTrade.activeVetos.length > 0

  return (
    <div
      className={`rounded-lg px-2.5 py-2 ${canExpand ? 'cursor-pointer select-none' : ''}`}
      style={{ background: `${color}10`, border: `1px solid ${color}25` }}
      onClick={() => canExpand && setExpanded((v) => !v)}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="w-2 h-2 rounded-full shrink-0"
            style={{
              background: color,
              boxShadow: marketClosed ? 'none' : `0 0 5px ${color}`,
            }}
          />
          <span className="text-[11px] font-semibold truncate" style={{ color }}>
            {label}
          </span>
          {canExpand && (
            <span className="text-[10px] text-text-muted shrink-0">
              ({noTrade.activeVetos.length})
            </span>
          )}
        </div>
        {canExpand && (
          <span className="text-[10px] text-text-muted shrink-0">{expanded ? '▲' : '▼'}</span>
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
  const output       = useMarketStore((s) => s.lastAnalysisOutput)
  const spyLast      = useMarketStore((s) => s.spy.last)
  const noTrade      = useMarketStore((s) => s.noTrade)
  const dan          = useMarketStore((s) => s.dan)
  const regimePreview = useMarketStore((s) => s.regimePreview)
  const marketOpen   = useMarketStore((s) => s.marketOpen)

  if (!output && !noTrade && !dan && !regimePreview) return null

  // AI analysis takes priority; preview fills in before first analysis
  const gaugeSource: 'analysis' | 'preview' | null =
    output ? 'analysis' : regimePreview ? 'preview' : null

  const marketClosed = marketOpen === false

  // Single consolidated status indicator in header — no redundancy
  const statusIndicator = (() => {
    if (marketOpen === null) return null
    if (marketClosed)        return { label: 'Fechado',         color: '#555555', pulse: false }
    if (gaugeSource === 'preview') return { label: 'Ao Vivo',   color: '#00ff88', pulse: true  }
    return                         { label: 'Última análise',   color: '#666666', pulse: false }
  })()

  // Price distribution: AI analysis takes priority, fall back to live preview
  const dist = output?.price_distribution ?? regimePreview?.priceDistribution ?? null

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">
          Regime
        </div>
        {statusIndicator && (
          <div className="flex items-center gap-1.5 text-[10px]" style={{ color: statusIndicator.color }}>
            <div
              className={`w-1.5 h-1.5 rounded-full shrink-0${statusIndicator.pulse ? ' animate-pulse' : ''}`}
              style={{ background: statusIndicator.color }}
            />
            {statusIndicator.label}
          </div>
        )}
      </div>

      {/* ── Score block ── */}
      {gaugeSource === 'analysis' && output && (
        <RegimeScoreBlock
          score={output.regime_score}
          vannaRegime={output.vanna_regime}
          charmPressure={output.charm_pressure}
          gexVsYesterday={output.gex_vs_yesterday ?? null}
        />
      )}
      {gaugeSource === 'preview' && regimePreview && (
        <RegimeScoreBlock
          score={regimePreview.score}
          vannaRegime={regimePreview.vannaRegime}
          charmPressure={regimePreview.charmPressure}
          gexVsYesterday={regimePreview.gexVsYesterday ?? null}
        />
      )}

      {/* ── DAN + NoTrade row — side by side on desktop, stacked on mobile ── */}
      {(dan || noTrade) && (
        <div className="border-t border-border-subtle pt-3 flex flex-col sm:flex-row sm:items-start gap-2">
          {dan && (
            <div className="shrink-0">
              <DANBadge dan={dan} />
            </div>
          )}
          {noTrade && (
            <div className="flex-1 min-w-0">
              <NoTradeSignal noTrade={noTrade} marketClosed={marketClosed} />
            </div>
          )}
        </div>
      )}

      {/* ── Price distribution ── */}
      {dist && <PriceDistributionBar dist={dist} spyLast={spyLast} />}
    </div>
  )
}

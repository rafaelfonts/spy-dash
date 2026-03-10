import { memo } from 'react'
import { motion } from 'framer-motion'
import { useMarketStore } from '../../store/marketStore'
import { Skeleton } from '../ui/Skeleton'

// ── RSI config ───────────────────────────────────────────────────────────────

function rsiConfig(rsi: number): { label: string; color: string; dot: string } {
  if (rsi < 30) return { label: 'SOBREVENDIDO', color: 'text-[#00ff88] border-[#00ff88]/30 bg-[#00ff88]/5', dot: 'bg-[#00ff88]' }
  if (rsi > 70) return { label: 'SOBRECOMPRADO', color: 'text-red-400 border-red-400/30 bg-red-500/5', dot: 'bg-red-400' }
  return { label: 'NEUTRO', color: 'text-yellow-400 border-yellow-400/30 bg-yellow-500/5', dot: 'bg-yellow-400' }
}

// ── MACD crossover config ────────────────────────────────────────────────────

const CROSSOVER_CONFIG = {
  bullish: { icon: '▲', label: 'BULLISH', color: 'text-[#00ff88] border-[#00ff88]/30 bg-[#00ff88]/5' },
  bearish: { icon: '▼', label: 'BEARISH', color: 'text-red-400 border-red-400/30 bg-red-500/5' },
  none:    { icon: '—', label: 'NEUTRO',  color: 'text-text-muted border-border-subtle bg-transparent' },
}

// ── BB position config ───────────────────────────────────────────────────────

const BB_CONFIG: Record<string, { label: string; color: string }> = {
  above_upper: { label: 'ACIMA SUP',   color: 'text-red-400 border-red-400/30 bg-red-500/5' },
  near_upper:  { label: 'PRÓX. SUP',   color: 'text-orange-400 border-orange-400/30 bg-orange-500/5' },
  middle:      { label: 'CENTRAL',     color: 'text-yellow-400 border-yellow-400/30 bg-yellow-500/5' },
  near_lower:  { label: 'PRÓX. INF',   color: 'text-blue-400 border-blue-400/30 bg-blue-500/5' },
  below_lower: { label: 'ABAIXO INF',  color: 'text-[#00ff88] border-[#00ff88]/30 bg-[#00ff88]/5' },
}

// ── IV Cone label config ─────────────────────────────────────────────────────

const CONE_CONFIG = {
  rich:  { label: 'IV CARA',   color: 'text-red-400 border-red-400/30 bg-red-500/5' },
  fair:  { label: 'IV JUSTA',  color: 'text-[#00ff88] border-[#00ff88]/30 bg-[#00ff88]/5' },
  cheap: { label: 'IV BARATA', color: 'text-blue-400 border-blue-400/30 bg-blue-500/5' },
}

// ── Staleness helper ─────────────────────────────────────────────────────────

function isDataStale(capturedAt: string, maxAgeMs = 10 * 60 * 1000): boolean {
  return Date.now() - new Date(capturedAt).getTime() > maxAgeMs
}

// ── Metric row helper ────────────────────────────────────────────────────────

function MetricRow({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className={`text-[10px] ${muted ? 'text-text-muted' : 'text-text-secondary'}`}>{label}</span>
      <span className={`text-[11px] font-num font-medium ${muted ? 'text-text-muted' : 'text-text-primary'}`}>{value}</span>
    </div>
  )
}

// ── Component ────────────────────────────────────────────────────────────────

export const TechnicalIndicatorsCard = memo(function TechnicalIndicatorsCard() {
  const ti = useMarketStore((s) => s.technicalIndicators)

  const isLoaded = ti !== null
  const dataStatus = ti?.dataStatus ?? 'ok'
  const isWaiting = dataStatus === 'waiting'
  const isOk = isLoaded && !isWaiting
  const stale = isOk && isDataStale(ti!.capturedAt)

  const rsi = isOk ? rsiConfig(ti!.rsi14) : null
  const crossover = isOk ? CROSSOVER_CONFIG[ti!.macd.crossover] : null
  const bbPos = isOk ? (BB_CONFIG[ti!.bbands.position] ?? BB_CONFIG.middle) : null
  const bbFlat = isOk && ti!.bbands.upper === ti!.bbands.lower

  // BB %B clamped to [0,1] range for bar display; raw value may go outside
  const bbPercentB = isOk ? (ti!.bbPercentB ?? null) : null
  const bbBandwidth = isOk ? (ti!.bbBandwidth ?? null) : null
  const bbBarPct = bbPercentB != null ? Math.min(Math.max(bbPercentB * 100, 2), 98) : 50

  const ivCone = isOk ? (ti!.ivCone ?? null) : null
  const coneConf = ivCone?.coneLabel ? CONE_CONFIG[ivCone.coneLabel] : null

  return (
    <motion.section
      className="card"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm font-display font-bold text-text-primary tracking-wide">
          Indicadores Técnicos
        </span>
        <div className="flex items-center gap-2">
          {stale && (
            <span className="text-[10px] font-semibold text-orange-400 border border-orange-400/30 bg-orange-500/5 px-1.5 py-0.5 rounded">
              ⚠ dados &gt;10min
            </span>
          )}
          {isWaiting && isLoaded && (
            <span className="text-[10px] font-semibold text-yellow-400 border border-yellow-400/30 bg-yellow-500/5 px-1.5 py-0.5 rounded">
              ⚠ {ti!.barsAvailable ?? 0}/35 barras
            </span>
          )}
          <span className="text-[10px] text-text-muted">
            {isLoaded
              ? new Date(ti!.capturedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET'
              : '—'}
          </span>
        </div>
      </div>

      {/* 3-column grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-0 divide-y sm:divide-y-0 sm:divide-x divide-border-subtle">

        {/* ── RSI (14) ─────────────────────────────────────────── */}
        <div className="pb-4 sm:pb-0 sm:pr-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">RSI (14)</span>
            {isOk
              ? <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border tracking-wider ${rsi!.color}`}>{rsi!.label}</span>
              : <Skeleton className="w-20" height="0.65rem" />}
          </div>

          {isOk ? (
            <>
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-3xl font-bold font-num text-text-primary leading-none">{ti!.rsi14.toFixed(1)}</span>
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${rsi!.dot}`} />
              </div>
              <div className="space-y-0">
                <MetricRow label="Sobrecomprado" value="> 70" muted />
                <MetricRow label="Sobrevendido" value="< 30" muted />
              </div>
            </>
          ) : (
            <Skeleton className="w-full h-16" />
          )}
        </div>

        {/* ── MACD (12,26,9) ────────────────────────────────────── */}
        <div className="py-4 sm:py-0 sm:px-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">MACD (12,26,9)</span>
            {isOk && crossover
              ? <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border tracking-wider ${crossover.color}`}>{crossover.icon} {crossover.label}</span>
              : <Skeleton className="w-20" height="0.65rem" />}
          </div>

          {isOk ? (
            <>
              <div className="flex items-baseline gap-1.5 mb-2">
                <span className="text-[10px] text-text-muted">Hist</span>
                <span className={`text-3xl font-bold font-num leading-none ${ti!.macd.histogram >= 0 ? 'text-[#00ff88]' : 'text-red-400'}`}>
                  {ti!.macd.histogram >= 0 ? '+' : ''}{ti!.macd.histogram.toFixed(3)}
                </span>
              </div>
              <div className="space-y-0">
                <MetricRow label="MACD" value={ti!.macd.macd.toFixed(3)} />
                <MetricRow label="Signal" value={ti!.macd.signal.toFixed(3)} />
              </div>
            </>
          ) : (
            <Skeleton className="w-full h-16" />
          )}
        </div>

        {/* ── Bollinger Bands (20, 2σ) ──────────────────────────── */}
        <div className="pt-4 sm:pt-0 sm:pl-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">BB (20, 2σ)</span>
            {isOk && bbPos
              ? <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border tracking-wider ${bbPos.color}`}>{bbPos.label}</span>
              : <Skeleton className="w-20" height="0.65rem" />}
          </div>

          {isOk ? (
            <>
              <div className="flex items-baseline gap-3 mb-2">
                <div>
                  <span className="text-[9px] text-text-muted mr-1">%B</span>
                  <span className="text-3xl font-bold font-num text-text-primary leading-none">
                    {bbFlat ? '—' : bbPercentB != null ? bbPercentB.toFixed(2) : '—'}
                  </span>
                </div>
                {!bbFlat && bbBandwidth != null && (
                  <div className="flex flex-col items-start">
                    <span className="text-[9px] text-text-muted">BW</span>
                    <span className="text-[13px] font-num font-semibold text-text-secondary">{bbBandwidth.toFixed(2)}%</span>
                  </div>
                )}
              </div>
              <div className="space-y-0">
                <MetricRow label="Sup" value={bbFlat ? '—' : `$${ti!.bbands.upper.toFixed(2)}`} />
                <MetricRow label="Mid" value={`$${ti!.bbands.middle.toFixed(2)}`} />
                <MetricRow label="Inf" value={bbFlat ? '—' : `$${ti!.bbands.lower.toFixed(2)}`} />
              </div>
              {/* Barra de posição %B exata */}
              {!bbFlat && (
                <div className="mt-2">
                  <div className="h-1 rounded-full overflow-hidden bg-bg-elevated relative">
                    <div className="absolute inset-0 bg-gradient-to-r from-[#00ff88] via-yellow-400 to-red-400 opacity-30 rounded-full" />
                    <motion.div
                      className="absolute top-0 bottom-0 w-0.5 bg-white rounded-full shadow-sm"
                      initial={{ left: '50%' }}
                      animate={{ left: `${bbBarPct}%` }}
                      transition={{ duration: 0.6, ease: 'easeOut' }}
                    />
                  </div>
                  <div className="flex justify-between mt-0.5 text-[9px] text-text-muted">
                    <span>Inf (0)</span>
                    <span>Sup (1)</span>
                  </div>
                </div>
              )}
            </>
          ) : (
            <Skeleton className="w-full h-16" />
          )}
        </div>
      </div>

      {/* ── IV Cone row ───────────────────────────────────────────── */}
      {isOk && ivCone && (
        <div className="mt-4 pt-3 border-t border-border-subtle">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Cone IV</span>
              {ivCone.ivx != null && (
                <span className="text-[11px] font-num text-text-primary font-semibold">IVx {ivCone.ivx.toFixed(1)}%</span>
              )}
              {ivCone.hv10 != null && (
                <span className="text-[10px] font-num text-text-muted">HV10 {ivCone.hv10.toFixed(1)}%</span>
              )}
              {ivCone.hv20 != null && (
                <span className="text-[10px] font-num text-text-muted">HV20 {ivCone.hv20.toFixed(1)}%</span>
              )}
              {ivCone.hv30 != null && (
                <span className="text-[10px] font-num text-text-muted">HV30 {ivCone.hv30.toFixed(1)}%</span>
              )}
              {ivCone.ivVsHv30 != null && (
                <span className="text-[10px] text-text-muted font-num">{ivCone.ivVsHv30.toFixed(2)}×HV30</span>
              )}
            </div>
            {coneConf && (
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border tracking-wider flex-shrink-0 ${coneConf.color}`}>
                {coneConf.label}
              </span>
            )}
          </div>
        </div>
      )}

      {!isLoaded && (
        <p className="text-[10px] text-text-muted mt-3 text-center">
          Aguardando ≥35 barras de preço para calcular indicadores…
        </p>
      )}
    </motion.section>
  )
})

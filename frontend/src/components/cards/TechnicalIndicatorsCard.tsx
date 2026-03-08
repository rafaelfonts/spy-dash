import { memo } from 'react'
import { motion } from 'framer-motion'
import { useMarketStore } from '../../store/marketStore'
import { Skeleton } from '../ui/Skeleton'

// ── RSI ─────────────────────────────────────────────────────────────────────

function rsiConfig(rsi: number): { label: string; color: string; bar: string; hex: string } {
  if (rsi < 30) return { label: 'SOBREVENDIDO', color: 'text-[#00ff88]', bar: 'bg-[#00ff88]', hex: '#00ff88' }
  if (rsi > 70) return { label: 'SOBRECOMPRADO', color: 'text-red-400', bar: 'bg-red-400', hex: '#f87171' }
  return { label: 'NEUTRO', color: 'text-yellow-400', bar: 'bg-yellow-400', hex: '#facc15' }
}

function RSIGaugeSVG({ rsi, hex }: { rsi: number; hex: string }) {
  const r = 40, cx = 50, cy = 50
  const circ = Math.PI * r
  const fill = (Math.min(rsi, 100) / 100) * circ
  const path = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`
  return (
    <svg width="100" height="56" viewBox="0 0 100 56" className="overflow-visible">
      <path d={path} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={9} strokeLinecap="round" />
      <path
        d={path}
        fill="none"
        stroke={hex}
        strokeWidth={9}
        strokeLinecap="round"
        strokeDasharray={`${fill} ${circ}`}
        style={{ filter: `drop-shadow(0 0 3px ${hex}60)` }}
      />
    </svg>
  )
}

// ── MACD crossover ───────────────────────────────────────────────────────────

const CROSSOVER_CONFIG = {
  bullish: { icon: '▲', label: 'BULLISH', color: 'text-[#00ff88] border-[#00ff88]/30 bg-[#00ff88]/5' },
  bearish: { icon: '▼', label: 'BEARISH', color: 'text-red-400 border-red-400/30 bg-red-500/5' },
  none:    { icon: '—', label: 'NEUTRO',  color: 'text-text-muted border-border-subtle bg-transparent' },
}

// ── BB position ──────────────────────────────────────────────────────────────

const BB_CONFIG: Record<string, { label: string; color: string }> = {
  above_upper: { label: 'ACIMA SUPERIOR', color: 'text-red-400 border-red-400/30 bg-red-500/5' },
  near_upper:  { label: 'PRÓX. SUPERIOR', color: 'text-orange-400 border-orange-400/30 bg-orange-500/5' },
  middle:      { label: 'CENTRAL',        color: 'text-yellow-400 border-yellow-400/30 bg-yellow-500/5' },
  near_lower:  { label: 'PRÓX. INFERIOR', color: 'text-blue-400 border-blue-400/30 bg-blue-500/5' },
  below_lower: { label: 'ABAIXO INFERIOR', color: 'text-[#00ff88] border-[#00ff88]/30 bg-[#00ff88]/5' },
}

// posição aproximada (%) da banda para barra visual
const BB_POS_PCT: Record<string, number> = {
  above_upper: 95, near_upper: 75, middle: 50, near_lower: 25, below_lower: 5,
}

// ── Staleness helper ─────────────────────────────────────────────────────────

function isDataStale(capturedAt: string, maxAgeMs = 10 * 60 * 1000): boolean {
  return Date.now() - new Date(capturedAt).getTime() > maxAgeMs
}

// ── Component ────────────────────────────────────────────────────────────────

export const TechnicalIndicatorsCard = memo(function TechnicalIndicatorsCard() {
  const ti = useMarketStore((s) => s.technicalIndicators)

  const isLoaded = ti !== null
  const dataStatus = ti?.dataStatus ?? 'ok'
  const isWaiting = dataStatus === 'waiting'
  const isOk = isLoaded && !isWaiting
  const stale = isOk && isDataStale(ti!.capturedAt)

  // Só usar valores calculados quando dataStatus === 'ok'
  const rsi = isOk ? rsiConfig(ti!.rsi14) : null
  const crossover = isOk ? CROSSOVER_CONFIG[ti!.macd.crossover] : null
  const bbPos = isOk ? (BB_CONFIG[ti!.bbands.position] ?? BB_CONFIG.middle) : null
  const bbPct = isOk ? (BB_POS_PCT[ti!.bbands.position] ?? 50) : 50

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
          {/* Stale indicator */}
          {stale && (
            <span className="text-[10px] font-semibold text-orange-400 border border-orange-400/30 bg-orange-500/5 px-1.5 py-0.5 rounded">
              ⚠ dados &gt;10min
            </span>
          )}
          {/* Waiting indicator */}
          {isWaiting && isLoaded && (
            <span className="text-[10px] font-semibold text-yellow-400 border border-yellow-400/30 bg-yellow-500/5 px-1.5 py-0.5 rounded">
              ⚠ Aguardando {ti!.barsAvailable ?? 0}/35 barras
            </span>
          )}
          <span className="text-[10px] text-text-muted">
            {isLoaded
              ? new Date(ti!.capturedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET'
              : '—'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

        {/* RSI(14) */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">RSI (14)</span>
            {isOk
              ? <span className={`text-[10px] font-bold tracking-wider ${rsi!.color}`}>{rsi!.label}</span>
              : <Skeleton className="w-20" height="0.7rem" />}
          </div>
          {/* Gauge semicircular */}
          {isOk ? (
            <div className="flex flex-col items-center mb-1">
              <RSIGaugeSVG rsi={ti!.rsi14} hex={rsi!.hex} />
              <span className="text-2xl font-bold font-num text-text-primary -mt-1">{ti!.rsi14.toFixed(1)}</span>
            </div>
          ) : (
            <Skeleton className="w-24 h-16 mx-auto" />
          )}
          {/* Zone labels */}
          <div className="flex justify-between mt-0.5 text-[9px] text-text-muted">
            <span>0</span>
            <span>30</span>
            <span>70</span>
            <span>100</span>
          </div>
        </div>

        {/* MACD — separador em mobile */}
        <div className="sm:border-l sm:border-border-subtle sm:pl-4 border-t border-border-subtle pt-4 sm:border-t-0 sm:pt-0">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">MACD</span>
            {isOk && crossover
              ? (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border tracking-wider ${crossover.color}`}>
                  {crossover.icon} {crossover.label}
                </span>
              )
              : <Skeleton className="w-20" height="0.7rem" />}
          </div>
          {/* Histogram value */}
          <div className="mb-2">
            {isOk
              ? (
                <span className={`text-2xl font-bold font-num ${ti!.macd.histogram >= 0 ? 'text-[#00ff88]' : 'text-red-400'}`}>
                  {ti!.macd.histogram >= 0 ? '+' : ''}{ti!.macd.histogram.toFixed(3)}
                </span>
              )
              : <Skeleton className="w-24 h-8" />}
          </div>
          {/* MACD vs Signal */}
          <div className="space-y-1 text-[10px]">
            <div className="flex justify-between">
              <span className="text-text-muted">MACD</span>
              {isOk
                ? <span className="font-num text-text-secondary">{ti!.macd.macd.toFixed(3)}</span>
                : <Skeleton className="w-12" height="0.7rem" />}
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Signal</span>
              {isOk
                ? <span className="font-num text-text-secondary">{ti!.macd.signal.toFixed(3)}</span>
                : <Skeleton className="w-12" height="0.7rem" />}
            </div>
          </div>
        </div>

        {/* Bollinger Bands — separador em mobile */}
        <div className="sm:border-l sm:border-border-subtle sm:pl-4 border-t border-border-subtle pt-4 sm:border-t-0 sm:pt-0">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">BB (20, 2σ)</span>
            {isOk && bbPos
              ? (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border tracking-wider ${bbPos.color}`}>
                  {bbPos.label}
                </span>
              )
              : <Skeleton className="w-24" height="0.7rem" />}
          </div>
          {/* Mid value */}
          <div className="mb-2">
            {isOk
              ? <span className="text-2xl font-bold font-num text-text-primary">${ti!.bbands.middle.toFixed(2)}</span>
              : <Skeleton className="w-24 h-8" />}
          </div>
          {/* Upper / Lower */}
          <div className="space-y-1 text-[10px]">
            <div className="flex justify-between">
              <span className="text-text-muted">Superior</span>
              {isOk
                ? <span className="font-num text-text-secondary">${ti!.bbands.upper.toFixed(2)}</span>
                : <Skeleton className="w-14" height="0.7rem" />}
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Inferior</span>
              {isOk
                ? <span className="font-num text-text-secondary">${ti!.bbands.lower.toFixed(2)}</span>
                : <Skeleton className="w-14" height="0.7rem" />}
            </div>
          </div>
          {/* Barra de posição visual */}
          {isOk && (
            <div className="mt-2">
              <div className="h-1.5 rounded-full overflow-hidden bg-bg-elevated">
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-[#00ff88] via-yellow-400 to-red-400"
                  initial={{ width: 0 }}
                  animate={{ width: `${bbPct}%` }}
                  transition={{ duration: 0.8, ease: 'easeOut' }}
                />
              </div>
              <div className="flex justify-between mt-0.5 text-[9px] text-text-muted">
                <span>Inf</span>
                <span>Sup</span>
              </div>
            </div>
          )}
        </div>

      </div>

      {!isLoaded && (
        <p className="text-[10px] text-text-muted mt-3 text-center">
          Aguardando ≥35 barras de preço para calcular indicadores…
        </p>
      )}
    </motion.section>
  )
})

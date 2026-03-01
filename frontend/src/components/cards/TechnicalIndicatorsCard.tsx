import { memo } from 'react'
import { motion } from 'framer-motion'
import { useMarketStore } from '../../store/marketStore'
import { Skeleton } from '../ui/Skeleton'

// ── RSI ─────────────────────────────────────────────────────────────────────

function rsiConfig(rsi: number): { label: string; color: string; bar: string } {
  if (rsi < 30) return { label: 'SOBREVENDIDO', color: 'text-[#00ff88]', bar: 'bg-[#00ff88]' }
  if (rsi > 70) return { label: 'SOBRECOMPRADO', color: 'text-red-400', bar: 'bg-red-400' }
  return { label: 'NEUTRO', color: 'text-yellow-400', bar: 'bg-yellow-400' }
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

// ── Component ────────────────────────────────────────────────────────────────

export const TechnicalIndicatorsCard = memo(function TechnicalIndicatorsCard() {
  const ti = useMarketStore((s) => s.technicalIndicators)

  const isLoaded = ti !== null
  const rsi = isLoaded ? rsiConfig(ti.rsi14) : null
  const crossover = isLoaded ? CROSSOVER_CONFIG[ti.macd.crossover] : null
  const bbPos = isLoaded ? (BB_CONFIG[ti.bbands.position] ?? BB_CONFIG.middle) : null

  return (
    <motion.section
      className="card mt-4"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm font-display font-bold text-text-primary tracking-wide">
          Indicadores Técnicos
        </span>
        <span className="text-[10px] text-text-muted">
          {isLoaded
            ? new Date(ti.capturedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
            : '—'}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

        {/* RSI(14) */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">RSI (14)</span>
            {isLoaded
              ? <span className={`text-[10px] font-bold tracking-wider ${rsi!.color}`}>{rsi!.label}</span>
              : <Skeleton className="w-20" height="0.7rem" />}
          </div>
          {/* Value */}
          <div className="mb-2">
            {isLoaded
              ? <span className="text-2xl font-bold font-num text-text-primary">{ti.rsi14.toFixed(1)}</span>
              : <Skeleton className="w-16 h-8" />}
          </div>
          {/* Gauge bar */}
          <div className="relative h-1.5 bg-bg-elevated rounded-full overflow-hidden border border-border-subtle">
            {isLoaded
              ? (
                <motion.div
                  className={`absolute left-0 top-0 h-full rounded-full ${rsi!.bar}`}
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(ti.rsi14, 100)}%` }}
                  transition={{ duration: 0.8, ease: 'easeOut' }}
                />
              )
              : <div className="skeleton w-full h-full" />}
          </div>
          {/* Zone labels */}
          <div className="flex justify-between mt-0.5 text-[9px] text-text-muted">
            <span>0</span>
            <span>30</span>
            <span>70</span>
            <span>100</span>
          </div>
        </div>

        {/* MACD */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">MACD</span>
            {isLoaded && crossover
              ? (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border tracking-wider ${crossover.color}`}>
                  {crossover.icon} {crossover.label}
                </span>
              )
              : <Skeleton className="w-20" height="0.7rem" />}
          </div>
          {/* Histogram value */}
          <div className="mb-2">
            {isLoaded
              ? (
                <span className={`text-2xl font-bold font-num ${ti.macd.histogram >= 0 ? 'text-[#00ff88]' : 'text-red-400'}`}>
                  {ti.macd.histogram >= 0 ? '+' : ''}{ti.macd.histogram.toFixed(3)}
                </span>
              )
              : <Skeleton className="w-24 h-8" />}
          </div>
          {/* MACD vs Signal */}
          <div className="space-y-1 text-[10px]">
            <div className="flex justify-between">
              <span className="text-text-muted">MACD</span>
              {isLoaded
                ? <span className="font-num text-text-secondary">{ti.macd.macd.toFixed(3)}</span>
                : <Skeleton className="w-12" height="0.7rem" />}
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Signal</span>
              {isLoaded
                ? <span className="font-num text-text-secondary">{ti.macd.signal.toFixed(3)}</span>
                : <Skeleton className="w-12" height="0.7rem" />}
            </div>
          </div>
        </div>

        {/* Bollinger Bands */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">BB (20, 2σ)</span>
            {isLoaded && bbPos
              ? (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border tracking-wider ${bbPos.color}`}>
                  {bbPos.label}
                </span>
              )
              : <Skeleton className="w-24" height="0.7rem" />}
          </div>
          {/* Mid value */}
          <div className="mb-2">
            {isLoaded
              ? <span className="text-2xl font-bold font-num text-text-primary">${ti.bbands.middle.toFixed(2)}</span>
              : <Skeleton className="w-24 h-8" />}
          </div>
          {/* Upper / Lower */}
          <div className="space-y-1 text-[10px]">
            <div className="flex justify-between">
              <span className="text-text-muted">Superior</span>
              {isLoaded
                ? <span className="font-num text-text-secondary">${ti.bbands.upper.toFixed(2)}</span>
                : <Skeleton className="w-14" height="0.7rem" />}
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Inferior</span>
              {isLoaded
                ? <span className="font-num text-text-secondary">${ti.bbands.lower.toFixed(2)}</span>
                : <Skeleton className="w-14" height="0.7rem" />}
            </div>
          </div>
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

import { memo } from 'react'
import { motion } from 'framer-motion'
import { useMarketStore } from '../../store/marketStore'
import { Skeleton } from '../ui/Skeleton'

const LABEL_CONFIG = {
  low: { text: 'BAIXO', color: 'text-[#00ff88]', bar: 'bg-[#00ff88]' },
  medium: { text: 'MÉDIO', color: 'text-yellow-400', bar: 'bg-yellow-400' },
  high: { text: 'ALTO', color: 'text-red-400', bar: 'bg-red-400' },
  null: { text: '—', color: 'text-text-muted', bar: 'bg-text-muted' },
}

export const IVRankCard = memo(function IVRankCard() {
  const ivRank = useMarketStore((s) => s.ivRank)

  const isLoaded = ivRank.value !== null
  const label = LABEL_CONFIG[ivRank.label ?? 'null']
  const pct = ivRank.value ?? 0

  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut', delay: 0.07 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-display font-bold text-text-primary tracking-wide">
          SPY IV Rank
        </span>
        {isLoaded && (
          <span className={`text-[10px] font-semibold tracking-widest uppercase ${label.color}`}>
            {label.text}
          </span>
        )}
      </div>

      {/* IV Rank value */}
      <div className="mb-1">
        {isLoaded ? (
          <span className="text-4xl font-bold font-num text-text-primary tracking-tight">
            {pct.toFixed(0)}
            <span className="text-2xl text-text-secondary ml-0.5">%</span>
          </span>
        ) : (
          <Skeleton className="w-24 h-10" />
        )}
      </div>

      {/* Percentile */}
      <div className="flex items-center gap-2 mb-5 text-sm text-text-secondary font-num">
        {isLoaded ? (
          <span>Percentil: {ivRank.percentile?.toFixed(0) ?? '—'}%</span>
        ) : (
          <Skeleton className="w-28" height="1rem" />
        )}
      </div>

      {/* Progress bar */}
      <div className="space-y-1.5">
        <div className="flex justify-between text-[10px] text-text-muted">
          <span>0</span>
          <span>50</span>
          <span>100</span>
        </div>
        <div className="relative h-2 bg-bg-elevated rounded-full overflow-hidden border border-border-subtle">
          {isLoaded ? (
            <motion.div
              className={`absolute left-0 top-0 h-full rounded-full ${label.bar}`}
              initial={{ width: 0 }}
              animate={{ width: `${Math.min(pct, 100)}%` }}
              transition={{ duration: 0.8, ease: 'easeOut' }}
            />
          ) : (
            <div className="skeleton w-full h-full" />
          )}
        </div>
        <div className="text-[10px] text-text-muted">
          {pct < 30
            ? 'Volatilidade baixa — preferir compra de opções'
            : pct > 70
              ? 'Volatilidade alta — preferir venda de opções'
              : 'Volatilidade moderada — estratégias neutras'}
        </div>
      </div>
    </motion.div>
  )
})

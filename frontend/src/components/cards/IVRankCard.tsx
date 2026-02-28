import { memo } from 'react'
import { motion } from 'framer-motion'
import { useMarketStore } from '../../store/marketStore'
import { Skeleton } from '../ui/Skeleton'

const LABEL_CONFIG = {
  low:    { text: 'BAIXO',  color: 'text-[#00ff88]',   bar: 'bg-[#00ff88]' },
  medium: { text: 'MÉDIO',  color: 'text-yellow-400',   bar: 'bg-yellow-400' },
  high:   { text: 'ALTO',   color: 'text-red-400',      bar: 'bg-red-400' },
  null:   { text: '—',      color: 'text-text-muted',   bar: 'bg-text-muted' },
}

export const IVRankCard = memo(function IVRankCard() {
  const ivRank = useMarketStore((s) => s.ivRank)

  const isLoaded = ivRank.value !== null
  const label = LABEL_CONFIG[ivRank.label ?? 'null']
  const pct = ivRank.value ?? 0

  return (
    <motion.div
      className="card flex flex-col"
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

      {/* IVx — valor principal */}
      <div className="mb-1">
        {isLoaded ? (
          ivRank.ivx !== null ? (
            <span className="text-4xl font-bold font-num text-text-primary tracking-tight">
              {ivRank.ivx.toFixed(1)}
              <span className="text-2xl text-text-secondary ml-0.5">%</span>
            </span>
          ) : (
            <span className="text-4xl font-bold font-num text-text-muted tracking-tight">—</span>
          )
        ) : (
          <Skeleton className="w-24 h-10" />
        )}
      </div>

      {/* IVx subtitle */}
      <div className="mb-4 text-[10px] text-text-muted">
        {isLoaded
          ? 'vol implícita composta (IVx)'
          : <Skeleton className="w-36" height="0.75rem" />}
      </div>

      {/* IV Rank + Percentil — seção secundária */}
      <div className="space-y-2">
        {/* IV Rank row */}
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-text-muted w-16 shrink-0">IV Rank</span>
          <div className="flex-1 relative h-1.5 bg-bg-elevated rounded-full overflow-hidden border border-border-subtle">
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
          <span className="text-[11px] font-num font-semibold text-text-primary w-9 text-right shrink-0">
            {isLoaded ? `${pct.toFixed(0)}%` : '—'}
          </span>
        </div>

        {/* Percentil row */}
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-text-muted w-16 shrink-0">Percentil</span>
          <div className="flex-1" />
          <span className="text-[11px] font-num text-text-secondary w-9 text-right shrink-0">
            {isLoaded ? `${ivRank.percentile?.toFixed(0) ?? '—'}%` : '—'}
          </span>
        </div>
      </div>

      {/* Interpretação — empurrada para o rodapé, alinhada com a sparkline dos outros cards */}
      <div className="mt-auto border-t border-border-subtle pt-3">
        <div className="text-[10px] text-text-muted">
          {isLoaded
            ? pct < 30
              ? 'Volatilidade baixa — preferir compra de opções'
              : pct > 70
                ? 'Volatilidade alta — preferir venda de opções'
                : 'Volatilidade moderada — estratégias neutras'
            : <Skeleton className="w-48" height="0.75rem" />}
        </div>
      </div>
    </motion.div>
  )
})

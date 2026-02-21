import { memo, useMemo } from 'react'
import { motion } from 'framer-motion'
import { useMarketStore } from '../../store/marketStore'
import { TickFlash } from '../ui/TickFlash'
import { Skeleton } from '../ui/Skeleton'
import { PriceSparkline } from '../charts/PriceSparkline'
import { fmtPrice, fmtChange, fmtPct, changeClass, isUp } from '../../lib/formatters'

const LEVEL_CONFIG = {
  low: { text: 'VOL. BAIXA', color: 'text-[#00ff88]' },
  moderate: { text: 'VOL. MOD.', color: 'text-yellow-400' },
  high: { text: 'VOL. ALTA', color: 'text-red-400' },
  null: { text: '—', color: 'text-text-muted' },
}

export const VIXCard = memo(function VIXCard() {
  const vix = useMarketStore((s) => s.vix)

  const isLoaded = vix.last !== null
  const level = LEVEL_CONFIG[vix.level ?? 'null']
  const dirClass = changeClass(vix.change)
  const arrow = isUp(vix.change) ? '▲' : vix.change !== null && vix.change < 0 ? '▼' : ''

  const sparkData = useMemo(
    () => vix.priceHistory,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vix.priceHistory.length, vix.priceHistory[vix.priceHistory.length - 1]],
  )

  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut', delay: 0.14 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-display font-bold text-text-primary tracking-wide">
          VIX
        </span>
        {isLoaded && (
          <span className={`text-[10px] font-semibold tracking-widest uppercase ${level.color}`}>
            {level.text}
          </span>
        )}
      </div>

      {/* Price */}
      <div className="mb-1">
        {isLoaded ? (
          <TickFlash value={vix.last} className="block">
            <span className="text-4xl font-bold font-num text-text-primary tracking-tight">
              {fmtPrice(vix.last)}
            </span>
          </TickFlash>
        ) : (
          <Skeleton className="w-32 h-10" />
        )}
      </div>

      {/* Change */}
      <div className="flex items-center gap-2 mb-4 text-sm font-num">
        {isLoaded ? (
          <>
            <span className={`font-semibold ${dirClass}`}>
              {arrow} {fmtChange(vix.change)}
            </span>
            <span className={`${dirClass} opacity-80`}>
              ({fmtPct(vix.changePct)})
            </span>
          </>
        ) : (
          <Skeleton className="w-32" height="1.1rem" />
        )}
      </div>

      {/* VIX zones */}
      <div className="grid grid-cols-3 gap-1 mb-4 text-[10px] text-center">
        {[
          { label: '< 15', name: 'Baixa', active: vix.last !== null && vix.last < 15 },
          {
            label: '15–25',
            name: 'Moderada',
            active: vix.last !== null && vix.last >= 15 && vix.last <= 25,
          },
          { label: '> 25', name: 'Alta', active: vix.last !== null && vix.last > 25 },
        ].map((zone) => (
          <div
            key={zone.name}
            className={`rounded px-1 py-1 border ${
              zone.active
                ? 'border-[#00ff88]/30 bg-[#00ff88]/5 text-[#00ff88]'
                : 'border-border-subtle text-text-muted'
            }`}
          >
            <div className="font-semibold">{zone.label}</div>
            <div className="opacity-70">{zone.name}</div>
          </div>
        ))}
      </div>

      {/* Sparkline */}
      <div className="border-t border-border-subtle pt-3">
        <PriceSparkline
          data={sparkData}
          color={vix.level === 'high' ? '#ff4444' : '#ffcc00'}
          height={48}
        />
      </div>
    </motion.div>
  )
})

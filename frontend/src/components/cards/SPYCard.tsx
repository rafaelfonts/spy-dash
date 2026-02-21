import { memo, useMemo } from 'react'
import { motion } from 'framer-motion'
import { useMarketStore } from '../../store/marketStore'
import { useMarketOpen } from '../../hooks/useMarketOpen'
import { TickFlash } from '../ui/TickFlash'
import { Skeleton } from '../ui/Skeleton'
import { PriceSparkline } from '../charts/PriceSparkline'
import {
  fmtPrice,
  fmtChange,
  fmtPct,
  fmtSpread,
  fmtVolume,
  changeClass,
  isUp,
} from '../../lib/formatters'

export const SPYCard = memo(function SPYCard() {
  const spy = useMarketStore((s) => s.spy)
  const isMarketOpen = useMarketOpen()

  const isLoaded = spy.last !== null
  const dirClass = changeClass(spy.change)
  const arrow = isUp(spy.change) ? '▲' : spy.change !== null && spy.change < 0 ? '▼' : ''

  // Throttle sparkline updates — only recompute when history length changes or value differs by >0.1
  const sparkData = useMemo(
    () => spy.priceHistory,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spy.priceHistory.length, spy.priceHistory[spy.priceHistory.length - 1]],
  )

  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-display font-bold text-text-primary tracking-wide">
          SPY
        </span>
        {isMarketOpen ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#00ff88] tracking-widest uppercase">
            <span className="w-1.5 h-1.5 rounded-full bg-[#00ff88] animate-pulse-dot" />
            AO VIVO
          </span>
        ) : (
          <span className="text-[10px] font-semibold text-text-muted tracking-widest uppercase">
            FECHADO
          </span>
        )}
      </div>

      {/* Price */}
      <div className="mb-1">
        {isLoaded ? (
          <TickFlash value={spy.last} className="block">
            <span className="text-4xl font-bold font-num text-text-primary tracking-tight">
              ${fmtPrice(spy.last)}
            </span>
          </TickFlash>
        ) : (
          <Skeleton className="w-40 h-10" />
        )}
      </div>

      {/* Change */}
      <div className="flex items-center gap-2 mb-4 text-sm font-num">
        {isLoaded ? (
          <>
            <span className={`font-semibold ${dirClass}`}>
              {arrow} {fmtChange(spy.change)}
            </span>
            <span className={`${dirClass} opacity-80`}>
              ({fmtPct(spy.changePct)})
            </span>
          </>
        ) : (
          <Skeleton className="w-32" height="1.1rem" />
        )}
      </div>

      {/* Bid / Ask / Volume */}
      <div className="grid grid-cols-2 gap-2 mb-4 text-[11px]">
        <div>
          <span className="text-text-muted">Bid/Ask</span>
          <div className="font-num text-text-secondary mt-0.5">
            {isLoaded ? fmtSpread(spy.bid, spy.ask) : <Skeleton height="0.9rem" />}
          </div>
        </div>
        <div>
          <span className="text-text-muted">Volume</span>
          <div className="font-num text-text-secondary mt-0.5">
            {isLoaded ? fmtVolume(spy.volume) : <Skeleton height="0.9rem" />}
          </div>
        </div>
        <div>
          <span className="text-text-muted">High</span>
          <div className="font-num text-text-secondary mt-0.5">
            {isLoaded ? `$${fmtPrice(spy.dayHigh)}` : <Skeleton height="0.9rem" />}
          </div>
        </div>
        <div>
          <span className="text-text-muted">Low</span>
          <div className="font-num text-text-secondary mt-0.5">
            {isLoaded ? `$${fmtPrice(spy.dayLow)}` : <Skeleton height="0.9rem" />}
          </div>
        </div>
      </div>

      {/* Sparkline */}
      <div className="border-t border-border-subtle pt-3">
        <PriceSparkline data={sparkData} height={52} showTooltip />
      </div>
    </motion.div>
  )
})

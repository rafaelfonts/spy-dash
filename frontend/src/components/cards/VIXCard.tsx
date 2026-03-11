import { memo } from 'react'
import { motion } from 'framer-motion'
import { useMarketStore } from '../../store/marketStore'
import { TickFlash } from '../ui/TickFlash'
import { Skeleton } from '../ui/Skeleton'
import { fmtPrice, fmtChange, fmtPct, changeClass, isUp } from '../../lib/formatters'

const LEVEL_CONFIG = {
  low: { text: 'VOL. BAIXA', color: 'text-[#00ff88]' },
  moderate: { text: 'VOL. MOD.', color: 'text-yellow-400' },
  high: { text: 'VOL. ALTA', color: 'text-red-400' },
  null: { text: '—', color: 'text-text-muted' },
}

export const VIXCard = memo(function VIXCard() {
  const vix = useMarketStore((s) => s.vix)
  const vixTS = useMarketStore((s) => s.vixTermStructure)

  const isLoaded = vix.last !== null
  const level = LEVEL_CONFIG[vix.level ?? 'null']
  const dirClass = changeClass(vix.change)
  const arrow = isUp(vix.change) ? '▲' : vix.change !== null && vix.change < 0 ? '▼' : ''

  return (
    <motion.div
      className="card flex flex-col"
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

      {/* VIX Term Structure */}
      {vixTS && (
        <div className="mt-3 pt-3 border-t border-border-subtle">
          {/* Regime badge + steepness */}
          <div className="flex items-center justify-between mb-2">
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
              vixTS.structure === 'contango'
                ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                : vixTS.structure === 'backwardation'
                ? 'bg-red-500/10 text-red-400 border-red-500/20'
                : vixTS.structure === 'humped'
                ? 'bg-orange-500/10 text-orange-400 border-orange-500/20'
                : 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
            }`}>
              {vixTS.structure.toUpperCase()}
            </span>
            <span className={`text-[10px] font-num ${
              vixTS.steepness > 0 ? 'text-blue-400' :
              vixTS.steepness < 0 ? 'text-red-400' :
              'text-text-muted'
            }`}>
              {vixTS.curvature != null
                ? `curv ${vixTS.curvature > 0 ? '+' : ''}${vixTS.curvature.toFixed(1)}%`
                : `${vixTS.steepness > 0 ? '+' : ''}${vixTS.steepness}%`
              }
            </span>
          </div>

          {/* Mini IV curve: bar per DTE */}
          <div className="flex items-end gap-1 h-10">
            {vixTS.curve.map((point) => {
              const maxIV = Math.max(...vixTS.curve.map((p) => p.iv))
              const minIV = Math.min(...vixTS.curve.map((p) => p.iv))
              const range = maxIV - minIV || 1
              const heightPct = 20 + ((point.iv - minIV) / range) * 60 // 20–80% of 40px
              return (
                <div key={point.dte} className="flex flex-col items-center flex-1 gap-0.5 h-full justify-end">
                  <div
                    className={`w-full rounded-t-sm ${
                      vixTS.structure === 'contango' ? 'bg-blue-500/50' :
                      vixTS.structure === 'backwardation' ? 'bg-red-500/50' :
                      vixTS.structure === 'humped' ? 'bg-orange-500/50' :
                      'bg-yellow-500/50'
                    }`}
                    style={{ height: `${heightPct}%` }}
                  />
                  <span className="text-[8px] text-text-muted leading-none">
                    {point.dte === 0 ? '0d' : `${point.dte}d`}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </motion.div>
  )
})

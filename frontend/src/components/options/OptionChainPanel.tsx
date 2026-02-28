import { memo } from 'react'
import { motion } from 'framer-motion'
import { useMarketStore } from '../../store/marketStore'
import type { OptionLeg } from '../../store/marketStore'

function fmtGreek(v: number | null | undefined, decimals = 2): string {
  if (v == null) return '—'
  return v.toFixed(decimals)
}

function deltaColor(delta: number | null, type: 'call' | 'put'): string {
  if (delta === null) return 'text-text-muted'
  const abs = Math.abs(delta)
  if (abs >= 0.65) return type === 'call' ? 'text-[#00ff88]' : 'text-red-400'
  if (abs >= 0.35) return 'text-text-primary'
  return 'text-text-muted'
}

interface LegCellProps {
  leg: OptionLeg
  type: 'call' | 'put'
}

function LegCell({ leg, type }: LegCellProps) {
  const hasBidAsk = leg.bid !== null && leg.ask !== null
  return (
    <div className="flex items-center gap-2 font-num text-[11px]">
      <span className="text-text-secondary tabular-nums">
        {hasBidAsk ? `${leg.bid}/${leg.ask}` : '—'}
      </span>
      {leg.delta !== null && (
        <span className={`text-[10px] tabular-nums ${deltaColor(leg.delta, type)}`}>
          Δ{fmtGreek(leg.delta)}
        </span>
      )}
      {leg.gamma !== null && (
        <span className="text-[10px] tabular-nums text-text-muted">
          γ{fmtGreek(leg.gamma, 4)}
        </span>
      )}
      {leg.theta !== null && (
        <span className="text-[10px] tabular-nums text-text-muted">
          θ{fmtGreek(leg.theta)}
        </span>
      )}
      {leg.vega !== null && (
        <span className="text-[10px] tabular-nums text-text-muted">
          ν{fmtGreek(leg.vega, 2)}
        </span>
      )}
    </div>
  )
}

export const OptionChainPanel = memo(function OptionChainPanel() {
  const chain = useMarketStore((s) => s.optionChain)
  const spyLast = useMarketStore((s) => s.spy.last)
  const meta = useMarketStore((s) => s.optionChainMeta)

  if (chain.length === 0) return null

  const spot = spyLast ?? 0

  // ATM range: base 5 + 1 extra strike per 0.5pt move since capture
  const atmRange =
    meta?.capturedAtPrice && meta.currentPrice
      ? Math.ceil(Math.abs(meta.currentPrice - meta.capturedAtPrice) / 0.5) + 5
      : 5
  const cacheLabel = meta ? (meta.cacheHit ? 'cache' : 'live') : '—'
  const deltaLabel = meta?.priceDelta ?? '—'

  return (
    <motion.section
      className="card mt-4"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut', delay: 0.15 }}
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-display font-bold text-text-primary tracking-wide">
            Cadeia de Opções SPY
          </h2>
          <p className="text-[11px] text-text-muted mt-0.5">
            ATM ±{atmRange} strikes · {cacheLabel} · SPY Δ{deltaLabel}
          </p>
        </div>
      </div>

      {chain.slice(0, 3).map((exp) => {
        const atmCalls = exp.calls
          .filter((c) => c.bid !== null || c.ask !== null)
          .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
          .slice(0, 5)

        if (atmCalls.length === 0) return null

        const apiCount = exp.calls.filter((c) => c.greeksSource === 'api').length
        const bsCount = exp.calls.filter((c) => c.greeksSource === 'calculated').length
        const srcLabel = apiCount >= bsCount ? 'API' : 'BS'

        return (
          <div key={exp.expirationDate} className="mb-5 last:mb-0">
            {/* Expiry header */}
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] font-bold tracking-widest text-text-muted uppercase">
                {exp.expirationDate}
              </span>
              <span className="text-[10px] text-text-muted">
                {exp.dte} DTE
              </span>
              <span className="text-[9px] text-text-muted border border-border-subtle rounded px-1.5 py-0.5">
                greeks: {srcLabel}
              </span>
            </div>

            {/* Column header */}
            <div className="grid grid-cols-[72px_1fr_1fr] gap-x-3 text-[9px] text-text-muted uppercase tracking-wide mb-1 px-1">
              <span>Strike</span>
              <span>Call (bid/ask Δ γ θ ν)</span>
              <span>Put (bid/ask Δ γ θ ν)</span>
            </div>

            {/* Strike rows */}
            {atmCalls.map((call) => {
              const put = exp.puts.find((p) => p.strike === call.strike)
              const isATM = Math.abs(call.strike - spot) < 2.0

              return (
                <div
                  key={call.strike}
                  className={[
                    'grid grid-cols-[72px_1fr_1fr] gap-x-3 px-1 py-[3px] rounded',
                    isATM
                      ? 'bg-[#00ff88]/5 border border-[#00ff88]/20'
                      : 'hover:bg-bg-elevated/50',
                  ].join(' ')}
                >
                  <span
                    className={`font-num font-semibold text-[11px] tabular-nums ${
                      isATM ? 'text-[#00ff88]' : 'text-text-secondary'
                    }`}
                  >
                    ${call.strike}
                  </span>

                  <LegCell leg={call} type="call" />

                  {put ? (
                    <LegCell leg={put} type="put" />
                  ) : (
                    <span className="text-[11px] text-text-muted">—</span>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </motion.section>
  )
})

import { memo, useMemo } from 'react'
import { motion } from 'framer-motion'
import { useMarketStore } from '../../store/marketStore'
import type { StrikeGEX } from '../../store/marketStore'

function fmtM(v: number): string {
  return `$${Math.abs(v).toFixed(1)}M`
}

function BarRow({ s, maxAbs }: { s: StrikeGEX; maxAbs: number }) {
  const pct = maxAbs > 0 ? (Math.abs(s.netGEX) / maxAbs) * 100 : 0
  const isPositive = s.netGEX >= 0

  return (
    <div className="flex items-center gap-2 text-[10px] font-num h-5">
      <span className="w-10 text-right text-text-secondary shrink-0">{s.strike}</span>
      <div className="flex-1 flex items-center h-3">
        {/* Negative bar (puts) grows left from center */}
        <div className="w-1/2 flex justify-end">
          {!isPositive && (
            <div
              className="h-full rounded-l bg-red-500/70"
              style={{ width: `${pct}%` }}
            />
          )}
        </div>
        {/* Center divider */}
        <div className="w-px h-full bg-border-subtle shrink-0" />
        {/* Positive bar (calls) grows right from center */}
        <div className="w-1/2 flex justify-start">
          {isPositive && (
            <div
              className="h-full rounded-r bg-[#00ff88]/70"
              style={{ width: `${pct}%` }}
            />
          )}
        </div>
      </div>
      <span className={`w-14 text-right shrink-0 ${isPositive ? 'text-[#00ff88]' : 'text-red-400'}`}>
        {isPositive ? '+' : '-'}{fmtM(s.netGEX)}
      </span>
    </div>
  )
}

export const GEXPanel = memo(function GEXPanel() {
  const gex = useMarketStore((s) => s.gexProfile)
  const spyLast = useMarketStore((s) => s.spy.last)

  // Get top strikes by |netGEX|, centered around ATM
  const topStrikes = useMemo(() => {
    if (!gex || !spyLast) return []

    // Filter strikes near ATM (±15 from spot) and take top 20 by magnitude
    const nearATM = gex.byStrike
      .filter((s) => Math.abs(s.strike - spyLast) <= 15)
      .sort((a, b) => Math.abs(b.netGEX) - Math.abs(a.netGEX))
      .slice(0, 20)

    // Re-sort by strike for display
    return nearATM.sort((a, b) => a.strike - b.strike)
  }, [gex, spyLast])

  const maxAbs = useMemo(
    () => topStrikes.reduce((max, s) => Math.max(max, Math.abs(s.netGEX)), 0),
    [topStrikes],
  )

  if (!gex) {
    return (
      <motion.section
        className="card mt-4 opacity-50"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 0.5, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-display font-bold text-text-primary tracking-wide">
            Gamma Exposure (GEX)
          </span>
          <span className="text-[10px] text-text-muted">Desabilitado</span>
        </div>
        <p className="text-xs text-text-secondary leading-relaxed">
          GEX requer dados de open interest via Tradier API.{' '}
          Adicione{' '}
          <code className="text-[11px] bg-surface-2 px-1 rounded">TRADIER_API_KEY=&lt;key&gt;</code>{' '}
          no <code className="text-[11px] bg-surface-2 px-1 rounded">backend/.env</code> e reinicie o servidor.{' '}
          Conta gratuita em{' '}
          <span className="text-text-primary font-medium">tradier.com</span>.
        </p>
      </motion.section>
    )
  }

  if (topStrikes.length === 0) {
    return (
      <motion.section
        className="card mt-4"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-display font-bold text-text-primary tracking-wide">
            Gamma Exposure (GEX)
          </span>
        </div>
        <p className="text-xs text-text-secondary">Sem dados próximos ao ATM.</p>
      </motion.section>
    )
  }

  const isPositive = gex.regime === 'positive'
  const regimeColor = isPositive ? 'text-[#00ff88]' : 'text-red-400'
  const regimeLabel = isPositive ? 'POSITIVO' : 'NEGATIVO'
  const regimeDesc = isPositive
    ? 'MMs suprimem volatilidade'
    : 'MMs amplificam volatilidade'

  return (
    <motion.section
      className="card mt-4"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-display font-bold text-text-primary tracking-wide">
            Gamma Exposure (GEX)
          </span>
          <span className={`text-[10px] font-semibold tracking-widest uppercase ${regimeColor}`}>
            {regimeLabel}
          </span>
        </div>
        <span className="text-[10px] text-text-muted">
          {new Date(gex.calculatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {/* Key metrics */}
      <div className="grid grid-cols-4 gap-3 mb-4 text-center">
        <div>
          <div className="text-[10px] text-text-muted uppercase tracking-wider">GEX Total</div>
          <div className={`text-sm font-bold font-num ${regimeColor}`}>
            {gex.totalGEX >= 0 ? '+' : ''}{fmtM(gex.totalGEX)}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-text-muted uppercase tracking-wider">Flip Point</div>
          <div className="text-sm font-bold font-num text-text-primary">
            {gex.flipPoint ?? '—'}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-text-muted uppercase tracking-wider">Max Gamma</div>
          <div className="text-sm font-bold font-num text-text-primary">
            {gex.maxGammaStrike}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-text-muted uppercase tracking-wider">Regime</div>
          <div className={`text-[10px] font-semibold ${regimeColor}`}>
            {regimeDesc}
          </div>
        </div>
      </div>

      {/* Bar chart */}
      <div className="border-t border-border-subtle pt-3">
        <div className="flex items-center justify-between mb-2 text-[9px] text-text-muted uppercase tracking-wider">
          <span>Put GEX (—)</span>
          <span>Strike</span>
          <span>Call GEX (+)</span>
        </div>
        <div className="space-y-0.5">
          {topStrikes.map((s) => (
            <BarRow key={s.strike} s={s} maxAbs={maxAbs} />
          ))}
        </div>
      </div>
    </motion.section>
  )
})

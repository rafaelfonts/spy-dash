// frontend/src/components/options/DeepDivePanel.tsx

import type { ReactNode } from 'react'
import type { OptionDeepDiveFE, OptionStrategyFE, ScreenerStatus } from '../../store/marketStore'

interface Props {
  symbol: string | null
  deepDive: OptionDeepDiveFE | null
  strategy: OptionStrategyFE | null
  strategyTokens: string
  status: ScreenerStatus
}

function MetricBox({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-bg-elevated rounded p-2 text-center border border-border-subtle">
      <div className="text-[9px] text-text-muted uppercase tracking-wider">{label}</div>
      <div className={`text-sm font-bold mt-0.5 ${color ?? 'text-text-primary'}`}>{value}</div>
    </div>
  )
}

function EventWarning({ children, level }: { children: ReactNode; level: 'error' | 'warn' | 'info' }) {
  const colors = {
    error: 'bg-[#ff4444]/10 border-[#ff4444]/30 text-[#ff4444]',
    warn:  'bg-[#ffcc00]/10 border-[#ffcc00]/30 text-[#ffcc00]',
    info:  'bg-[#ffcc00]/5 border-[#ffcc00]/20 text-[#ffcc00]/80',
  }
  return (
    <div className={`text-[10px] rounded px-2 py-1 border ${colors[level]}`}>
      {children}
    </div>
  )
}

export function DeepDivePanel({ symbol, deepDive, strategy, strategyTokens, status }: Props) {
  if (!symbol) {
    return (
      <div className="flex items-center justify-center h-full text-text-secondary text-sm p-4">
        Selecione um candidato para análise detalhada
      </div>
    )
  }

  if (status === 'analyzing' && !deepDive) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-text-secondary text-sm p-4">
        <div className="w-4 h-4 rounded-full border-2 border-[#00ff88] border-t-transparent animate-spin" />
        Analisando {symbol}...
      </div>
    )
  }

  const events = deepDive?.events

  return (
    <div className="flex flex-col gap-3 p-3 overflow-y-auto h-full">
      {/* Header */}
      <div className="flex justify-between items-center">
        <span className="text-text-primary font-bold text-sm">{symbol} — Análise Detalhada</span>
        {deepDive && deepDive.ivRank >= 40 && (
          <span className="text-[10px] bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/30 rounded px-2 py-0.5">
            IVR ALTO
          </span>
        )}
        {deepDive && deepDive.ivRank <= 20 && (
          <span className="text-[10px] bg-[#4488ff]/10 text-[#4488ff] border border-[#4488ff]/30 rounded px-2 py-0.5">
            IVR BAIXO
          </span>
        )}
      </div>

      {/* Metrics grid */}
      {deepDive && (
        <div className="grid grid-cols-4 gap-1.5">
          <MetricBox
            label="IVR"
            value={`${deepDive.ivRank.toFixed(0)}${deepDive.ivPercentile !== null ? ` · IVP ${deepDive.ivPercentile}%` : ''}`}
            color={deepDive.ivRank >= 40 ? 'text-[#00ff88]' : deepDive.ivRank <= 20 ? 'text-[#4488ff]' : 'text-text-primary'}
          />
          <MetricBox
            label="Max Pain"
            value={deepDive.maxPain ? `$${deepDive.maxPain.maxPainStrike}` : 'N/A'}
            color={deepDive.maxPain?.pinRisk === 'high' ? 'text-[#ff4444]' : deepDive.maxPain?.pinRisk === 'moderate' ? 'text-[#ffcc00]' : 'text-text-primary'}
          />
          <MetricBox
            label="P/C Ratio"
            value={deepDive.putCallRatio?.toFixed(2) ?? 'N/A'}
          />
          <MetricBox
            label="GEX Regime"
            value={deepDive.gexRegime === 'positive' ? 'Positivo' : deepDive.gexRegime === 'negative' ? 'Negativo' : 'N/A'}
            color={deepDive.gexRegime === 'positive' ? 'text-[#00ff88]' : deepDive.gexRegime === 'negative' ? 'text-[#ffcc00]' : 'text-text-muted'}
          />
        </div>
      )}

      {/* IV Skew */}
      {deepDive?.ivSkew && (
        <div className="bg-bg-elevated rounded px-3 py-2 text-[11px] text-text-secondary flex gap-4 border border-border-subtle">
          <span>Call IV: <strong>{deepDive.ivSkew.callIV}%</strong></span>
          <span>Put IV: <strong>{deepDive.ivSkew.putIV}%</strong></span>
          <span>Skew: <strong className={deepDive.ivSkew.skew > 2 ? 'text-[#ffcc00]' : 'text-text-primary'}>{deepDive.ivSkew.skew > 0 ? '+' : ''}{deepDive.ivSkew.skew}</strong></span>
        </div>
      )}

      {/* Vol Metrics */}
      {deepDive?.volMetrics && (
        <div className="bg-bg-elevated rounded border border-border-subtle px-3 py-2">
          <p className="text-[9px] text-text-muted uppercase tracking-wider mb-2">Vol Metrics</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
            {/* IRP */}
            <span className="text-text-muted">
              IV Risk Premium:{' '}
              <strong className={deepDive.volMetrics.irp === null ? 'text-text-muted' : deepDive.volMetrics.irp > 0 ? 'text-[#00ff88]' : 'text-[#ff4444]'}>
                {deepDive.volMetrics.irp !== null ? `${deepDive.volMetrics.irp > 0 ? '+' : ''}${deepDive.volMetrics.irp.toFixed(1)}pp` : 'N/A'}
              </strong>
            </span>
            {/* RR25 */}
            <span className="text-text-muted">
              RR25:{' '}
              <strong className="text-text-primary">
                {deepDive.volMetrics.rr25 !== null ? `${deepDive.volMetrics.rr25.toFixed(1)}pp skew` : 'N/A'}
              </strong>
            </span>
            {/* TSS */}
            <span className="text-text-muted">
              Term Structure:{' '}
              <strong className={deepDive.volMetrics.termStructureInverted ? 'text-[#ffcc00]' : 'text-text-primary'}>
                {deepDive.volMetrics.tss !== null
                  ? `${deepDive.volMetrics.tss >= 0 ? '+' : ''}${(deepDive.volMetrics.tss * 100).toFixed(1)}% ${deepDive.volMetrics.termStructureInverted ? '[!] Backwardation' : 'Contango'}`
                  : 'N/A'}
              </strong>
            </span>
            {/* RVP */}
            <span className="text-text-muted">
              RVP:{' '}
              <strong className={
                deepDive.volMetrics.rvp === null ? 'text-text-muted' :
                deepDive.volMetrics.rvp < 30 ? 'text-[#00ff88]' :
                deepDive.volMetrics.rvp > 70 ? 'text-[#ff4444]' :
                'text-text-primary'
              }>
                {deepDive.volMetrics.rvp !== null
                  ? `Perc. ${deepDive.volMetrics.rvp}${deepDive.volMetrics.rvp < 30 ? ' (compressão)' : deepDive.volMetrics.rvp > 70 ? ' (expansão)' : ''}`
                  : 'N/A'}
              </strong>
            </span>
          </div>
        </div>
      )}

      {/* Events */}
      {events && (
        <div className="flex flex-col gap-1">
          <p className="text-[9px] text-text-muted uppercase tracking-wider">Eventos</p>
          {events.earningsWithinDTE && (
            <EventWarning level="error">[!] Earnings durante a operação: {events.nextEarnings}</EventWarning>
          )}
          {events.exDivWithin5Days && (
            <EventWarning level="warn">[!] Ex-dividend em {events.exDividendDate} — risco de exercício antecipado</EventWarning>
          )}
          {events.upcomingMacroEvents.map((e) => (
            <EventWarning key={e} level="info">{e}</EventWarning>
          ))}
          {!events.earningsWithinDTE && !events.exDivWithin5Days && events.upcomingMacroEvents.length === 0 && (
            <div className="text-[10px] text-[#00ff88]">Sem eventos de risco no período</div>
          )}
        </div>
      )}

      {/* AI Strategy */}
      {(strategy || strategyTokens) && (
        <div className="bg-[#00ff88]/5 border border-[#00ff88]/20 rounded-md p-3">
          <p className="text-[10px] text-[#00ff88] font-bold mb-2">
            Sugestão IA — {strategy?.type?.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) ?? '...'}
          </p>
          {strategy ? (
            <>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] mb-2">
                <span className="text-text-muted">Strike(s): <strong className="text-text-primary">{strategy.strikes.map((s) => `$${s}`).join(' / ')}</strong></span>
                <span className="text-text-muted">Expiry: <strong className="text-text-primary">{strategy.expiration} ({strategy.dte}d)</strong></span>
                {strategy.credit !== null && (
                  <span className="text-text-muted">Crédito: <strong className="text-[#00ff88]">${strategy.credit.toFixed(2)}/ação</strong></span>
                )}
                {strategy.debit !== null && (
                  <span className="text-text-muted">Débito: <strong className="text-[#ff4444]">${strategy.debit.toFixed(2)}/ação</strong></span>
                )}
                <span className="text-text-muted">Delta: <strong className="text-text-primary">Δ {strategy.delta.toFixed(2)}</strong></span>
                <span className="text-text-muted">POP: <strong className="text-[#4488ff]">{(strategy.popEstimate * 100).toFixed(0)}%</strong></span>
                <span className="text-text-muted">P&L Máx: <strong className="text-[#00ff88]">${strategy.maxProfit.toFixed(0)}</strong></span>
                <span className="text-text-muted">Break-even: <strong className="text-text-primary">{strategy.breakevens.map((b) => `$${b.toFixed(2)}`).join(' / ')}</strong></span>
              </div>
              <p className="text-[11px] text-text-secondary leading-relaxed">{strategy.rationale}</p>
            </>
          ) : (
            <p className="text-[11px] text-text-secondary leading-relaxed font-mono">{strategyTokens}</p>
          )}
        </div>
      )}

      {/* Streaming indicator */}
      {status === 'streaming' && !strategy && (
        <div className="flex items-center gap-1.5 text-[10px] text-[#4488ff]">
          <div className="w-2 h-2 rounded-full bg-[#4488ff] animate-pulse" />
          Gerando estratégia...
        </div>
      )}
    </div>
  )
}

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
    <div className="bg-gray-800 rounded p-2 text-center">
      <div className="text-[9px] text-gray-500 uppercase tracking-wider">{label}</div>
      <div className={`text-sm font-bold mt-0.5 ${color ?? 'text-white'}`}>{value}</div>
    </div>
  )
}

function EventWarning({ children, level }: { children: ReactNode; level: 'error' | 'warn' | 'info' }) {
  const colors = {
    error: 'bg-red-900/30 border-red-600/50 text-red-300',
    warn:  'bg-orange-900/30 border-orange-600/50 text-orange-300',
    info:  'bg-yellow-900/20 border-yellow-600/40 text-yellow-300',
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
      <div className="flex items-center justify-center h-full text-gray-500 text-sm p-4">
        Selecione um candidato para análise detalhada
      </div>
    )
  }

  if (status === 'analyzing' && !deepDive) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-gray-400 text-sm p-4">
        <div className="w-4 h-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
        Analisando {symbol}...
      </div>
    )
  }

  const events = deepDive?.events

  return (
    <div className="flex flex-col gap-3 p-3 overflow-y-auto h-full">
      {/* Header */}
      <div className="flex justify-between items-center">
        <span className="text-blue-300 font-bold text-sm">{symbol} — Análise Detalhada</span>
        {deepDive && deepDive.ivRank >= 40 && (
          <span className="text-[10px] bg-green-900/40 text-green-400 border border-green-700/50 rounded px-2 py-0.5">
            IVR ALTO
          </span>
        )}
        {deepDive && deepDive.ivRank <= 20 && (
          <span className="text-[10px] bg-blue-900/40 text-blue-400 border border-blue-700/50 rounded px-2 py-0.5">
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
            color={deepDive.ivRank >= 40 ? 'text-green-400' : deepDive.ivRank <= 20 ? 'text-blue-400' : 'text-white'}
          />
          <MetricBox
            label="Max Pain"
            value={deepDive.maxPain ? `$${deepDive.maxPain.maxPainStrike}` : 'N/A'}
            color={deepDive.maxPain?.pinRisk === 'high' ? 'text-red-400' : deepDive.maxPain?.pinRisk === 'moderate' ? 'text-yellow-400' : 'text-white'}
          />
          <MetricBox
            label="P/C Ratio"
            value={deepDive.putCallRatio?.toFixed(2) ?? 'N/A'}
          />
          <MetricBox
            label="GEX Regime"
            value={deepDive.gexRegime === 'positive' ? 'Positivo' : deepDive.gexRegime === 'negative' ? 'Negativo' : 'N/A'}
            color={deepDive.gexRegime === 'positive' ? 'text-green-400' : deepDive.gexRegime === 'negative' ? 'text-orange-400' : 'text-gray-400'}
          />
        </div>
      )}

      {/* IV Skew */}
      {deepDive?.ivSkew && (
        <div className="bg-gray-800 rounded px-3 py-2 text-[11px] text-gray-300 flex gap-4">
          <span>Call IV: <strong>{deepDive.ivSkew.callIV}%</strong></span>
          <span>Put IV: <strong>{deepDive.ivSkew.putIV}%</strong></span>
          <span>Skew: <strong className={deepDive.ivSkew.skew > 2 ? 'text-orange-400' : 'text-gray-200'}>{deepDive.ivSkew.skew > 0 ? '+' : ''}{deepDive.ivSkew.skew}</strong></span>
        </div>
      )}

      {/* Events */}
      {events && (
        <div className="flex flex-col gap-1">
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Eventos</p>
          {events.earningsWithinDTE && (
            <EventWarning level="error">⚠️ Earnings durante a operação: {events.nextEarnings}</EventWarning>
          )}
          {events.exDivWithin5Days && (
            <EventWarning level="warn">⚠️ Ex-dividend em {events.exDividendDate} — risco de exercício antecipado</EventWarning>
          )}
          {events.upcomingMacroEvents.map((e) => (
            <EventWarning key={e} level="info">📅 {e}</EventWarning>
          ))}
          {!events.earningsWithinDTE && !events.exDivWithin5Days && events.upcomingMacroEvents.length === 0 && (
            <div className="text-[10px] text-green-400">✅ Sem eventos de risco no período</div>
          )}
        </div>
      )}

      {/* AI Strategy */}
      {(strategy || strategyTokens) && (
        <div className="bg-green-950/30 border border-green-800/40 rounded-md p-3">
          <p className="text-[10px] text-green-400 font-bold mb-2">
            🤖 Sugestão IA — {strategy?.type?.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) ?? '...'}
          </p>
          {strategy ? (
            <>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] mb-2">
                <span className="text-gray-400">Strike(s): <strong className="text-white">{strategy.strikes.map((s) => `$${s}`).join(' / ')}</strong></span>
                <span className="text-gray-400">Expiry: <strong className="text-white">{strategy.expiration} ({strategy.dte}d)</strong></span>
                {strategy.credit !== null && (
                  <span className="text-gray-400">Crédito: <strong className="text-green-400">${strategy.credit.toFixed(2)}/ação</strong></span>
                )}
                {strategy.debit !== null && (
                  <span className="text-gray-400">Débito: <strong className="text-red-400">${strategy.debit.toFixed(2)}/ação</strong></span>
                )}
                <span className="text-gray-400">Delta: <strong className="text-white">Δ {strategy.delta.toFixed(2)}</strong></span>
                <span className="text-gray-400">POP: <strong className="text-blue-300">{(strategy.popEstimate * 100).toFixed(0)}%</strong></span>
                <span className="text-gray-400">P&L Máx: <strong className="text-green-400">${strategy.maxProfit.toFixed(0)}</strong></span>
                <span className="text-gray-400">Break-even: <strong className="text-white">{strategy.breakevens.map((b) => `$${b.toFixed(2)}`).join(' / ')}</strong></span>
              </div>
              <p className="text-[11px] text-gray-300 leading-relaxed">{strategy.rationale}</p>
            </>
          ) : (
            <p className="text-[11px] text-gray-300 leading-relaxed font-mono">{strategyTokens}</p>
          )}
        </div>
      )}

      {/* Streaming indicator */}
      {status === 'streaming' && !strategy && (
        <div className="flex items-center gap-1.5 text-[10px] text-blue-400">
          <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          Gerando estratégia...
        </div>
      )}
    </div>
  )
}

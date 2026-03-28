// frontend/src/components/equity/EquityScreenerPanel.tsx
import { useMarketStore } from '../../store/marketStore'
import { supabase } from '../../lib/supabase'
import { getApiBase } from '../../lib/apiBase'
import type { AnalysisStructuredEquity as EquityAnalysis } from '../../store/marketStore'
import { EquityRegimeBanner } from './EquityRegimeBanner'

export function EquityScreenerPanel() {
  const {
    equityCandidates, equityMarketOpen, equityAnalysisLoading, setEquityAnalysis, setEquityAnalysisLoading,
    equityRegimeVetoed, equityRegimeVetoReasons,
  } = useMarketStore()

  async function handleAnalyze(symbol: string) {
    setEquityAnalysisLoading(true)
    setEquityAnalysis(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token ?? ''
      const res = await fetch(`${getApiBase()}/api/equity/analyze`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      })
      if (res.ok) {
        const data: EquityAnalysis = await res.json()
        setEquityAnalysis(data)
        // Scroll suave para a análise
        setTimeout(() => document.getElementById('equity-ai-analysis')?.scrollIntoView({ behavior: 'smooth' }), 100)
      }
    } finally {
      setEquityAnalysisLoading(false)
    }
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-display font-bold text-text-primary">Screener — Candidatos Hoje</div>
        {!equityMarketOpen && (
          <span className="text-xs text-text-muted bg-bg-elevated px-2 py-0.5 rounded">Mercado fechado</span>
        )}
      </div>

      <EquityRegimeBanner />

      {/* Filtros ativos */}
      <div className="flex gap-1.5 flex-wrap mb-3">
        {['≥$5', 'RVOL >1.5x', 'Vol >500k', 'Var >2%'].map((f) => (
          <span key={f} className="text-[10px] bg-bg-elevated text-text-secondary px-2 py-0.5 rounded">{f}</span>
        ))}
      </div>

      {equityRegimeVetoed && (
        <div className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2">
          <div className="text-xs font-semibold text-red-400 mb-1">⚠️ Regime SPY adverso — screening suspenso</div>
          {equityRegimeVetoReasons.length > 0 && (
            <div className="text-[11px] text-red-300/70">{equityRegimeVetoReasons.slice(0, 3).join(' · ')}</div>
          )}
        </div>
      )}

      {equityCandidates.length === 0 ? (
        <div className="text-sm text-text-muted text-center py-6">
          {equityRegimeVetoed ? 'Screening pausado por regime adverso' : equityMarketOpen ? 'Nenhum candidato no momento' : 'Aguardando abertura do mercado'}
        </div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-muted uppercase text-[10px]">
              <td className="pb-2">Ticker</td>
              <td className="pb-2">Preço</td>
              <td className="pb-2">Var%</td>
              <td className="pb-2">MTF</td>
              <td className="pb-2">ADX</td>
              <td className="pb-2">Z</td>
              <td className="pb-2">Score</td>
              <td className="pb-2"></td>
            </tr>
          </thead>
          <tbody>
            {equityCandidates.map((c) => (
              <tr key={c.symbol} className="border-t border-border-subtle">
                <td className="py-2 font-bold text-text-primary">
                  <span className="flex items-center gap-1.5">
                    {c.symbol}
                    {c.hasCatalyst && <span className="text-[9px] text-yellow-500">📰</span>}
                    {c.isTopSetup && (
                      <span className="text-[9px] bg-amber-500/20 border border-amber-500/40 text-amber-400 px-1 py-0.5 rounded font-semibold">
                        ⭐ Top
                      </span>
                    )}
                  </span>
                </td>
                <td className="py-2 text-text-secondary">${c.price.toFixed(2)}</td>
                <td className={`py-2 font-medium ${c.change >= 0 ? 'text-[#00ff88]' : 'text-red-400'}`}>
                  {c.change >= 0 ? '+' : ''}{c.change.toFixed(1)}%
                </td>
                {/* MTF alignment badge */}
                <td className="py-2">
                  <span
                    className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
                    style={{
                      color: c.alignment === 'bullish' ? '#00ff88' : c.alignment === 'bearish' ? '#ff4444' : '#ffcc00',
                      background: c.alignment === 'bullish' ? 'rgba(0,255,136,0.1)' : c.alignment === 'bearish' ? 'rgba(255,68,68,0.1)' : 'rgba(255,204,0,0.1)',
                    }}
                  >
                    {c.alignment === 'bullish' ? 'BULL' : c.alignment === 'bearish' ? 'BEAR' : c.alignment === 'neutral' ? 'NEU' : '—'}
                  </span>
                </td>
                {/* ADX */}
                <td className="py-2">
                  <span
                    className="font-mono text-[10px]"
                    style={{
                      color: (c.adx ?? 0) >= 25 ? '#00ff88' : (c.adx ?? 0) >= 18 ? '#ffcc00' : '#555577',
                    }}
                  >
                    {c.adx != null ? Math.round(c.adx) : '—'}
                  </span>
                </td>
                {/* Z-Score */}
                <td className="py-2">
                  <span
                    className="font-mono text-[10px]"
                    style={{
                      color: Math.abs(c.zScore ?? 0) > 2 ? '#ff4444' : Math.abs(c.zScore ?? 0) > 1.5 ? '#ffcc00' : '#8888aa',
                    }}
                  >
                    {c.zScore != null ? (c.zScore >= 0 ? '+' : '') + c.zScore.toFixed(1) : '—'}
                  </span>
                </td>
                <td className={`py-2 font-semibold tabular-nums ${
                  c.equityScore >= 70 ? 'text-[#00ff88]' :
                  c.equityScore >= 40 ? 'text-yellow-400' :
                  'text-text-muted'
                }`}>
                  {c.equityScore}
                </td>
                <td className="py-2">
                  <button
                    onClick={() => handleAnalyze(c.symbol)}
                    disabled={equityAnalysisLoading}
                    className="px-4 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all duration-200 bg-[#00ff88]/10 border border-[#00ff88]/30 text-[#00ff88] hover:bg-[#00ff88]/20 hover:border-[#00ff88]/50 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {equityAnalysisLoading ? '...' : 'Analisar'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// frontend/src/components/equity/EquityScreenerPanel.tsx
import { useMarketStore } from '../../store/marketStore'
import { supabase } from '../../lib/supabase'
import { getApiBase } from '../../lib/apiBase'
import type { EquityAnalysis } from '../../store/marketStore'

export function EquityScreenerPanel() {
  const { equityCandidates, equityMarketOpen, equityAnalysisLoading, setEquityAnalysis, setEquityAnalysisLoading } = useMarketStore()

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

      {/* Filtros ativos */}
      <div className="flex gap-1.5 flex-wrap mb-3">
        {['$2–$20', 'RVOL >2x', 'Vol >300k', 'Var >3%'].map((f) => (
          <span key={f} className="text-[10px] bg-bg-elevated text-text-secondary px-2 py-0.5 rounded">{f}</span>
        ))}
      </div>

      {equityCandidates.length === 0 ? (
        <div className="text-sm text-text-muted text-center py-6">
          {equityMarketOpen ? 'Nenhum candidato no momento' : 'Aguardando abertura do mercado'}
        </div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-muted uppercase text-[10px]">
              <td className="pb-2">Ticker</td>
              <td className="pb-2">Preço</td>
              <td className="pb-2">Var%</td>
              <td className="pb-2">RVOL</td>
              <td className="pb-2"></td>
            </tr>
          </thead>
          <tbody>
            {equityCandidates.map((c) => (
              <tr key={c.symbol} className="border-t border-border-subtle">
                <td className="py-2 font-bold text-text-primary">
                  {c.symbol}
                  {c.hasCatalyst && <span className="ml-1 text-[9px] text-yellow-500">📰</span>}
                </td>
                <td className="py-2 text-text-secondary">${c.price.toFixed(2)}</td>
                <td className={`py-2 font-medium ${c.change >= 0 ? 'text-[#00ff88]' : 'text-red-400'}`}>
                  {c.change >= 0 ? '+' : ''}{c.change.toFixed(1)}%
                </td>
                <td className={`py-2 ${c.rvol >= 4 ? 'text-red-400' : c.rvol >= 2 ? 'text-yellow-500' : 'text-text-secondary'}`}>
                  {c.rvol}x
                </td>
                <td className="py-2">
                  <button
                    onClick={() => handleAnalyze(c.symbol)}
                    disabled={equityAnalysisLoading}
                    className="text-[10px] bg-[#00ff88]/10 text-[#00ff88] px-2 py-0.5 rounded hover:bg-[#00ff88]/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {equityAnalysisLoading ? '...' : '🤖 Analisar'}
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

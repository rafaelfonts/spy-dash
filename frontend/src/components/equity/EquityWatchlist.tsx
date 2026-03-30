// frontend/src/components/equity/EquityWatchlist.tsx
import { useState } from 'react'
import { useMarketStore } from '../../store/marketStore'
import type { AnalysisStructuredEquity as EquityAnalysis } from '../../store/marketStore'
import { supabase } from '../../lib/supabase'
import { getApiBase } from '../../lib/apiBase'

export function EquityWatchlist() {
  const {
    equityWatchlist, equityCandidates, setEquityWatchlist,
    analyzingSymbol, setAnalyzingSymbol, setEquityAnalysis, setEquityAnalysisLoading,
  } = useMarketStore()
  const [adding, setAdding] = useState(false)
  const [newSymbol, setNewSymbol] = useState('')

  function getPriceForSymbol(symbol: string) {
    return equityCandidates.find((c) => c.symbol === symbol)
  }

  async function handleAdd() {
    if (!newSymbol.trim()) return
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token ?? ''
    const res = await fetch(`${getApiBase()}/api/equity/watchlist`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: newSymbol.trim().toUpperCase() }),
    })
    if (res.ok) {
      const item = await res.json()
      setEquityWatchlist([...equityWatchlist, item])
      setNewSymbol('')
      setAdding(false)
    }
  }

  async function handleAnalyze(symbol: string) {
    setEquityAnalysisLoading(true)
    setAnalyzingSymbol(symbol)
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
        const body = await res.json()
        const data: EquityAnalysis = body.analysis ?? body
        setEquityAnalysis(data)
        setTimeout(() => document.getElementById('equity-ai-analysis')?.scrollIntoView({ behavior: 'smooth' }), 100)
      }
    } finally {
      setEquityAnalysisLoading(false)
      setAnalyzingSymbol(null)
    }
  }

  async function handleRemove(symbol: string) {
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token ?? ''
    await fetch(`${getApiBase()}/api/equity/watchlist/${symbol}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    setEquityWatchlist(equityWatchlist.filter((w) => w.symbol !== symbol))
  }

  return (
    <div className="card">
      <div className="text-sm font-display font-bold text-text-primary mb-3">Watchlist</div>

      {equityWatchlist.length === 0 && !adding ? (
        <div className="text-sm text-text-muted text-center py-4">Nenhuma ação monitorada</div>
      ) : (
        <table className="w-full text-xs mb-2">
          <thead>
            <tr className="text-text-muted uppercase text-[10px]">
              <td className="pb-2">Ticker</td>
              <td className="pb-2">Preço</td>
              <td className="pb-2">Var%</td>
              <td className="pb-2">Alerta</td>
              <td className="pb-2"></td>
              <td className="pb-2"></td>
            </tr>
          </thead>
          <tbody>
            {equityWatchlist.map((w) => {
              const live = getPriceForSymbol(w.symbol)
              return (
                <tr key={w.symbol} className="border-t border-border-subtle">
                  <td className="py-2 font-bold text-text-primary">{w.symbol}</td>
                  <td className="py-2 text-text-secondary">{live ? `$${live.price.toFixed(2)}` : '—'}</td>
                  <td className={`py-2 ${live && live.change >= 0 ? 'text-[#00ff88]' : 'text-red-400'}`}>
                    {live ? `${live.change >= 0 ? '+' : ''}${live.change.toFixed(1)}%` : '—'}
                  </td>
                  <td className="py-2 text-yellow-500 text-[10px]">
                    {w.alert_price ? `$${w.alert_price} ${w.alert_direction === 'above' ? '↑' : '↓'}` : '—'}
                  </td>
                  <td className="py-2">
                    <button
                      onClick={() => handleAnalyze(w.symbol)}
                      disabled={analyzingSymbol !== null}
                      className="px-3 py-1 rounded text-[11px] font-semibold transition-all bg-[#00ff88]/10 border border-[#00ff88]/30 text-[#00ff88] hover:bg-[#00ff88]/20 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {analyzingSymbol === w.symbol ? '...' : 'Analisar'}
                    </button>
                  </td>
                  <td className="py-2 pl-1">
                    <button onClick={() => handleRemove(w.symbol)} className="text-text-muted hover:text-red-400 text-[11px]">✕</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {adding ? (
        <div className="flex gap-2 mt-1">
          <input
            value={newSymbol}
            onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
            placeholder="Ex: SOUN"
            maxLength={5}
            className="flex-1 bg-bg-elevated border border-border-subtle rounded px-2 py-1 text-xs text-text-primary uppercase"
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          />
          <button onClick={handleAdd} className="text-xs bg-[#00ff88] text-black px-3 py-1 rounded font-bold">OK</button>
          <button onClick={() => setAdding(false)} className="text-xs text-text-muted px-2">✕</button>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="text-xs text-[#00ff88] mt-1 hover:underline">
          + Adicionar
        </button>
      )}
    </div>
  )
}

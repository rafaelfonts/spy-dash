// frontend/src/components/equity/EquityWatchlist.tsx
import { useState } from 'react'
import { useMarketStore } from '../../store/marketStore'
import { supabase } from '../../lib/supabase'
import { getApiBase } from '../../lib/apiBase'

export function EquityWatchlist() {
  const { equityWatchlist, equityCandidates, setEquityWatchlist } = useMarketStore()
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
    <div className="bg-[#111] border border-[#222] rounded-xl p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">Watchlist</div>

      {equityWatchlist.length === 0 && !adding ? (
        <div className="text-sm text-gray-600 text-center py-4">Nenhuma ação monitorada</div>
      ) : (
        <table className="w-full text-xs mb-2">
          <thead>
            <tr className="text-gray-600 uppercase text-[10px]">
              <td className="pb-2">Ticker</td>
              <td className="pb-2">Preço</td>
              <td className="pb-2">Var%</td>
              <td className="pb-2">Alerta</td>
              <td className="pb-2"></td>
            </tr>
          </thead>
          <tbody>
            {equityWatchlist.map((w) => {
              const live = getPriceForSymbol(w.symbol)
              return (
                <tr key={w.symbol} className="border-t border-[#1e1e1e]">
                  <td className="py-2 font-bold text-white">{w.symbol}</td>
                  <td className="py-2 text-gray-300">{live ? `$${live.price.toFixed(2)}` : '—'}</td>
                  <td className={`py-2 ${live && live.change >= 0 ? 'text-[#00ff88]' : 'text-red-400'}`}>
                    {live ? `${live.change >= 0 ? '+' : ''}${live.change.toFixed(1)}%` : '—'}
                  </td>
                  <td className="py-2 text-yellow-500 text-[10px]">
                    {w.alert_price ? `$${w.alert_price} ${w.alert_direction === 'above' ? '↑' : '↓'}` : '—'}
                  </td>
                  <td className="py-2">
                    <button onClick={() => handleRemove(w.symbol)} className="text-gray-600 hover:text-red-400 text-[11px]">✕</button>
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
            className="flex-1 bg-[#1a1a1a] border border-[#333] rounded px-2 py-1 text-xs text-white uppercase"
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          />
          <button onClick={handleAdd} className="text-xs bg-[#00ff88] text-black px-3 py-1 rounded font-bold">OK</button>
          <button onClick={() => setAdding(false)} className="text-xs text-gray-500 px-2">✕</button>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="text-xs text-[#00ff88] mt-1 hover:underline">
          + Adicionar
        </button>
      )}
    </div>
  )
}

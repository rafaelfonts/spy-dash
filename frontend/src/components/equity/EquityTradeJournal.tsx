// frontend/src/components/equity/EquityTradeJournal.tsx
import { useMarketStore } from '../../store/marketStore'
import { supabase } from '../../lib/supabase'
import { getApiBase } from '../../lib/apiBase'
import type { EquityTrade } from '../../store/marketStore'

interface Props {
  selectedMonth: string
  onMonthChange: (month: string) => void
  onRefresh: () => void
}

export function EquityTradeJournal({ selectedMonth, onMonthChange, onRefresh }: Props) {
  const { equityTrades, setEquityTrades } = useMarketStore()

  async function handleClose(trade: EquityTrade) {
    const exitPrice = prompt(`Preço de saída para ${trade.symbol}:`)
    if (!exitPrice) return
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token ?? ''
    const res = await fetch(`${getApiBase()}/api/equity/trades/${trade.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        exit_date: new Date().toISOString().split('T')[0],
        exit_price: parseFloat(exitPrice),
      }),
    })
    if (res.ok) onRefresh()
  }

  async function handleDelete(id: string) {
    if (!confirm('Remover este trade?')) return
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token ?? ''
    await fetch(`${getApiBase()}/api/equity/trades/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    setEquityTrades(equityTrades.filter((t) => t.id !== id))
  }

  return (
    <div className="bg-[#111] border border-[#222] rounded-xl p-4">
      <div className="flex items-center gap-3 mb-3">
        <div className="text-xs text-text-muted uppercase tracking-wide">Diário de Operações</div>
        <input
          type="month"
          value={selectedMonth}
          onChange={(e) => onMonthChange(e.target.value)}
          className="ml-auto bg-[#1a1a1a] border border-[#333] rounded px-2 py-0.5 text-xs text-text-secondary"
        />
      </div>

      {equityTrades.length === 0 ? (
        <div className="text-sm text-text-muted text-center py-6">Nenhuma operação registrada neste mês</div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-muted uppercase text-[10px]">
              <td className="pb-2">Data</td>
              <td className="pb-2">Ticker</td>
              <td className="pb-2">Entrada</td>
              <td className="pb-2">Saída</td>
              <td className="pb-2">Qtd</td>
              <td className="pb-2">P&L</td>
              <td className="pb-2">Status</td>
              <td className="pb-2"></td>
            </tr>
          </thead>
          <tbody>
            {equityTrades.map((t) => (
              <tr key={t.id} className="border-t border-[#1e1e1e]">
                <td className="py-2 text-text-muted">{t.entry_date}</td>
                <td className="py-2 font-bold text-text-primary">{t.symbol}</td>
                <td className="py-2 text-text-secondary">${t.entry_price.toFixed(2)}</td>
                <td className="py-2 text-text-secondary">{t.exit_price ? `$${t.exit_price.toFixed(2)}` : '—'}</td>
                <td className="py-2 text-text-muted">{t.quantity}</td>
                <td className={`py-2 font-bold ${t.pnl == null ? 'text-text-muted' : t.pnl >= 0 ? 'text-[#00ff88]' : 'text-red-400'}`}>
                  {t.pnl == null ? '—' : `${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}`}
                </td>
                <td className="py-2">
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${
                    t.status === 'closed'
                      ? 'bg-[#00ff88]/10 text-[#00ff88]'
                      : 'bg-yellow-500/10 text-yellow-500'
                  }`}>
                    {t.status === 'closed' ? 'Fechada' : 'Aberta'}
                  </span>
                </td>
                <td className="py-2 flex gap-1">
                  {t.status === 'open' && (
                    <button onClick={() => handleClose(t)} className="text-[10px] text-[#00ff88] hover:underline">Fechar</button>
                  )}
                  <button onClick={() => handleDelete(t.id)} className="text-[10px] text-text-muted hover:text-red-400 ml-1">✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

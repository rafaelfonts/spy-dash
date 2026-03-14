// frontend/src/components/equity/EquityMetricsBar.tsx
import { useMarketStore } from '../../store/marketStore'

interface Props { onAddTrade: () => void }

export function EquityMetricsBar({ onAddTrade }: Props) {
  const { equityTrades } = useMarketStore()

  const currentMonth = new Date().toISOString().slice(0, 7)
  const monthTrades = equityTrades.filter((t) => t.entry_date.startsWith(currentMonth))
  const closedTrades = monthTrades.filter((t) => t.status === 'closed')
  const pnlTotal = closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
  const winners = closedTrades.filter((t) => (t.pnl ?? 0) > 0)
  const winRate = closedTrades.length > 0 ? Math.round((winners.length / closedTrades.length) * 100) : 0
  const bestTrade = closedTrades.reduce<typeof closedTrades[0] | null>((best, t) =>
    !best || (t.pnl ?? 0) > (best.pnl ?? 0) ? t : best, null)

  const metaCount = 2
  const metaReached = closedTrades.length >= metaCount

  return (
    <div className="bg-[#111] border border-[#222] rounded-xl p-4 flex flex-wrap items-center gap-6">
      {/* Operações / Meta */}
      <div className="text-center">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Operações/Mês</div>
        <div className="text-3xl font-bold text-[#00ff88]">
          {closedTrades.length}
          <span className="text-base text-gray-600">/{metaCount}</span>
        </div>
        {metaReached ? (
          <div className="text-xs text-[#00ff88] mt-0.5">✅ Meta atingida</div>
        ) : (
          <div className="text-xs text-yellow-500 mt-0.5">⚠ Falta {metaCount - closedTrades.length}</div>
        )}
      </div>

      <div className="w-px h-10 bg-[#333]" />

      {/* P&L */}
      <div className="text-center">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">P&L Mês</div>
        <div className={`text-2xl font-bold ${pnlTotal >= 0 ? 'text-[#00ff88]' : 'text-red-400'}`}>
          {pnlTotal >= 0 ? '+' : ''}${pnlTotal.toFixed(2)}
        </div>
        <div className="text-xs text-gray-500 mt-0.5">Win rate: {winRate}%</div>
      </div>

      <div className="w-px h-10 bg-[#333]" />

      {/* Melhor trade */}
      <div className="text-center">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Melhor Trade</div>
        {bestTrade ? (
          <>
            <div className="text-base font-bold text-white">
              {bestTrade.symbol} <span className="text-[#00ff88]">+${(bestTrade.pnl ?? 0).toFixed(2)}</span>
            </div>
            <div className="text-xs text-gray-500 mt-0.5">{bestTrade.exit_date ?? bestTrade.entry_date}</div>
          </>
        ) : (
          <div className="text-sm text-gray-600">—</div>
        )}
      </div>

      <div className="flex-1" />

      <button
        onClick={onAddTrade}
        className="px-4 py-2 bg-[#00ff88] text-black font-bold rounded-lg text-sm hover:bg-[#00cc6e] transition-colors"
      >
        + Registrar Trade
      </button>
    </div>
  )
}

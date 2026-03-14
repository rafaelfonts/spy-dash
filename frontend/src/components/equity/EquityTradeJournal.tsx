// frontend/src/components/equity/EquityTradeJournal.tsx
// Stub — full implementation in a future task
interface Props {
  selectedMonth: string
  onMonthChange: (month: string) => void
  onRefresh: () => void
}

export function EquityTradeJournal({ selectedMonth, onMonthChange, onRefresh }: Props) {
  return (
    <div className="bg-[#111] border border-[#222] rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-gray-500 uppercase tracking-wide">Diário de Trades</div>
        <div className="flex items-center gap-2">
          <input
            type="month"
            value={selectedMonth}
            onChange={(e) => onMonthChange(e.target.value)}
            className="text-xs bg-[#1a1a1a] border border-[#333] rounded px-2 py-0.5 text-gray-300"
          />
          <button onClick={onRefresh} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">↻</button>
        </div>
      </div>
      <div className="text-sm text-gray-600 text-center py-6">Em construção</div>
    </div>
  )
}

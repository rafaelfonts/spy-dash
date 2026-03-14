// frontend/src/components/equity/AddEquityTradeModal.tsx
// Stub — full implementation in a future task
interface Props {
  onClose: () => void
  onSuccess: () => void
}

export function AddEquityTradeModal({ onClose, onSuccess }: Props) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#111] border border-[#222] rounded-xl p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-bold text-white">Registrar Trade</div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">×</button>
        </div>
        <div className="text-sm text-gray-600 text-center py-6">Em construção</div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-300 transition-colors">Cancelar</button>
          <button onClick={onSuccess} className="px-3 py-1.5 text-sm bg-[#00ff88] text-black font-bold rounded hover:bg-[#00cc6e] transition-colors">Salvar</button>
        </div>
      </div>
    </div>
  )
}

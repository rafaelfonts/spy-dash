// frontend/src/components/equity/AddEquityTradeModal.tsx
import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { getApiBase } from '../../lib/apiBase'
import { useMarketStore } from '../../store/marketStore'

interface Props {
  onClose: () => void
  onSuccess: () => void
}

export function AddEquityTradeModal({ onClose, onSuccess }: Props) {
  const { equityAnalysis } = useMarketStore()
  const today = new Date().toISOString().split('T')[0]

  const [form, setForm] = useState({
    symbol: equityAnalysis?.symbol ?? '',
    entry_date: today,
    entry_price: '',
    quantity: '',
    notes: '',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit() {
    if (!form.symbol || !form.entry_price || !form.quantity) {
      setError('Preencha todos os campos obrigatórios')
      return
    }
    setLoading(true)
    setError('')
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token ?? ''
    const res = await fetch(`${getApiBase()}/api/equity/trades`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: form.symbol.toUpperCase(),
        entry_date: form.entry_date,
        entry_price: parseFloat(form.entry_price),
        quantity: parseInt(form.quantity, 10),
        notes: form.notes || undefined,
      }),
    })
    setLoading(false)
    if (res.ok) onSuccess()
    else setError('Erro ao registrar trade')
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-[#111] border border-[#333] rounded-xl p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-white">Registrar Trade</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white">✕</button>
        </div>

        <div className="space-y-3">
          {[
            { label: 'Ticker *', key: 'symbol', placeholder: 'Ex: SOUN', upper: true },
            { label: 'Data de entrada *', key: 'entry_date', type: 'date' },
            { label: 'Preço de entrada *', key: 'entry_price', placeholder: 'Ex: 7.10', type: 'number' },
            { label: 'Quantidade *', key: 'quantity', placeholder: 'Ex: 7', type: 'number' },
            { label: 'Notas', key: 'notes', placeholder: 'Opcional' },
          ].map(({ label, key, placeholder, type = 'text', upper }) => (
            <div key={key}>
              <label className="text-xs text-gray-500 block mb-1">{label}</label>
              <input
                type={type}
                value={(form as Record<string, string>)[key]}
                placeholder={placeholder}
                onChange={(e) => setForm({ ...form, [key]: upper ? e.target.value.toUpperCase() : e.target.value })}
                className="w-full bg-[#1a1a1a] border border-[#333] rounded px-3 py-2 text-sm text-white"
              />
            </div>
          ))}
        </div>

        {error && <div className="text-red-400 text-xs mt-3">{error}</div>}

        <div className="flex gap-2 mt-4">
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="flex-1 bg-[#00ff88] text-black font-bold py-2 rounded-lg text-sm disabled:opacity-50"
          >
            {loading ? 'Registrando...' : 'Registrar'}
          </button>
          <button onClick={onClose} className="px-4 py-2 bg-[#1a1a1a] text-gray-400 rounded-lg text-sm">Cancelar</button>
        </div>
      </div>
    </div>
  )
}

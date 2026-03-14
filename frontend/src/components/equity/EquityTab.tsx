// frontend/src/components/equity/EquityTab.tsx
import { useEffect } from 'react'
import { useState } from 'react'
import { useMarketStore } from '../../store/marketStore'
import { supabase } from '../../lib/supabase'
import { getApiBase } from '../../lib/apiBase'
import { EquityMetricsBar } from './EquityMetricsBar'
import { EquityScreenerPanel } from './EquityScreenerPanel'
import { EquityWatchlist } from './EquityWatchlist'
import { EquityAIAnalysis } from './EquityAIAnalysis'
import { EquityTradeJournal } from './EquityTradeJournal'
import { AddEquityTradeModal } from './AddEquityTradeModal'

async function fetchWithToken(url: string, options: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token ?? ''
  return fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  })
}

export function EquityTab() {
  const [showAddModal, setShowAddModal] = useState(false)
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })

  const { setEquityTrades, setEquityWatchlist, equityAnalysis } = useMarketStore()

  async function loadData() {
    const base = getApiBase()
    fetchWithToken(`${base}/api/equity/trades?month=${selectedMonth}`)
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setEquityTrades(data) })
      .catch(() => {})

    fetchWithToken(`${base}/api/equity/watchlist`)
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setEquityWatchlist(data) })
      .catch(() => {})
  }

  useEffect(() => {
    loadData()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMonth])

  async function refreshTrades() {
    const base = getApiBase()
    fetchWithToken(`${base}/api/equity/trades?month=${selectedMonth}`)
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setEquityTrades(data) })
      .catch(() => {})
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-4 space-y-4">
      <EquityMetricsBar onAddTrade={() => setShowAddModal(true)} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <EquityScreenerPanel />
        <EquityWatchlist />
      </div>

      {(equityAnalysis) && <EquityAIAnalysis onRegisterTrade={() => setShowAddModal(true)} />}

      <EquityTradeJournal
        selectedMonth={selectedMonth}
        onMonthChange={setSelectedMonth}
        onRefresh={refreshTrades}
      />

      {showAddModal && (
        <AddEquityTradeModal
          onClose={() => setShowAddModal(false)}
          onSuccess={() => {
            setShowAddModal(false)
            refreshTrades()
          }}
        />
      )}
    </div>
  )
}

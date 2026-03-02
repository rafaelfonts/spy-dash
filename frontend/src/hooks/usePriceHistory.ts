import { useEffect, useRef } from 'react'
import { useMarketStore } from '../store/marketStore'
import type { PricePoint } from '../store/marketStore'
import { supabase } from '../lib/supabase'
import { getApiBase } from '../lib/apiBase'

interface PriceMinute {
  minute: string
  price_avg: string
}

async function fetchHistory(symbol: string, minutes: number): Promise<PricePoint[]> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  const authHeader = session?.access_token ? `Bearer ${session.access_token}` : ''

  const res = await fetch(`${getApiBase()}/api/price-history?symbol=${symbol}&minutes=${minutes}`, {
    headers: authHeader ? { Authorization: authHeader } : {},
  })
  if (!res.ok) return []

  const json = (await res.json()) as { data: PriceMinute[] }
  return (json.data ?? []).map((d) => ({
    t: new Date(d.minute).getTime(),
    p: parseFloat(d.price_avg),
  }))
}

export function usePriceHistory(): void {
  const updateSPY = useMarketStore((s) => s.updateSPY)
  const updateVIX = useMarketStore((s) => s.updateVIX)
  const didFetch = useRef(false)

  useEffect(() => {
    if (didFetch.current) return
    didFetch.current = true

    async function prefill() {
      const [spyHistory, vixHistory] = await Promise.all([
        fetchHistory('SPY', 60),
        fetchHistory('VIX', 60),
      ])

      if (spyHistory.length > 0) {
        updateSPY({ priceHistory: spyHistory })
      }
      if (vixHistory.length > 0) {
        updateVIX({ priceHistory: vixHistory })
      }
    }

    prefill().catch(console.error)
  }, [updateSPY, updateVIX])
}

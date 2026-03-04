import { useState, useCallback, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { getApiBase } from '../lib/apiBase'

export interface EnrichedPosition {
  id: string
  strategy: string
  dte_current: number
  profit_percentage: number
  credit_received: number
  current_cost_to_close: number
}

export interface PortfolioAlert {
  position_id?: string
  recommendation: string
  message: string
}

interface PortfolioSnapshot {
  positions: EnrichedPosition[]
  capturedAt: string | null
}

async function authFetch(url: string, options?: RequestInit): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession()
  const headers: HeadersInit = {
    ...(options?.headers ?? {}),
  }
  if (session?.access_token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${session.access_token}`
  }
  return fetch(url, { ...options, headers })
}

export function usePortfolio() {
  const [snapshot, setSnapshot] = useState<PortfolioSnapshot>({ positions: [], capturedAt: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [alerts, setAlerts] = useState<PortfolioAlert[]>([])
  const [analyzing, setAnalyzing] = useState(false)

  const fetchSnapshot = useCallback(async () => {
    setError(null)
    try {
      const res = await authFetch(`${getApiBase()}/api/portfolio`)
      if (!res.ok) throw new Error('Falha ao carregar carteira')
      const data = (await res.json()) as PortfolioSnapshot
      setSnapshot({ positions: data.positions ?? [], capturedAt: data.capturedAt ?? null })
    } catch (e) {
      setError((e as Error).message)
      setSnapshot({ positions: [], capturedAt: null })
    } finally {
      setLoading(false)
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await authFetch(`${getApiBase()}/api/portfolio/refresh`, { method: 'POST' })
      if (!res.ok) throw new Error('Falha ao atualizar')
      const data = (await res.json()) as PortfolioSnapshot
      setSnapshot({ positions: data.positions ?? [], capturedAt: data.capturedAt ?? null })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  const analyze = useCallback(async () => {
    setAnalyzing(true)
    setAlerts([])
    setError(null)
    try {
      const res = await authFetch(`${getApiBase()}/api/portfolio/analyze`, { method: 'POST' })
      const data = (await res.json()) as { alerts?: PortfolioAlert[]; error?: string }
      if (!res.ok) {
        throw new Error(data.error ?? 'Falha na análise')
      }
      setAlerts(data.alerts ?? [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAnalyzing(false)
    }
  }, [])

  useEffect(() => {
    fetchSnapshot()
  }, [fetchSnapshot])

  return {
    positions: snapshot.positions,
    capturedAt: snapshot.capturedAt,
    loading,
    error,
    refresh,
    analyze,
    alerts,
    analyzing,
  }
}

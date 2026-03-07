import { useState, useCallback, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { getApiBase } from '../lib/apiBase'

export interface EnrichedPosition {
  id: string
  strategy: string
  dte_current: number
  profit_percentage: number
  profit_loss_dollars?: number
  credit_received: number
  current_cost_to_close: number
  comments?: string
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

export interface CreatePositionBody {
  symbol: string
  strategy_type?: string
  open_date?: string
  expiration_date: string
  /** 2-leg (Put/Call Spread) */
  short_strike?: number
  long_strike?: number
  short_option_symbol?: string
  long_option_symbol?: string
  /** Iron Condor: 4 legs */
  put_short_strike?: number
  put_long_strike?: number
  put_short_option_symbol?: string
  put_long_option_symbol?: string
  call_short_strike?: number
  call_long_strike?: number
  call_short_option_symbol?: string
  call_long_option_symbol?: string
  credit_received: number
  comments?: string
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

  const createPosition = useCallback(async (body: CreatePositionBody): Promise<{ ok: boolean; error?: string }> => {
    setError(null)
    try {
      const res = await authFetch(`${getApiBase()}/api/portfolio/positions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) return { ok: false, error: data.error ?? 'Falha ao cadastrar' }
      return { ok: true }
    } catch (e) {
      const err = (e as Error).message
      setError(err)
      return { ok: false, error: err }
    }
  }, [])

  const deletePosition = useCallback(async (id: string): Promise<{ ok: boolean; error?: string }> => {
    setError(null)
    try {
      const res = await authFetch(`${getApiBase()}/api/portfolio/positions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const data = (await res.json()) as { error?: string }
        return { ok: false, error: data.error ?? 'Falha ao excluir' }
      }
      return { ok: true }
    } catch (e) {
      const err = (e as Error).message
      setError(err)
      return { ok: false, error: err }
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
    createPosition,
    deletePosition,
    analyze,
    alerts,
    analyzing,
  }
}

// frontend/src/hooks/useOptionScreener.ts

import { useMarketStore } from '../store/marketStore'
import { supabase } from '../lib/supabase'
import { getApiBase } from '../lib/apiBase'
import type { ScreenerPresetFE, DeltaProfileFE, OptionDeepDiveFE, OptionStrategyFE, OptionScanMetaFE, OptionCandidateFE } from '../store/marketStore'

async function getAuthHeader(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ? `Bearer ${session.access_token}` : ''
}

export function useOptionScreener() {
  const store = useMarketStore()
  const { optionScreener } = store

  async function runScan(preset?: ScreenerPresetFE) {
    store.setOptionScreenerStatus('scanning')
    store.setOptionScreenerError(null)
    if (preset !== undefined) store.setOptionScreenerPreset(preset)

    try {
      const authHeader = await getAuthHeader()
      const body: { preset?: ScreenerPresetFE; deltaProfile: DeltaProfileFE } = {
        deltaProfile: useMarketStore.getState().optionScreener.deltaProfile,
      }
      if (preset) body.preset = preset

      const res = await fetch(`${getApiBase()}/api/option-screener/scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const msg =
          res.status === 504 ? 'Tempo limite — selecione um preset específico e tente novamente' :
          res.status === 429 ? 'Limite de requisições atingido — aguarde 30s e tente novamente' :
          res.status === 401 ? 'Sessão expirada — faça login novamente' :
          `Erro no servidor (${res.status})`
        throw new Error(msg)
      }

      const json = await res.json() as {
        candidates: OptionCandidateFE[]
        scannedAt: number
        totalScanned: number
        passedFilters: number
        autoPreset?: ScreenerPresetFE
      }

      const meta: OptionScanMetaFE = {
        scannedAt: json.scannedAt,
        totalScanned: json.totalScanned,
        passedFilters: json.passedFilters,
        ...(json.autoPreset ? { autoPreset: json.autoPreset } : {}),
      }

      store.setOptionScreenerCandidates(json.candidates, meta)

      // Auto-select first candidate
      if (json.candidates.length > 0) {
        await analyzeSymbol(json.candidates[0].symbol)
      }
    } catch (err) {
      store.setOptionScreenerError(err instanceof Error ? err.message : 'Erro na varredura')
    }
  }

  async function analyzeSymbol(symbol: string) {
    // Clear previous analysis state, then set selected + analyzing
    store.resetOptionScreenerAnalysis()
    store.setOptionScreenerSelected(symbol)
    store.setOptionScreenerStatus('analyzing')

    try {
      const authHeader = await getAuthHeader()
      const res = await fetch(`${getApiBase()}/api/option-screener/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify({ symbol, deltaProfile: useMarketStore.getState().optionScreener.deltaProfile }),
      })

      if (!res.ok) {
        const msg =
          res.status === 504 ? 'Tempo limite ao carregar análise — tente novamente' :
          res.status === 429 ? 'Limite de requisições atingido — aguarde 30s e tente novamente' :
          res.status === 401 ? 'Sessão expirada — faça login novamente' :
          `Erro na análise (${res.status})`
        throw new Error(msg)
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error('No response stream')

      const decoder = new TextDecoder()
      let buffer = ''
      let currentEvent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            const dataStr = line.slice(6)
            try {
              const data = JSON.parse(dataStr)
              if (currentEvent === 'metrics') {
                store.setOptionScreenerDeepDive(data as OptionDeepDiveFE)
              } else if (currentEvent === 'token') {
                store.appendOptionScreenerToken(data as string)
              } else if (currentEvent === 'strategy') {
                store.setOptionScreenerStrategy(data as OptionStrategyFE)
              } else if (currentEvent === 'error') {
                store.setOptionScreenerError((data as { message: string }).message)
              }
            } catch {
              // Ignore parse errors on individual SSE lines
            }
          }
        }
      }
      store.setOptionScreenerStatus('results')
    } catch (err) {
      store.setOptionScreenerError(err instanceof Error ? err.message : 'Erro na análise')
    }
  }

  return {
    ...optionScreener,
    runScan,
    analyzeSymbol,
    setDeltaProfile: store.setOptionScreenerDeltaProfile,
  }
}

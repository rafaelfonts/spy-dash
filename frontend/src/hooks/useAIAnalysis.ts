import { useState, useCallback, useRef } from 'react'
import { useMarketStore } from '../store/marketStore'
import type { OptionExpiry } from '../store/marketStore'
import { supabase } from '../lib/supabase'

export type AnalysisState = 'idle' | 'loading' | 'streaming' | 'done' | 'error'

export interface UseAIAnalysis {
  text: string
  state: AnalysisState
  error: string | null
  cooldownSeconds: number
  analyze: () => void
  reset: () => void
}

interface FreshnessBlock {
  spy?: string
  vix?: string
  ivRank?: string
  optionChain?: string
  fearGreed?: string
  macro?: string
  bls?: string
  macroEvents?: string
  earnings?: string
}

function msToIso(ms: number): string | undefined {
  return ms > 0 ? new Date(ms).toISOString() : undefined
}

export function useAIAnalysis(): UseAIAnalysis {
  const [text, setText] = useState('')
  const [state, setState] = useState<AnalysisState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [cooldownSeconds, setCooldownSeconds] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const optionChainCapturedAtRef = useRef<number>(0)
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const spy = useMarketStore((s) => s.spy)
  const vix = useMarketStore((s) => s.vix)
  const ivRank = useMarketStore((s) => s.ivRank)
  const newsFeed = useMarketStore((s) => s.newsFeed)

  const analyze = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()

    setText('')
    setError(null)
    setState('loading')

    const marketSnapshot = {
      spy: spy.last
        ? { last: spy.last, change: spy.change ?? 0, changePct: spy.changePct ?? 0 }
        : undefined,
      vix: vix.last ? { last: vix.last, level: vix.level ?? 'unknown' } : undefined,
      ivRank: ivRank.value
        ? {
            value: ivRank.value,
            percentile: ivRank.percentile ?? 0,
            label: ivRank.label ?? 'unknown',
          }
        : undefined,
    }

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const authHeader = session?.access_token ? `Bearer ${session.access_token}` : ''
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {}),
      }

      // Busca a cadeia de opções (não-fatal: continua sem ela se falhar)
      let optionChain: OptionExpiry[] | undefined
      try {
        const chainRes = await fetch('/api/option-chain', {
          headers: authHeader ? { Authorization: authHeader } : {},
          signal: abortRef.current.signal,
        })
        if (chainRes.ok) {
          const chainJson = (await chainRes.json()) as { data: OptionExpiry[] }
          optionChain = chainJson.data
          optionChainCapturedAtRef.current = Date.now()
          useMarketStore.getState().setOptionChain(optionChain)
        }
      } catch {
        // Continua sem option chain
      }

      // Contexto do Feed de Mercado para enriquecer o prompt da IA
      const context = {
        fearGreed: newsFeed.fearGreed
          ? { score: newsFeed.fearGreed.score, label: newsFeed.fearGreed.label }
          : undefined,
        macro: newsFeed.macro.length > 0 ? newsFeed.macro : undefined,
        bls: newsFeed.bls.length > 0 ? newsFeed.bls : undefined,
        macroEvents: newsFeed.macroEvents.length > 0 ? newsFeed.macroEvents : undefined,
        earnings: newsFeed.earnings.length > 0 ? newsFeed.earnings : undefined,
      }

      // Timestamps de captura para cada bloco de dados — permitem ao backend
      // rotular a frescura de cada seção no prompt enviado ao GPT-4o
      const freshness: FreshnessBlock = {
        spy: msToIso(spy.lastUpdated),
        vix: msToIso(vix.lastUpdated),
        ivRank: msToIso(ivRank.lastUpdated),
        optionChain: msToIso(optionChainCapturedAtRef.current),
        // fearGreed tem seu próprio lastUpdated registrado no momento do poll
        fearGreed: newsFeed.fearGreed?.lastUpdated
          ? msToIso(newsFeed.fearGreed.lastUpdated)
          : undefined,
        // macro/bls/macroEvents/earnings compartilham newsFeed.lastUpdated no frontend
        // (o backend usa newsSnapshot.*Ts para maior granularidade no fallback sem payload)
        macro: msToIso(newsFeed.lastUpdated),
        bls: msToIso(newsFeed.lastUpdated),
        macroEvents: msToIso(newsFeed.lastUpdated),
        earnings: msToIso(newsFeed.lastUpdated),
      }

      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers,
        body: JSON.stringify({ marketSnapshot, optionChain, context, freshness }),
        signal: abortRef.current.signal,
      })

      if (res.status === 429) {
        const body = (await res.json()) as { retryAfter?: number }
        const seconds = body.retryAfter ?? 30
        setCooldownSeconds(seconds)
        cooldownTimerRef.current && clearInterval(cooldownTimerRef.current)
        cooldownTimerRef.current = setInterval(() => {
          setCooldownSeconds((prev) => {
            if (prev <= 1) {
              clearInterval(cooldownTimerRef.current!)
              cooldownTimerRef.current = null
              return 0
            }
            return prev - 1
          })
        }, 1000)
        setState('idle')
        return
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }

      if (!res.body) throw new Error('No response body')

      setState('streaming')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('event: token')) continue
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            try {
              const parsed = JSON.parse(data) as { text?: string }
              if (parsed.text) {
                setText((prev) => prev + parsed.text)
              }
            } catch {
              // skip
            }
          }
          if (line.startsWith('event: done')) {
            setState('done')
          }
          if (line.startsWith('event: error')) {
            const dataLine = lines[lines.indexOf(line) + 1] ?? ''
            try {
              const parsed = JSON.parse(dataLine.slice(6)) as { message?: string }
              throw new Error(parsed.message ?? 'AI analysis failed')
            } catch (e) {
              setError((e as Error).message)
              setState('error')
            }
          }
        }
      }

      setState('done')
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setError((err as Error).message)
      setState('error')
    }
  }, [spy, vix, ivRank, newsFeed])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    setText('')
    setError(null)
    setState('idle')
  }, [])

  return { text, state, error, cooldownSeconds, analyze, reset }
}

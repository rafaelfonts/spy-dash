import { useState, useCallback, useRef } from 'react'
import { useMarketStore } from '../store/marketStore'
import type { OptionExpiry, AnalysisStructuredOutput } from '../store/marketStore'
import { supabase } from '../lib/supabase'
import { getApiBase } from '../lib/apiBase'

export type AnalysisState = 'idle' | 'loading' | 'streaming' | 'done' | 'error'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export interface UseAIAnalysis {
  text: string
  state: AnalysisState
  error: string | null
  cooldownSeconds: number
  analyze: () => void
  reset: () => void
  structuredOutput: AnalysisStructuredOutput | null
  chatHistory: ChatMessage[]
  chatInput: string
  setChatInput: (v: string) => void
  isChatLoading: boolean
  isExpanded: boolean
  setExpanded: (v: boolean) => void
  sendChatMessage: () => void
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
}

function msToIso(ms: number): string | undefined {
  return ms > 0 ? new Date(ms).toISOString() : undefined
}

const MAX_FOLLOWUPS_PER_SESSION = 10

export function useAIAnalysis(): UseAIAnalysis {
  const [text, setText] = useState('')
  const [state, setState] = useState<AnalysisState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [cooldownSeconds, setCooldownSeconds] = useState(0)
  const [structuredOutput, setStructuredOutput] = useState<AnalysisStructuredOutput | null>(null)
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [isChatLoading, setChatLoading] = useState(false)
  const [isExpanded, setExpanded] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const optionChainCapturedAtRef = useRef<number>(0)
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const spy = useMarketStore((s) => s.spy)
  const vix = useMarketStore((s) => s.vix)
  const ivRank = useMarketStore((s) => s.ivRank)
  const newsFeed = useMarketStore((s) => s.newsFeed)
  const market = useMarketStore((s) => s.market)

  const analyze = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()

    setText('')
    setError(null)
    setStructuredOutput(null)
    setChatHistory([])
    setChatInput('')
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
        const chainRes = await fetch(`${getApiBase()}/api/option-chain`, {
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
        // macro/bls/macroEvents compartilham newsFeed.lastUpdated no frontend
        // (o backend usa newsSnapshot.*Ts para maior granularidade no fallback sem payload)
        macro: msToIso(newsFeed.lastUpdated),
        bls: msToIso(newsFeed.lastUpdated),
        macroEvents: msToIso(newsFeed.lastUpdated),
      }

      const res = await fetch(`${getApiBase()}/api/analyze`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ marketSnapshot, optionChain, context, freshness, market }),
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
      setExpanded(true)

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
          if (line.startsWith('event: structured')) {
            const dataLine = lines[lines.indexOf(line) + 1] ?? ''
            if (dataLine.startsWith('data: ')) {
              try {
                const parsed = JSON.parse(dataLine.slice(6)) as AnalysisStructuredOutput
                setStructuredOutput(parsed)
                useMarketStore.getState().setLastAnalysisOutput(parsed)
              } catch {
                // ignore malformed structured output
              }
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
    setStructuredOutput(null)
    setChatHistory([])
    setChatInput('')
    setExpanded(false)
  }, [])

  const sendChatMessage = useCallback(async () => {
    const so = useMarketStore.getState().lastAnalysisOutput ?? structuredOutput
    const trimmed = chatInput.trim()
    if (!so || !trimmed || isChatLoading) return
    if (chatHistory.filter((m) => m.role === 'user').length >= MAX_FOLLOWUPS_PER_SESSION) return

    const userMsg: ChatMessage = {
      role: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
    }
    setChatHistory((prev) => [...prev, userMsg])
    setChatInput('')
    setChatLoading(true)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const authHeader = session?.access_token ? `Bearer ${session.access_token}` : ''
      const historyForApi = [...chatHistory, userMsg]
        .slice(-6)
        .map((m) => ({ role: m.role, content: m.content }))

      const res = await fetch(`${getApiBase()}/api/chat-followup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify({
          question: trimmed,
          structuredOutput: so,
          chatHistory: historyForApi,
          market,
        }),
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let assistantContent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('event: token')) continue
          if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.slice(6).trim()) as { text?: string }
              if (parsed.text) {
                assistantContent += parsed.text
              }
            } catch {
              // skip
            }
          }
        }
      }

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: assistantContent,
        timestamp: new Date().toISOString(),
      }
      setChatHistory((prev) => [...prev, assistantMsg])
    } catch (err) {
      setChatHistory((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Erro: ${(err as Error).message}`,
          timestamp: new Date().toISOString(),
        },
      ])
    } finally {
      setChatLoading(false)
    }
  }, [chatInput, chatHistory, isChatLoading, structuredOutput])

  return {
    text,
    state,
    error,
    cooldownSeconds,
    analyze,
    reset,
    structuredOutput,
    chatHistory,
    chatInput,
    setChatInput,
    isChatLoading,
    isExpanded,
    setExpanded,
    sendChatMessage,
  }
}

import { useState, useCallback, useRef } from 'react'
import { useMarketStore } from '../store/marketStore'

export type AnalysisState = 'idle' | 'loading' | 'streaming' | 'done' | 'error'

export interface UseAIAnalysis {
  text: string
  state: AnalysisState
  error: string | null
  analyze: () => void
  reset: () => void
}

export function useAIAnalysis(): UseAIAnalysis {
  const [text, setText] = useState('')
  const [state, setState] = useState<AnalysisState>('idle')
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const spy = useMarketStore((s) => s.spy)
  const vix = useMarketStore((s) => s.vix)
  const ivRank = useMarketStore((s) => s.ivRank)

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
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketSnapshot }),
        signal: abortRef.current.signal,
      })

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
  }, [spy, vix, ivRank])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    setText('')
    setError(null)
    setState('idle')
  }, [])

  return { text, state, error, analyze, reset }
}

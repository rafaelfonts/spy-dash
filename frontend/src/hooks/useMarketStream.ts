import { useEffect, useRef } from 'react'
import { useMarketStore } from '../store/marketStore'
import { supabase } from '../lib/supabase'

const BASE_DELAY = 1000
const MAX_DELAY = 15_000

export function useMarketStream(): void {
  const updateSPY = useMarketStore((s) => s.updateSPY)
  const updateVIX = useMarketStore((s) => s.updateVIX)
  const updateIVRank = useMarketStore((s) => s.updateIVRank)
  const updateConnection = useMarketStore((s) => s.updateConnection)
  const updateNewsFeed = useMarketStore((s) => s.updateNewsFeed)

  const esRef = useRef<EventSource | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptsRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    async function connect() {
      if (!mountedRef.current) return

      updateConnection({ wsState: 'CONNECTING', connected: false })

      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const url = token
        ? `/stream/market?token=${encodeURIComponent(token)}`
        : '/stream/market'

      const es = new EventSource(url)
      esRef.current = es

      es.addEventListener('quote', (e) => {
        try {
          const data = JSON.parse(e.data)
          updateSPY({
            last: data.last,
            bid: data.bid,
            ask: data.ask,
            change: data.change,
            changePct: data.changePct,
            volume: data.volume,
            dayHigh: data.dayHigh,
            dayLow: data.dayLow,
            priceHistory: data.priceHistory ?? [],
          })
        } catch {
          // ignore parse errors
        }
      })

      es.addEventListener('vix', (e) => {
        try {
          const data = JSON.parse(e.data)
          updateVIX({
            last: data.last,
            change: data.change,
            changePct: data.changePct,
            level: data.level,
            priceHistory: data.priceHistory ?? [],
          })
        } catch {
          // ignore
        }
      })

      es.addEventListener('ivrank', (e) => {
        try {
          const data = JSON.parse(e.data)
          updateIVRank({
            value: data.ivRank,
            percentile: data.ivPercentile,
            label: data.label,
          })
        } catch {
          // ignore
        }
      })

      es.addEventListener('status', (e) => {
        try {
          const data = JSON.parse(e.data)
          updateConnection({
            wsState: data.wsState,
            connected: data.connected,
            reconnectAttempts: data.reconnectAttempts ?? 0,
          })
        } catch {
          // ignore
        }
      })

      es.addEventListener('newsfeed', (e) => {
        try {
          const payload = JSON.parse(e.data) as {
            type: string
            items?: unknown[]
            fearGreed?: unknown
            ts: number
          }
          if (payload.type === 'earnings') {
            updateNewsFeed({ earnings: payload.items as never, lastUpdated: payload.ts })
          } else if (payload.type === 'macro') {
            updateNewsFeed({ macro: payload.items as never, lastUpdated: payload.ts })
          } else if (payload.type === 'bls') {
            updateNewsFeed({ bls: payload.items as never, lastUpdated: payload.ts })
          } else if (payload.type === 'sentiment') {
            updateNewsFeed({ fearGreed: payload.fearGreed as never, lastUpdated: payload.ts })
          } else if (payload.type === 'macro-events') {
            updateNewsFeed({ macroEvents: payload.items as never, lastUpdated: payload.ts })
          } else if (payload.type === 'headlines') {
            updateNewsFeed({ headlines: payload.items as never, lastUpdated: payload.ts })
          }
        } catch {
          // ignore
        }
      })

      es.onopen = () => {
        attemptsRef.current = 0
        updateConnection({ wsState: 'OPEN', connected: true })
      }

      es.onerror = () => {
        es.close()
        esRef.current = null

        if (!mountedRef.current) return

        updateConnection({ wsState: 'RECONNECTING', connected: false })

        const delay = Math.min(BASE_DELAY * Math.pow(2, attemptsRef.current), MAX_DELAY)
        attemptsRef.current++

        timerRef.current = setTimeout(connect, delay)
      }
    }

    connect()

    return () => {
      mountedRef.current = false
      esRef.current?.close()
      esRef.current = null
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}

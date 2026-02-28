import { useEffect, useRef } from 'react'
import { useMarketStore } from '../store/marketStore'
import { supabase } from '../lib/supabase'

const BASE_DELAY = 1000
const MAX_DELAY = 15_000
const MAX_HISTORY = 390

// Derives WebSocket URL from the REST API base URL (env var VITE_API_URL).
// VITE_API_URL=https://api.spydash.fly.dev → wss://api.spydash.fly.dev/ws/ticks
// Falls back to same-origin when VITE_API_URL is not set (local dev without proxy).
function getWsUrl(token: string | undefined): string {
  const apiBase = import.meta.env.VITE_API_URL ?? ''
  const wsBase = apiBase
    ? apiBase.replace(/^https?/, (p) => (p === 'https' ? 'wss' : 'ws'))
    : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
  return token
    ? `${wsBase}/ws/ticks?token=${encodeURIComponent(token)}`
    : `${wsBase}/ws/ticks`
}

export function usePriceTicks(): void {
  const updateSPY = useMarketStore((s) => s.updateSPY)
  const updateVIX = useMarketStore((s) => s.updateVIX)

  const wsRef = useRef<WebSocket | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptsRef = useRef(0)
  const mountedRef = useRef(true)
  // Local history buffers — accumulate ticks in-hook, avoid re-sending full array each tick
  const spyHistoryRef = useRef<number[]>([])
  const vixHistoryRef = useRef<number[]>([])

  useEffect(() => {
    mountedRef.current = true

    async function connect() {
      if (!mountedRef.current) return
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const token = session?.access_token
      const url = getWsUrl(token)

      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string)

          if (msg.type === 'snapshot') {
            // Full state snapshot sent once on connect — initialise history buffers
            spyHistoryRef.current = msg.spy?.priceHistory ?? []
            vixHistoryRef.current = msg.vix?.priceHistory ?? []
            updateSPY({ ...msg.spy })
            updateVIX({ ...msg.vix })
            return
          }

          if (msg.t === 'q') {
            // SPY tick — accumulate priceHistory locally
            if (msg.l !== null) {
              spyHistoryRef.current.push(msg.l)
              if (spyHistoryRef.current.length > MAX_HISTORY) {
                spyHistoryRef.current.shift()
              }
            }
            updateSPY({
              last: msg.l,
              bid: msg.b,
              ask: msg.a,
              change: msg.c,
              changePct: msg.cp,
              volume: msg.v,
              dayHigh: msg.dh,
              dayLow: msg.dl,
              priceHistory: [...spyHistoryRef.current],
            })
          } else if (msg.t === 'v') {
            // VIX tick — accumulate priceHistory locally
            if (msg.l !== null) {
              vixHistoryRef.current.push(msg.l)
              if (vixHistoryRef.current.length > MAX_HISTORY) {
                vixHistoryRef.current.shift()
              }
            }
            updateVIX({
              last: msg.l,
              change: msg.c,
              changePct: msg.cp,
              priceHistory: [...vixHistoryRef.current],
            })
          }
        } catch {
          // ignore parse errors
        }
      }

      ws.onopen = () => {
        attemptsRef.current = 0
      }

      ws.onclose = () => {
        wsRef.current = null
        if (!mountedRef.current) return
        const delay = Math.min(BASE_DELAY * Math.pow(2, attemptsRef.current), MAX_DELAY)
        attemptsRef.current++
        timerRef.current = setTimeout(connect, delay)
      }

      ws.onerror = () => ws.close()
    }

    connect()

    return () => {
      mountedRef.current = false
      wsRef.current?.close()
      wsRef.current = null
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}

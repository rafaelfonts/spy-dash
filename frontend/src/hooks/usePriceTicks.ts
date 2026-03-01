import { useEffect, useRef } from 'react'
import { useMarketStore } from '../store/marketStore'
import type { PricePoint } from '../store/marketStore'
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
    ? apiBase.replace(/^https?/, (p: string) => (p === 'https' ? 'wss' : 'ws'))
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
  const spyHistoryRef = useRef<PricePoint[]>([])
  const vixHistoryRef = useRef<PricePoint[]>([])

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
            // Full state snapshot sent once on connect — initialise history buffers.
            spyHistoryRef.current = msg.spy?.priceHistory ?? []
            vixHistoryRef.current = msg.vix?.priceHistory ?? []
            // Always sync history buffers (arrays, not scalars).
            updateSPY({ priceHistory: [...spyHistoryRef.current] })
            updateVIX({ priceHistory: [...vixHistoryRef.current] })
            // Only apply scalar fields that are non-null — prevents overwriting a
            // previously restored price (from cache/DXFeed) with null from a backend
            // snapshot that arrived before restores completed.
            const { priceHistory: _sh, ...spyScalars } = (msg.spy ?? {}) as Record<string, unknown>
            const { priceHistory: _vh, ...vixScalars } = (msg.vix ?? {}) as Record<string, unknown>
            const spyNonNull = Object.fromEntries(Object.entries(spyScalars).filter(([, v]) => v !== null))
            const vixNonNull = Object.fromEntries(Object.entries(vixScalars).filter(([, v]) => v !== null))
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (Object.keys(spyNonNull).length) updateSPY(spyNonNull as any)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (Object.keys(vixNonNull).length) updateVIX(vixNonNull as any)
            return
          }

          // Ticks may arrive as a single object or an array (100ms batch window)
          const ticks = Array.isArray(msg) ? msg : [msg]
          for (const tick of ticks) {
            if (tick.t === 'q') {
              // SPY tick — accumulate priceHistory locally
              if (tick.l !== null) {
                spyHistoryRef.current.push({ t: tick.ts, p: tick.l })
                if (spyHistoryRef.current.length > MAX_HISTORY) {
                  spyHistoryRef.current.shift()
                }
              }
              updateSPY({
                // Only apply last when non-null — Quote/Summary-triggered ticks carry
                // l:null when market is closed; must not clear a previously valid price.
                ...(tick.l !== null && { last: tick.l }),
                bid: tick.b,
                ask: tick.a,
                change: tick.c,
                changePct: tick.cp,
                volume: tick.v,
                dayHigh: tick.dh,
                dayLow: tick.dl,
                priceHistory: [...spyHistoryRef.current],
              })
            } else if (tick.t === 'v') {
              // VIX tick — accumulate priceHistory locally
              if (tick.l !== null) {
                vixHistoryRef.current.push({ t: tick.ts, p: tick.l })
                if (vixHistoryRef.current.length > MAX_HISTORY) {
                  vixHistoryRef.current.shift()
                }
              }
              updateVIX({
                // Same guard: don't clear a valid VIX price with a null tick.
                ...(tick.l !== null && { last: tick.l }),
                change: tick.c,
                changePct: tick.cp,
                priceHistory: [...vixHistoryRef.current],
              })
            }
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

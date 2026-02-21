import { useEffect, useRef } from 'react'
import { useMarketStore } from '../store/marketStore'

const BASE_DELAY = 1000
const MAX_DELAY = 15_000

export function useMarketStream(): void {
  const updateSPY = useMarketStore((s) => s.updateSPY)
  const updateVIX = useMarketStore((s) => s.updateVIX)
  const updateIVRank = useMarketStore((s) => s.updateIVRank)
  const updateConnection = useMarketStore((s) => s.updateConnection)

  const esRef = useRef<EventSource | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptsRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    function connect() {
      if (!mountedRef.current) return

      updateConnection({ wsState: 'CONNECTING', connected: false })

      const es = new EventSource('/stream/market')
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

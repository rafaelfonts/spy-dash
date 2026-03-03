import { useEffect, useRef } from 'react'
import { useMarketStore } from '../store/marketStore'
import type { GEXProfile } from '../store/marketStore'
import { supabase } from '../lib/supabase'
import { getApiBase } from '../lib/apiBase'

const BASE_DELAY = 1000
const MAX_DELAY = 15_000

export function useMarketStream(): void {
  const updateSPY = useMarketStore((s) => s.updateSPY)
  const updateVIX = useMarketStore((s) => s.updateVIX)
  const updateIVRank = useMarketStore((s) => s.updateIVRank)
  const updateConnection = useMarketStore((s) => s.updateConnection)
  const updateNewsFeed = useMarketStore((s) => s.updateNewsFeed)
  const applyNewsfeedBatch = useMarketStore((s) => s.applyNewsfeedBatch)
  const setGEXProfile = useMarketStore((s) => s.setGEXProfile)
  const setPutCallRatio = useMarketStore((s) => s.setPutCallRatio)
  const setVIXTermStructure = useMarketStore((s) => s.setVIXTermStructure)
  const setTechnicalIndicators = useMarketStore((s) => s.setTechnicalIndicators)
  const setPreMarketBriefing = useMarketStore((s) => s.setPreMarketBriefing)
  const setGEXByExpiration = useMarketStore((s) => s.setGEXByExpiration)
  const addAlert = useMarketStore((s) => s.addAlert)

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
        ? `${getApiBase()}/stream/market?token=${encodeURIComponent(token)}`
        : `${getApiBase()}/stream/market`

      const es = new EventSource(url)
      esRef.current = es

      es.addEventListener('ivrank', (e) => {
        try {
          const data = JSON.parse(e.data)
          updateIVRank({
            value: data.ivRank,
            percentile: data.ivPercentile,
            ivx: data.ivx ?? null,
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

      es.addEventListener('quote', (e) => {
        try {
          const data = JSON.parse(e.data)
          updateSPY({
            bid: data.bid,
            ask: data.ask,
            last: data.last,
            change: data.change,
            changePct: data.changePct,
            volume: data.volume,
            dayHigh: data.dayHigh,
            dayLow: data.dayLow,
          })
        } catch {
          // ignore
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
            _stale?: true
          }
          const stale = payload._stale === true
          const currentFlags = useMarketStore.getState().newsFeed.staleFlags
          if (payload.type === 'macro') {
            updateNewsFeed({
              macro: payload.items as never,
              lastUpdated: payload.ts,
              staleFlags: { ...currentFlags, macro: stale },
            })
          } else if (payload.type === 'bls') {
            updateNewsFeed({
              bls: payload.items as never,
              lastUpdated: payload.ts,
              staleFlags: { ...currentFlags, bls: stale },
            })
          } else if (payload.type === 'sentiment') {
            updateNewsFeed({
              fearGreed: payload.fearGreed as never,
              lastUpdated: payload.ts,
              staleFlags: { ...currentFlags, fearGreed: stale },
            })
          } else if (payload.type === 'macro-events') {
            updateNewsFeed({
              macroEvents: payload.items as never,
              lastUpdated: payload.ts,
              staleFlags: { ...currentFlags, macroEvents: stale },
            })
          } else if (payload.type === 'headlines') {
            updateNewsFeed({
              headlines: payload.items as never,
              lastUpdated: payload.ts,
              staleFlags: { ...currentFlags, headlines: stale },
            })
          }
        } catch {
          // ignore
        }
      })

      es.addEventListener('newsfeed-batch', (e) => {
        try {
          const { batch } = JSON.parse(e.data) as { batch: Record<string, any> };
          applyNewsfeedBatch(batch);
        } catch {
          // ignore parse errors
        }
      })

      es.addEventListener('advanced-metrics', (e) => {
        try {
          const data = JSON.parse(e.data) as {
            gex: {
              total: number
              callWall: number
              putWall: number
              zeroGamma: number | null
              flipPoint: number | null
              regime: 'positive' | 'negative'
              maxGexStrike: number
              minGexStrike: number
              expiration: string
              byStrike?: Array<{ strike: number; netGEX: number; callGEX: number; putGEX: number; callOI: number; putOI: number }>
            } | null
            putCallRatio: {
              ratio: number
              putVolume: number
              callVolume: number
              label: 'bearish' | 'neutral' | 'bullish'
              expiration: string
            } | null
            timestamp: string
          }
          if (data.gex) {
            setGEXProfile({
              byStrike: data.gex.byStrike ?? [],
              totalGEX: data.gex.total,
              flipPoint: data.gex.flipPoint,
              zeroGammaLevel: data.gex.zeroGamma,
              maxGammaStrike: data.gex.maxGexStrike,
              minGammaStrike: data.gex.minGexStrike,
              callWall: data.gex.callWall,
              putWall: data.gex.putWall,
              regime: data.gex.regime,
              calculatedAt: data.timestamp,
            })
          }
          if (data.putCallRatio) {
            setPutCallRatio({
              ratio: data.putCallRatio.ratio,
              putVolume: data.putCallRatio.putVolume,
              callVolume: data.putCallRatio.callVolume,
              label: data.putCallRatio.label,
              expiration: data.putCallRatio.expiration,
              lastUpdated: Date.now(),
            })
          }
          if ((data as any).gexByExpiration) {
            const byExp = (data as any).gexByExpiration
            const toProfile = (bucket: any): GEXProfile | null => {
              if (!bucket) return null
              return {
                byStrike: bucket.profile?.byStrike ?? [],
                totalGEX: bucket.totalNetGamma,
                flipPoint: bucket.flipPoint,
                zeroGammaLevel: bucket.zeroGammaLevel,
                maxGammaStrike: bucket.maxGexStrike,
                minGammaStrike: bucket.minGexStrike,
                callWall: bucket.callWall,
                putWall: bucket.putWall,
                regime: bucket.regime,
                calculatedAt: bucket.calculatedAt,
              }
            }
            setGEXByExpiration({
              dte0:  toProfile(byExp.dte0),
              dte1:  toProfile(byExp.dte1),
              dte7:  toProfile(byExp.dte7),
              dte21: toProfile(byExp.dte21),
              dte45: toProfile(byExp.dte45),
              all:   toProfile(byExp.all),
            })
          }
        } catch (err) {
          console.warn('[SSE] advanced-metrics parse error:', (err as Error).message)
        }
      })

      es.addEventListener('vix-term-structure', (e) => {
        try {
          const data = JSON.parse(e.data) as {
            spot: number
            curve: Array<{ dte: number; iv: number }>
            structure: 'contango' | 'backwardation' | 'flat'
            steepness: number
            capturedAt: string
          }
          setVIXTermStructure({ ...data, lastUpdated: Date.now() })
        } catch (err) {
          console.warn('[SSE] vix-term-structure parse error:', (err as Error).message)
        }
      })

      es.addEventListener('technical-indicators', (e) => {
        try {
          const data = JSON.parse(e.data)
          setTechnicalIndicators(data)
        } catch {
          // ignore parse errors
        }
      })

      es.addEventListener('briefing', (e) => {
        try {
          const data = JSON.parse(e.data)
          setPreMarketBriefing(data)
        } catch {
          // ignore parse errors
        }
      })

      es.addEventListener('alert', (e) => {
        try {
          const data = JSON.parse(e.data) as {
            level: number
            type: 'support' | 'resistance' | 'gex_flip'
            alertType: 'approaching' | 'testing'
            price: number
            timestamp: number
          }
          addAlert({
            id: Math.random().toString(36).slice(2),
            ...data,
          })
        } catch {
          // ignore
        }
      })

      es.addEventListener('ping', () => {
        // keep-alive event — connection is alive, no action needed
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

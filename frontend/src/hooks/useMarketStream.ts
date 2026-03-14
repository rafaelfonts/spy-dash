import { useEffect, useRef } from 'react'
import { useMarketStore, EquityCandidate } from '../store/marketStore'
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
  const setLastScheduledSignal = useMarketStore((s) => s.setLastScheduledSignal)
  const setGEXDynamic = useMarketStore((s) => s.setGEXDynamic)
  const setNoTrade = useMarketStore((s) => s.setNoTrade)
  const setDAN = useMarketStore((s) => s.setDAN)
  const setRVOL = useMarketStore((s) => s.setRVOL)
  const setSkewByDTE = useMarketStore((s) => s.setSkewByDTE)
  const setRegimePreview = useMarketStore((s) => s.setRegimePreview)
  const setMarketOpen = useMarketStore((s) => s.setMarketOpen)
  const addAlert = useMarketStore((s) => s.addAlert)
  const setEquityCandidates = useMarketStore((s) => s.setEquityCandidates)

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
              vannaExposure?: number
              charmExposure?: number
              volatilityTrigger?: number
            } | null
            putCallRatio: {
              entries: Array<{ tier: '0DTE' | 'Semanal' | 'Mensal'; expiration: string; ratio: number; putVolume: number; callVolume: number; sentimentLabel: 'bearish' | 'neutral' | 'bullish' }>
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
              totalVannaExposure: data.gex.vannaExposure,
              totalCharmExposure: data.gex.charmExposure,
              volatilityTrigger: data.gex.volatilityTrigger,
            })
          }
          if (data.putCallRatio) {
            setPutCallRatio({
              entries: data.putCallRatio.entries ?? [],
              lastUpdated: Date.now(),
            })
          }
          if ((data as any).gexDynamic) {
            const entries = (data as any).gexDynamic as Array<any>
            setGEXDynamic(entries.map((e: any) => ({
              expiration: e.expiration,
              dte: e.dte,
              isMonthlyOPEX: e.isMonthlyOPEX,
              isWeeklyOPEX: e.isWeeklyOPEX,
              label: e.label,
              gammaAnomaly: e.gammaAnomaly,
              gex: {
                byStrike: e.gex.profile?.byStrike ?? [],
                totalGEX: e.gex.totalNetGamma,
                flipPoint: e.gex.flipPoint,
                zeroGammaLevel: e.gex.zeroGammaLevel,
                maxGammaStrike: e.gex.maxGexStrike,
                minGammaStrike: e.gex.minGexStrike,
                callWall: e.gex.callWall,
                putWall: e.gex.putWall,
                regime: e.gex.regime,
                calculatedAt: e.gex.calculatedAt,
                totalVannaExposure: e.gex.totalVannaExposure,
                totalCharmExposure: e.gex.totalCharmExposure,
                volatilityTrigger: e.gex.volatilityTrigger,
                maxPain: e.gex.maxPain ?? null,
              },
            })))
          }
          if ((data as any).noTrade) {
            const nt = (data as any).noTrade
            setNoTrade({
              noTradeScore: nt.noTradeScore,
              activeVetos: nt.activeVetos ?? [],
              noTradeLevel: nt.noTradeLevel,
            })
          }
          if ((data as any).dan) {
            const d = (data as any).dan
            setDAN({
              callDAN: d.callDAN,
              putDAN: d.putDAN,
              netDAN: d.netDAN,
              danBias: d.danBias,
              callDominancePct: d.callDominancePct,
            })
          }
          if ((data as any).regimePreview) {
            const rp = (data as any).regimePreview
            setRegimePreview({
              score: rp.score,
              vannaRegime: rp.vannaRegime,
              charmPressure: rp.charmPressure,
              gexVsYesterday: rp.gexVsYesterday ?? null,
              priceDistribution: rp.priceDistribution ?? null,
            })
          }
          if (typeof (data as any).marketOpen === 'boolean') {
            setMarketOpen((data as any).marketOpen)
          }
          if ((data as any).rvol) {
            const rv = (data as any).rvol
            setRVOL({
              todayVolume: rv.todayVolume,
              avg20dVolume: rv.avg20dVolume,
              rvol: rv.rvol,
              rvolBias: rv.rvolBias,
              capturedAt: rv.capturedAt,
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
        } catch (err) {
          console.warn('[TechIndicators] SSE parse error:', err)
        }
      })

      es.addEventListener('skew', (e) => {
        try {
          const data = JSON.parse(e.data)
          setSkewByDTE(data)
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

      es.addEventListener('trade_signal_update', (e) => {
        try {
          const data = JSON.parse(e.data)
          setLastScheduledSignal(data)
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

      es.addEventListener('equity-screener', (e) => {
        try {
          const payload = JSON.parse(e.data) as {
            candidates: EquityCandidate[]
            marketOpen: boolean
            capturedAt: number
          }
          setEquityCandidates(payload.candidates, payload.marketOpen)
        } catch { /* ignora */ }
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

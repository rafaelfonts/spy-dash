/**
 * technicalIndicatorsPoller — fetches RSI, MACD, BBANDS from Alpha Vantage.
 *
 * Design:
 *  - Rotation strategy: 1 indicator per tick (RSI → MACD → BBANDS), cycling every 15min.
 *  - Each full cycle ≈ 45min. ~20 API calls/day — within the 25 req/day free tier.
 *  - First publish happens after all 3 indicators have been fetched at least once.
 *  - Off-hours: poller backs off to 5min checks (no-op unless tick runs).
 *  - If ALPHA_VANTAGE_KEY is not configured, poller does not start.
 */

import { CONFIG } from '../config'
import { publishTechnicalData } from './technicalIndicatorsState'
import type { TechnicalData } from './technicalIndicatorsState'
import { isMarketOpen } from '../lib/time'
import { cacheGet, cacheSet } from '../lib/cacheStore'

const CACHE_KEY = 'technical_indicators:SPY'
const CACHE_TTL_MS = 60 * 60_000  // 60min

const BASE = 'https://www.alphavantage.co/query'
const SYMBOL = 'SPY'
const INTERVAL = '15min'
const POLL_INTERVAL_MS = 15 * 60_000  // 15min during market hours

type Indicator = 'RSI' | 'MACD' | 'BBANDS'
const ROTATION: Indicator[] = ['RSI', 'MACD', 'BBANDS']
let rotationIndex = 0

// In-memory accumulator — filled incrementally across 3 ticks
const acc: Partial<TechnicalData> = {}

// ---------------------------------------------------------------------------
// Individual fetchers
// ---------------------------------------------------------------------------

async function fetchRSI(): Promise<void> {
  const url = `${BASE}?function=RSI&symbol=${SYMBOL}&interval=${INTERVAL}&time_period=14&series_type=close&apikey=${CONFIG.ALPHA_VANTAGE_KEY}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`RSI HTTP ${res.status}`)
  const json = await res.json() as Record<string, unknown>
  const values = json['Technical Analysis: RSI'] as Record<string, { RSI: string }> | undefined
  if (!values) throw new Error('RSI: no data in response')
  const latest = Object.values(values)[0]
  acc.rsi14 = parseFloat(latest.RSI)
}

async function fetchMACD(): Promise<void> {
  const url = `${BASE}?function=MACD&symbol=${SYMBOL}&interval=${INTERVAL}&series_type=close&apikey=${CONFIG.ALPHA_VANTAGE_KEY}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`MACD HTTP ${res.status}`)
  const json = await res.json() as Record<string, unknown>
  const values = json['Technical Analysis: MACD'] as Record<string, { MACD: string; MACD_Signal: string; MACD_Hist: string }> | undefined
  if (!values) throw new Error('MACD: no data in response')
  const entries = Object.entries(values)
  const [, latest] = entries[0]
  const [, prev] = entries[1] ?? entries[0]
  const histNow = parseFloat(latest.MACD_Hist)
  const histPrev = parseFloat(prev.MACD_Hist)
  const crossover: TechnicalData['macd']['crossover'] =
    histPrev <= 0 && histNow > 0 ? 'bullish' :
    histPrev >= 0 && histNow < 0 ? 'bearish' : 'none'
  acc.macd = {
    macd: parseFloat(latest.MACD),
    signal: parseFloat(latest.MACD_Signal),
    histogram: histNow,
    crossover,
  }
}

async function fetchBBANDS(): Promise<void> {
  const url = `${BASE}?function=BBANDS&symbol=${SYMBOL}&interval=${INTERVAL}&time_period=20&series_type=close&apikey=${CONFIG.ALPHA_VANTAGE_KEY}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`BBANDS HTTP ${res.status}`)
  const json = await res.json() as Record<string, unknown>
  const values = json['Technical Analysis: BBANDS'] as Record<string, { 'Real Upper Band': string; 'Real Middle Band': string; 'Real Lower Band': string }> | undefined
  if (!values) throw new Error('BBANDS: no data in response')
  const latest = Object.values(values)[0]
  const upper = parseFloat(latest['Real Upper Band'])
  const middle = parseFloat(latest['Real Middle Band'])
  const lower = parseFloat(latest['Real Lower Band'])
  // position placeholder — openai.ts refines with live SPY price via deriveBBPosition
  acc.bbands = { upper, middle, lower, position: 'middle' }
}

// ---------------------------------------------------------------------------
// BB position helper (exported for use in openai.ts at analysis time)
// ---------------------------------------------------------------------------

export function deriveBBPosition(
  spyPrice: number,
  bbands: TechnicalData['bbands'],
): TechnicalData['bbands']['position'] {
  const { upper, middle, lower } = bbands
  const upperZone = upper - (upper - middle) * 0.15
  const lowerZone = lower + (middle - lower) * 0.15
  if (spyPrice > upper) return 'above_upper'
  if (spyPrice >= upperZone) return 'near_upper'
  if (spyPrice <= lower) return 'below_lower'
  if (spyPrice <= lowerZone) return 'near_lower'
  return 'middle'
}

// ---------------------------------------------------------------------------
// Single poll tick
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  const indicator = ROTATION[rotationIndex % ROTATION.length]
  rotationIndex++

  try {
    if (indicator === 'RSI') await fetchRSI()
    else if (indicator === 'MACD') await fetchMACD()
    else await fetchBBANDS()
    console.log(`[TechIndicators] ${indicator} fetched`)
  } catch (err) {
    console.error(`[TechIndicators] ${indicator} fetch failed:`, (err as Error).message)
    return
  }

  // Only publish when all 3 have been fetched at least once
  if (acc.rsi14 == null || acc.macd == null || acc.bbands == null) {
    console.log(`[TechIndicators] Waiting for remaining indicators before publish`)
    return
  }

  const data: TechnicalData = {
    rsi14: acc.rsi14,
    macd: acc.macd,
    bbands: acc.bbands,
    capturedAt: new Date().toISOString(),
  }

  publishTechnicalData(data)
  await cacheSet(CACHE_KEY, data, CACHE_TTL_MS, 'alpha-vantage')
  console.log(
    `[TechIndicators] Published — RSI=${data.rsi14.toFixed(2)} ` +
    `MACD_hist=${data.macd.histogram.toFixed(4)} ` +
    `BB_mid=${data.bbands.middle.toFixed(2)}`,
  )
}

// ---------------------------------------------------------------------------
// Adaptive scheduler
// ---------------------------------------------------------------------------

function scheduleNext(): void {
  const delay = isMarketOpen() ? POLL_INTERVAL_MS : 5 * 60_000
  setTimeout(() => {
    tick()
      .catch((e) => console.error('[TechIndicators] tick error:', e))
      .finally(scheduleNext)
  }, delay)
}

// ---------------------------------------------------------------------------
// Public start function
// ---------------------------------------------------------------------------

export function startTechnicalIndicatorsPoller(): void {
  if (!CONFIG.ALPHA_VANTAGE_KEY) {
    console.log('[TechIndicators] ALPHA_VANTAGE_KEY not set — skipping poller')
    return
  }
  console.log('[TechIndicators] Starting poller (rotation: RSI→MACD→BBANDS, 15min)')
  Promise.resolve()
    .then(async () => {
      const cached = await cacheGet<TechnicalData>(CACHE_KEY)
      if (cached) {
        Object.assign(acc, cached)
        publishTechnicalData(cached)
        console.log('[TechIndicators] Restored from cache')
      }
    })
    .then(() => tick())
    .catch((e) => console.error('[TechIndicators] Initial tick error:', e))
    .finally(scheduleNext)
}

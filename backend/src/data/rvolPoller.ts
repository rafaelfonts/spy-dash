/**
 * rvolPoller — SPY Relative Volume (RVOL) proxy for institutional flow detection.
 *
 * RVOL = todayVolume / avg20dVolume
 *   - RVOL > 1.2 + SPY rising  > 0.3% → accumulation (institutional buying)
 *   - RVOL > 1.2 + SPY falling > 0.3% → distribution (institutional selling)
 *   - Otherwise → neutral
 *
 * avg20dVolume sourced from Tradier's quote.average_volume (20d rolling).
 * Cached in Redis for 14h to avoid re-fetching on every tick.
 *
 * Frequency: 60s during market hours, 5min otherwise.
 */

import { getTradierClient } from '../lib/tradierClient'
import { cacheGet, cacheSet } from '../lib/cacheStore'
import { marketState } from './marketState'
import { isMarketOpen } from '../lib/time'

// ---------------------------------------------------------------------------
// Public snapshot type
// ---------------------------------------------------------------------------

export interface RVOLSnapshot {
  todayVolume: number
  avg20dVolume: number
  rvol: number                                          // todayVolume / avg20dVolume
  rvolBias: 'accumulation' | 'distribution' | 'neutral'
  capturedAt: string
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let rvolSnapshot: RVOLSnapshot | null = null

export function getRVOLSnapshot(): RVOLSnapshot | null {
  return rvolSnapshot
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

const AVG_VOL_CACHE_KEY = 'cache:spy_rvol_avg20d'
const POLL_INTERVAL_MS   = 60_000
const OFFHOURS_INTERVAL_MS = 5 * 60_000

async function getAvg20dVolume(): Promise<number | null> {
  const cached = await cacheGet<number>(AVG_VOL_CACHE_KEY)
  if (cached && cached > 0) return cached

  // Fetch from Tradier quote (average_volume = 20d rolling avg provided by exchange)
  try {
    const quotes = await getTradierClient().getQuotes(['SPY'])
    const q = quotes?.[0]
    if (q?.average_volume && q.average_volume > 0) {
      // Cache for 14h — avg volume changes slowly
      await cacheSet(AVG_VOL_CACHE_KEY, q.average_volume, 14 * 60 * 60 * 1000, 'tradier')
      console.log(`[RVOL] avg20d volume cached: ${q.average_volume.toLocaleString()}`)
      return q.average_volume
    }
  } catch (err) {
    console.warn('[RVOL] Could not fetch avg20d volume:', (err as Error).message)
  }
  return null
}

async function computeRVOL(): Promise<void> {
  try {
    const [bars, avg20d] = await Promise.all([
      getTradierClient().getTimeSales('SPY', '1min'),
      getAvg20dVolume(),
    ])

    if (!bars || bars.length === 0 || !avg20d) return

    const todayVolume = bars.reduce((sum, b) => sum + (b.volume ?? 0), 0)
    if (todayVolume === 0) return

    const rvol = todayVolume / avg20d

    // Determine bias: need SPY price change since open
    const spy = marketState.spy
    const spyLast = spy.last
    const spyOpen = spy.open ?? null
    let spyChangePct = 0
    if (spyLast && spyOpen && spyOpen > 0) {
      spyChangePct = ((spyLast - spyOpen) / spyOpen) * 100
    }

    let rvolBias: RVOLSnapshot['rvolBias'] = 'neutral'
    if (rvol > 1.2) {
      if (spyChangePct > 0.3) rvolBias = 'accumulation'
      else if (spyChangePct < -0.3) rvolBias = 'distribution'
    }

    rvolSnapshot = {
      todayVolume,
      avg20dVolume: avg20d,
      rvol: parseFloat(rvol.toFixed(2)),
      rvolBias,
      capturedAt: new Date().toISOString(),
    }

    console.log(`[RVOL] vol=${todayVolume.toLocaleString()} avg20d=${avg20d.toLocaleString()} rvol=${rvol.toFixed(2)} bias=${rvolBias}`)
  } catch (err) {
    console.error('[RVOL] computeRVOL error:', (err as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Adaptive scheduler
// ---------------------------------------------------------------------------

let rvolStarted = false

function scheduleNext(): void {
  const delay = isMarketOpen() ? POLL_INTERVAL_MS : OFFHOURS_INTERVAL_MS
  setTimeout(() => {
    computeRVOL()
      .catch((err) => console.error('[RVOL] tick error:', err))
      .finally(scheduleNext)
  }, delay)
}

export function startRVOLPoller(): void {
  if (rvolStarted) return
  rvolStarted = true
  console.log('[RVOL] Starting RVOL poller...')
  // Stagger 10s after startup to let the chain/timesales warm up
  setTimeout(() => {
    computeRVOL()
      .catch((err) => console.error('[RVOL] Initial tick error:', err))
      .finally(scheduleNext)
  }, 10_000)
}

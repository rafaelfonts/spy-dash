/**
 * skewIndexPoller — fetches the CBOE SKEW Index (^SKEW) from Finnhub every 5 minutes.
 *
 * The CBOE SKEW Index measures the perceived tail risk in the S&P 500 distribution
 * of returns, derived from out-of-the-money option prices. Range: ~100–150.
 *  - ≥130: elevated tail risk — puts are expensive, favorable for put spread sellers
 *  - ≥140: systemic risk being priced — caution
 *  - <115: tail risk cheap — avoid selling put spreads without other confirming signals
 *
 * Same Finnhub endpoint as ^VIX but with symbol %5ESKEW.
 * Cache: 14h (survives overnight/weekend restart).
 */

import { CONFIG } from '../config'
import { createBreaker } from '../lib/circuitBreaker'
import { cacheSet, cacheGet } from '../lib/cacheStore'

const POLL_INTERVAL = 5 * 60 * 1000      // 5 minutes (same as VIX)
const CACHE_KEY    = 'skew_index_snapshot'
const CACHE_TTL_MS = 14 * 60 * 60 * 1000 // 14h

export interface SKEWIndexSnapshot {
  value: number       // current SKEW level (e.g. 132.5)
  prevClose: number   // previous close
  lastUpdated: number // epoch ms
}

let state: SKEWIndexSnapshot | null = null

export function getSKEWIndexSnapshot(): SKEWIndexSnapshot | null {
  return state
}

// ---------------------------------------------------------------------------
// Finnhub fetch
// ---------------------------------------------------------------------------

interface FinnhubQuote {
  c: number  // current price
  pc: number // previous close
}

async function fetchSKEWFromFinnhub(): Promise<FinnhubQuote> {
  if (!CONFIG.FINNHUB_API_KEY) {
    throw new Error('FINNHUB_API_KEY not configured')
  }

  const url = `https://finnhub.io/api/v1/quote?symbol=%5ESKEW&token=${CONFIG.FINNHUB_API_KEY}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'SPYDash/1.0' },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 100)}`)
  }

  const json = (await res.json()) as FinnhubQuote
  if (!json.c || json.c < 80) {
    throw new Error(`Finnhub returned invalid SKEW value: ${json.c}`)
  }

  return json
}

const skewBreaker = createBreaker(fetchSKEWFromFinnhub, 'skew-finnhub', {
  resetTimeout: 300_000,
})

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

async function pollSKEW(): Promise<void> {
  if (!CONFIG.FINNHUB_API_KEY) return

  try {
    const quote = (await skewBreaker.fire()) as FinnhubQuote | null
    if (!quote) return

    state = {
      value: quote.c,
      prevClose: quote.pc,
      lastUpdated: Date.now(),
    }
    await cacheSet(CACHE_KEY, state, CACHE_TTL_MS, 'skew-poller')
    console.log(`[SKEWPoller] SKEW=${quote.c.toFixed(1)} prevClose=${quote.pc.toFixed(1)}`)
  } catch (err) {
    console.error('[SKEWPoller] Fetch failed:', (err as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Cache restore on startup
// ---------------------------------------------------------------------------

async function restoreSKEWFromCache(): Promise<void> {
  try {
    const cached = await cacheGet<SKEWIndexSnapshot>(CACHE_KEY)
    if (cached && cached.value > 0) {
      state = cached
      console.log(`[SKEWPoller] Restored from cache: SKEW=${cached.value.toFixed(1)}`)
    }
  } catch {
    // non-critical
  }
}

export async function startSKEWIndexPoller(): Promise<void> {
  if (!CONFIG.FINNHUB_API_KEY) {
    console.warn('[SKEWPoller] FINNHUB_API_KEY not configured — SKEW Index disabled')
    return
  }
  await restoreSKEWFromCache()
  pollSKEW().catch(console.error)
  setInterval(() => pollSKEW().catch(console.error), POLL_INTERVAL)
}

import { CONFIG } from '../config'
import { updateVIX, marketState } from './marketState'
import { createBreaker } from '../lib/circuitBreaker'
import { getTradierClient } from '../lib/tradierClient'
import { cacheSet } from '../lib/cacheStore'

const POLL_INTERVAL = 5 * 60 * 1000 // 5 minutes
const CACHE_KEY = 'vix_snapshot'
const CACHE_TTL_MS = 330_000  // 330s = 5min × 1.1
// DXFeed is considered stale if it hasn't updated VIX in this window
const DXFEED_STALE_MS = 5 * 60 * 1000

interface FinnhubQuote {
  c: number  // current price
  d: number  // change
  dp: number // change percent
  h: number  // high
  l: number  // low
  pc: number // previous close
}

async function fetchVIXFromFinnhub(): Promise<FinnhubQuote> {
  if (!CONFIG.FINNHUB_API_KEY) {
    throw new Error('FINNHUB_API_KEY not configured')
  }

  const url = `https://finnhub.io/api/v1/quote?symbol=%5EVIX&token=${CONFIG.FINNHUB_API_KEY}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'SPYDash/1.0' },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 100)}`)
  }

  const json = (await res.json()) as FinnhubQuote
  if (!json.c || json.c <= 0) {
    throw new Error(`Finnhub returned invalid VIX price: ${json.c}`)
  }

  return json
}

const vixBreaker = createBreaker(fetchVIXFromFinnhub, 'vix-finnhub', {
  resetTimeout: 300_000, // retry after 5 min if tripped
})

async function fetchVIXFromTradier(): Promise<{ last: number; change: number } | null> {
  try {
    const quotes = await getTradierClient().getQuotes(['VIX'])
    const q = quotes.find((q) => q.symbol === 'VIX')
    if (!q || !q.last || q.last <= 0) return null
    return { last: q.last, change: q.change ?? 0 }
  } catch {
    return null
  }
}

async function pollVIX(): Promise<void> {
  // Skip if DXFeed has provided fresh VIX data recently
  const age = Date.now() - marketState.vix.lastUpdated
  const dxfeedIsLive = marketState.vix.lastUpdated > 0 && age < DXFEED_STALE_MS
  if (dxfeedIsLive) return

  // Finnhub (primary fallback — if key configured)
  if (CONFIG.FINNHUB_API_KEY) {
    try {
      const quote = (await vixBreaker.fire()) as FinnhubQuote | null
      if (quote) {
        updateVIX({ last: quote.c, change: quote.d })
        await cacheSet(CACHE_KEY, { last: quote.c, change: quote.d }, CACHE_TTL_MS, 'vix-poller')
        console.log(`[VIXPoller] VIX=${quote.c.toFixed(2)} change=${quote.d >= 0 ? '+' : ''}${quote.d.toFixed(2)} (Finnhub)`)
        return
      }
    } catch (err) {
      console.error('[VIXPoller] Finnhub failed:', (err as Error).message)
    }
  }

  // Tradier (secondary fallback)
  const tradierVIX = await fetchVIXFromTradier()
  if (tradierVIX) {
    updateVIX({ last: tradierVIX.last, change: tradierVIX.change })
    await cacheSet(CACHE_KEY, { last: tradierVIX.last, change: tradierVIX.change }, CACHE_TTL_MS, 'vix-poller')
    console.log(`[VIXPoller] VIX=${tradierVIX.last.toFixed(2)} (Tradier fallback)`)
  }
}

export function startVIXPoller(): void {
  if (!CONFIG.FINNHUB_API_KEY && !CONFIG.TRADIER_API_KEY) {
    console.warn('[VIXPoller] Neither FINNHUB_API_KEY nor TRADIER_API_KEY set — VIX fallback disabled')
    return
  }
  pollVIX().catch(console.error)
  setInterval(() => pollVIX().catch(console.error), POLL_INTERVAL)
}

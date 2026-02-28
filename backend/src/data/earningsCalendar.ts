import { CONFIG } from '../config'
import { ensureAccessToken } from '../auth/tokenManager'
import { emitter, newsSnapshot } from './marketState'
import type { EarningsItem } from '../types/market'
import { cacheGet, cacheSet } from '../lib/cacheStore'

const POLL_INTERVAL = 6 * 60 * 60 * 1000 // 6 hours
const CACHE_KEY = 'earnings'
const CACHE_TTL = 23_760_000 // POLL_INTERVAL * 1.1

// Top 10 SPY components by weight (BRK.B encoded for URL)
const SPY_TOP_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'LLY', 'AVGO', 'JPM', 'TSLA']

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null
  const target = new Date(dateStr)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  target.setHours(0, 0, 0, 0)
  const diff = Math.ceil((target.getTime() - today.getTime()) / 86_400_000)
  return diff
}

async function pollEarningsCalendar(): Promise<void> {
  const cached = await cacheGet<{ items: EarningsItem[]; ts: number }>(CACHE_KEY)
  if (cached) {
    newsSnapshot.earnings = cached.items
    newsSnapshot.earningsTs = cached.ts
    emitter.emit('newsfeed', { type: 'earnings', items: cached.items, ts: cached.ts })
    return
  }

  try {
    const token = await ensureAccessToken()
    const symbols = SPY_TOP_SYMBOLS.join(',')

    const res = await fetch(`${CONFIG.TT_BASE}/market-metrics?symbols=${symbols}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'SPYDash/1.0',
      },
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 100)}`)
    }

    const json = (await res.json()) as {
      data?: { items?: Array<Record<string, unknown>> }
    }

    const items: EarningsItem[] = []

    for (const item of json.data?.items ?? []) {
      const symbol = item['symbol'] as string | undefined
      const earningsDate = (item['earnings-date'] as string | null) ?? null

      if (!symbol) continue

      const daysToEarnings = daysUntil(earningsDate)

      // Include symbols with earnings in the past 7 days (context) or next 90 days (upcoming)
      if (daysToEarnings !== null && daysToEarnings >= -7 && daysToEarnings <= 90) {
        items.push({ symbol, earningsDate, daysToEarnings })
      }
    }

    // Sort by days to earnings ascending (closest first)
    items.sort((a, b) => {
      if (a.daysToEarnings === null) return 1
      if (b.daysToEarnings === null) return -1
      return a.daysToEarnings - b.daysToEarnings
    })

    newsSnapshot.earnings = items
    newsSnapshot.earningsTs = Date.now()
    await cacheSet(CACHE_KEY, { items, ts: newsSnapshot.earningsTs }, CACHE_TTL, 'tastytrade')
    emitter.emit('newsfeed', { type: 'earnings', items, ts: newsSnapshot.earningsTs })
    console.log(`[EarningsCalendar] Updated: ${items.length} symbols with earnings data`)
  } catch (err) {
    console.error('[EarningsCalendar] Error:', (err as Error).message)
  }
}

export function startEarningsCalendar(): void {
  pollEarningsCalendar().catch(console.error)
  setInterval(() => pollEarningsCalendar().catch(console.error), POLL_INTERVAL)
}

// backend/src/lib/ivPercentileCalculator.ts

import { CONFIG } from '../config'
import { cacheGet, cacheSet } from './cacheStore'
import { ensureAccessToken } from '../auth/tokenManager'

const CACHE_TTL = 14 * 60 * 60 * 1000 // 14h — refreshes each market session
const LOOKBACK_DAYS = 252

function cacheKey(symbol: string) {
  return `ivp_history:${symbol}`
}

interface IVHistoryEntry {
  date: string
  iv: number
}

async function fetchTastytradeIVHistory(symbol: string): Promise<IVHistoryEntry[]> {
  if (!CONFIG.TT_CLIENT_ID) return []

  try {
    const accessToken = await ensureAccessToken()

    // Tastytrade historical volatility endpoint
    const url = `${CONFIG.TT_BASE}/instruments/equities/${symbol}/volatility`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'SPYDash/1.0',
      },
    })
    if (!res.ok) return []
    const json = (await res.json()) as {
      data?: { items?: Array<{ date: string; implied_volatility: string }> }
    }
    return (json?.data?.items ?? []).map((e) => ({
      date: e.date,
      iv: parseFloat(e.implied_volatility) * 100,
    }))
  } catch (err) {
    console.warn(`[IVPercentile] Tastytrade history fetch failed for ${symbol}:`, err)
    return []
  }
}

/**
 * Calculate IV Percentile for a given symbol.
 * IVP = (# days IV was below currentIV over lookback) / totalDays * 100
 * Returns null if insufficient history.
 */
export async function calculateIVPercentile(
  symbol: string,
  currentIV: number,
): Promise<number | null> {
  let history = await cacheGet<IVHistoryEntry[]>(cacheKey(symbol))

  if (!history) {
    history = await fetchTastytradeIVHistory(symbol)
    if (history.length === 0) return null
    await cacheSet(cacheKey(symbol), history, CACHE_TTL, 'tastytrade')
  }

  // Sort ascending by date, then take the most recent LOOKBACK_DAYS entries
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date))
  const recent = sorted.slice(-LOOKBACK_DAYS)
  if (recent.length < 20) return null // insufficient data

  const belowCount = recent.filter((e) => e.iv < currentIV).length
  return Math.round((belowCount / recent.length) * 100)
}

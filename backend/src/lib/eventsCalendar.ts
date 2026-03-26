// backend/src/lib/eventsCalendar.ts

import { CONFIG } from '../config'
import { cacheGet, cacheSet } from './cacheStore'
import type { OptionEvents } from '../types/optionScreener'
import type { MacroEvent } from '../types/market'
import { newsSnapshot } from '../data/marketState'

const CACHE_TTL = 24 * 60 * 60 * 1000  // 24h

function cacheKey(symbol: string, dte: number) {
  return `option_screener_events:${symbol}:${dte}`
}

function todayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) // YYYY-MM-DD
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

async function fetchFinnhub(path: string): Promise<unknown> {
  const url = `https://finnhub.io/api/v1${path}&token=${CONFIG.FINNHUB_API_KEY}`
  const res = await fetch(url, { headers: { 'User-Agent': 'SPYDash/1.0' } })
  if (!res.ok) throw new Error(`Finnhub ${path} → HTTP ${res.status}`)
  return res.json()
}

export async function getEventsForSymbol(symbol: string, dte: number = 60): Promise<OptionEvents> {
  if (!CONFIG.FINNHUB_API_KEY) {
    return {
      nextEarnings: null,
      exDividendDate: null,
      earningsWithinDTE: false,
      exDivWithin5Days: false,
      upcomingMacroEvents: [],
    }
  }

  const cached = await cacheGet<OptionEvents>(cacheKey(symbol, dte))
  if (cached) return cached

  const today = todayET()
  const horizon = addDays(today, dte)

  let nextEarnings: string | null = null
  let exDividendDate: string | null = null

  try {
    const earningsResp = await fetchFinnhub(
      `/calendar/earnings?symbol=${symbol}&from=${today}&to=${horizon}`
    ) as { earningsCalendar?: Array<{ date: string }> } | null

    const entries = earningsResp?.earningsCalendar ?? []
    if (entries.length > 0) {
      const sorted = entries
        .map((e) => e.date)
        .filter((d) => d >= today)
        .sort()
      nextEarnings = sorted[0] ?? null
    }
  } catch (err) {
    console.warn(`[EventsCalendar] earnings fetch failed for ${symbol}:`, err)
  }

  try {
    const divResp = await fetchFinnhub(
      `/stock/dividend2?symbol=${symbol}`
    ) as { data?: Array<{ exDate: string }> } | null

    const divData = divResp?.data ?? []
    const upcoming = divData
      .map((d) => d.exDate)
      .filter((d) => d >= today)
      .sort()
    exDividendDate = upcoming[0] ?? null
  } catch (err) {
    console.warn(`[EventsCalendar] dividend fetch failed for ${symbol}:`, err)
  }

  // Macro events within DTE from in-memory snapshot
  const macroEvents: MacroEvent[] = newsSnapshot.macroEvents ?? []
  const upcomingMacroEvents = macroEvents
    .filter((e) => e.impact === 'high' && e.time && e.time.slice(0, 10) >= today && e.time.slice(0, 10) <= horizon)
    .map((e) => `${e.event} ${e.time}`)
    .slice(0, 3)

  const result: OptionEvents = {
    nextEarnings,
    exDividendDate,
    earningsWithinDTE: nextEarnings !== null && nextEarnings <= horizon,
    exDivWithin5Days: exDividendDate !== null && exDividendDate <= addDays(today, 5),
    upcomingMacroEvents,
  }

  await cacheSet(cacheKey(symbol, dte), result, CACHE_TTL, 'finnhub')
  return result
}

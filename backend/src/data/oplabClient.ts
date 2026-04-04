/**
 * oplabClient — REST client for OpLab API v3.
 *
 * Base URL: https://api.oplab.com.br/v3
 * Auth: header 'Access-Token: <OPLAB_ACCESS_TOKEN>'
 *
 * NOTE: Endpoint response shapes are based on the OpLab public API.
 * If structure changes, update the raw response interfaces below.
 */

import { CONFIG } from '../config'
import { cacheGet, cacheSet } from '../lib/cacheStore'

const OPLAB_BASE = 'https://api.oplab.com.br/v3'
const CACHE_TTL_QUOTE = 30_000         // 30s
const CACHE_TTL_CHAIN = 5 * 60_000    // 5min
const CACHE_TTL_SERIES = 10 * 60_000  // 10min

// ---------------------------------------------------------------------------
// Raw API response shapes
// ---------------------------------------------------------------------------

interface OplabInstrumentResponse {
  symbol: string
  financial: {
    last: number
    bid: number
    ask: number
    volume: number
    open: number
    close: number
  }
  variation: number   // changePct as decimal (e.g. -0.012 = -1.2%)
}

interface OplabOptionContract {
  symbol: string
  strike: number
  category: 'CALL' | 'PUT'
  due_date: string          // YYYY-MM-DD
  financial: {
    bid: number
    ask: number
    volume: number
    open_interest: number
    impliedVolatility: number  // decimal, e.g. 0.25 = 25%
  }
  type: 'EUROPEAN' | 'AMERICAN'
}

// ---------------------------------------------------------------------------
// Public output shapes
// ---------------------------------------------------------------------------

export interface Bova11Quote {
  last: number
  bid: number
  ask: number
  changePct: number   // decimal (e.g. -0.012 = -1.2%)
  volume: number
}

export interface OplabOptionLeg {
  symbol: string
  strike: number
  category: 'CALL' | 'PUT'
  expirationDate: string   // YYYY-MM-DD
  bid: number
  ask: number
  volume: number
  openInterest: number
  impliedVolatility: number  // decimal
  optionType: 'EUROPEAN' | 'AMERICAN'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAuthHeader(): Record<string, string> {
  if (!CONFIG.OPLAB_ACCESS_TOKEN) {
    throw new Error('[OplabClient] OPLAB_ACCESS_TOKEN not configured')
  }
  return {
    'Access-Token': CONFIG.OPLAB_ACCESS_TOKEN,
    'Content-Type': 'application/json',
  }
}

async function oplabFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${OPLAB_BASE}${path}`, {
    headers: getAuthHeader(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`[OplabClient] HTTP ${res.status} on ${path}: ${text}`)
  }
  return res.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Fetch current quote for BOVA11 (or any B3 instrument). */
export async function fetchBova11Quote(symbol = 'BOVA11'): Promise<Bova11Quote> {
  const cacheKey = `oplab:quote:${symbol}`
  const cached = await cacheGet<Bova11Quote>(cacheKey)
  if (cached) return cached

  const raw = await oplabFetch<OplabInstrumentResponse>(`/market/instruments/${symbol}`)

  const result: Bova11Quote = {
    last: raw.financial.last,
    bid: raw.financial.bid,
    ask: raw.financial.ask,
    changePct: raw.variation,
    volume: raw.financial.volume,
  }

  await cacheSet(cacheKey, result, CACHE_TTL_QUOTE, 'oplab')
  return result
}

/** Fetch list of available option expiration dates for a B3 instrument. */
export async function fetchBova11Series(symbol = 'BOVA11'): Promise<string[]> {
  const cacheKey = `oplab:series:${symbol}`
  const cached = await cacheGet<string[]>(cacheKey)
  if (cached) return cached

  // OpLab returns a list of option series objects; each has a due_date field
  const raw = await oplabFetch<Array<{ due_date: string }>>(`/market/options/${symbol}/series`)

  const expirations = [...new Set(raw.map((s) => s.due_date))].sort()

  await cacheSet(cacheKey, expirations, CACHE_TTL_SERIES, 'oplab')
  return expirations
}

/** Fetch the full option chain for a specific expiration date. */
export async function fetchBova11Chain(
  expiration: string,
  symbol = 'BOVA11',
): Promise<OplabOptionLeg[]> {
  const cacheKey = `oplab:chain:${symbol}:${expiration}`
  const cached = await cacheGet<OplabOptionLeg[]>(cacheKey)
  if (cached) return cached

  const raw = await oplabFetch<OplabOptionContract[]>(`/market/options/${symbol}/${expiration}`)

  const legs: OplabOptionLeg[] = raw.map((c) => ({
    symbol: c.symbol,
    strike: c.strike,
    category: c.category,
    expirationDate: c.due_date,
    bid: c.financial.bid,
    ask: c.financial.ask,
    volume: c.financial.volume,
    openInterest: c.financial.open_interest,
    impliedVolatility: c.financial.impliedVolatility,
    optionType: c.type,
  }))

  await cacheSet(cacheKey, legs, CACHE_TTL_CHAIN, 'oplab')
  return legs
}

/**
 * Resolve the nearest available expiration for BOVA11 options.
 * Prefers today's date (0DTE); otherwise the next future expiration.
 */
export async function resolveBova11NearestExpiration(symbol = 'BOVA11'): Promise<string | null> {
  const series = await fetchBova11Series(symbol)
  if (series.length === 0) return null

  const today = new Date().toISOString().slice(0, 10)
  if (series.includes(today)) return today

  const future = series.filter((d) => d >= today)
  return future[0] ?? null
}

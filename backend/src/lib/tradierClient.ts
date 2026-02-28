/**
 * TradierClient — Singleton HTTP client for the Tradier brokerage API.
 *
 * Features:
 *  - Typed responses for options chain, time & sales, and quotes
 *  - Token-bucket rate limiter (default: 180 req/min, well under the 200 limit)
 *  - In-process cache layer backed by the project's Supabase cacheStore
 *  - Circuit breaker per endpoint via opossum (reuses project's createBreaker)
 */

import { CONFIG } from '../config'
import { cacheGet, cacheSet } from './cacheStore'
import { createBreaker } from './circuitBreaker'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TradierOption {
  symbol: string
  strike: number
  option_type: 'call' | 'put'
  expiration_date: string
  open_interest: number
  volume: number
  bid: number
  ask: number
  last: number
  greeks?: {
    delta: number
    gamma: number
    theta: number
    vega: number
    rho: number
    phi: number
    bid_iv: number
    mid_iv: number
    ask_iv: number
    smv_vol: number
    updated_at: string
  }
}

export interface TradierOptionChainResponse {
  options: { option: TradierOption | TradierOption[] } | null
}

export interface TradierTimeSaleEntry {
  time: string        // ISO 8601 e.g. "2025-07-01T09:30:00"
  timestamp: number
  price: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  vwap: number
}

export interface TradierTimeSalesResponse {
  series: { data: TradierTimeSaleEntry | TradierTimeSaleEntry[] } | null
}

export interface TradierQuote {
  symbol: string
  description: string
  last: number
  change: number
  change_percentage: number
  volume: number
  open: number
  high: number
  low: number
  close: number
  bid: number
  ask: number
  week_52_high: number
  week_52_low: number
  average_volume: number
}

export interface TradierQuotesResponse {
  quotes: { quote: TradierQuote | TradierQuote[] } | null
}

// ---------------------------------------------------------------------------
// Token-bucket rate limiter
// ---------------------------------------------------------------------------

interface TokenBucketOptions {
  /** Maximum tokens (= max burst). Default: 180 */
  capacity: number
  /** Tokens replenished per second. Default: 3 (180/min) */
  refillRate: number
}

class TokenBucket {
  private tokens: number
  private lastRefill: number
  private readonly capacity: number
  private readonly refillRate: number   // tokens per ms

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.capacity
    this.refillRate = opts.refillRate / 1000  // convert to per-ms
    this.tokens = opts.capacity
    this.lastRefill = Date.now()
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = now - this.lastRefill
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate)
    this.lastRefill = now
  }

  /** Consume one token. Returns the ms to wait if the bucket is empty, or 0 if ok. */
  consume(): number {
    this.refill()
    if (this.tokens >= 1) {
      this.tokens -= 1
      return 0
    }
    // Time until next token is available
    return Math.ceil((1 - this.tokens) / this.refillRate)
  }
}

// ---------------------------------------------------------------------------
// TradierClient
// ---------------------------------------------------------------------------

class TradierClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly bucket: TokenBucket

  // Per-endpoint circuit breakers (created lazily on first use)
  private readonly breakers = new Map<string, ReturnType<typeof createBreaker>>()

  constructor() {
    this.baseUrl = CONFIG.TRADIER_BASE_URL
    this.token = CONFIG.TRADIER_API_KEY
    // 180 req/min = 3 req/s burst capacity of 30 (handles short spikes)
    this.bucket = new TokenBucket({ capacity: 30, refillRate: 3 })
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async throttledFetch(url: string): Promise<unknown> {
    const wait = this.bucket.consume()
    if (wait > 0) {
      console.warn(`[Tradier] Rate limit: waiting ${wait}ms`)
      await new Promise((r) => setTimeout(r, wait))
    }

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      },
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Tradier HTTP ${res.status}: ${body.slice(0, 200)}`)
    }

    return res.json()
  }

  /** Returns a circuit-breaker-wrapped version of throttledFetch for a given endpoint key. */
  private getBreakerFor(key: string): ReturnType<typeof createBreaker> {
    if (!this.breakers.has(key)) {
      const breaker = createBreaker(
        (url: string) => this.throttledFetch(url),
        `tradier:${key}`,
        { timeout: 15_000, resetTimeout: 120_000 },
      )
      this.breakers.set(key, breaker)
    }
    return this.breakers.get(key)!
  }

  private async fetchWithBreaker<T>(endpointKey: string, url: string): Promise<T | null> {
    const breaker = this.getBreakerFor(endpointKey)
    const result = await breaker.fire(url)
    return (result as T) ?? null
  }

  // -------------------------------------------------------------------------
  // Public API methods
  // -------------------------------------------------------------------------

  /**
   * Fetch the full options chain for a symbol and expiration date.
   * Greeks are always requested (greeks=true).
   *
   * Cache TTL: 60 s — chains update every ~30 s during market hours.
   */
  async getOptionChain(
    symbol: string,
    expiration: string,
  ): Promise<TradierOption[]> {
    if (!this.token) return []

    const cacheKey = `tradier:chain:${symbol}:${expiration}`
    const cached = await cacheGet<TradierOption[]>(cacheKey)
    if (cached) return cached

    const url =
      `${this.baseUrl}/v1/markets/options/chains` +
      `?symbol=${encodeURIComponent(symbol)}&expiration=${expiration}&greeks=true`

    const json = await this.fetchWithBreaker<TradierOptionChainResponse>('chain', url)
    const raw = json?.options?.option
    const options: TradierOption[] = Array.isArray(raw) ? raw : raw ? [raw] : []

    if (options.length > 0) {
      await cacheSet(cacheKey, options, 60_000, 'tradier')
    }

    console.log(`[Tradier] getOptionChain(${symbol}, ${expiration}): ${options.length} contracts`)
    return options
  }

  /**
   * Fetch time & sales (OHLCV bars) for a symbol.
   * Defaults to 1-minute bars for today's session.
   *
   * Cache TTL: 30 s — bars update every minute.
   */
  async getTimeSales(
    symbol: string,
    interval: '1min' | '5min' | '15min' | 'tick' = '1min',
  ): Promise<TradierTimeSaleEntry[]> {
    if (!this.token) return []

    const today = new Date().toISOString().slice(0, 10)
    const cacheKey = `tradier:timesales:${symbol}:${interval}:${today}`
    const cached = await cacheGet<TradierTimeSaleEntry[]>(cacheKey)
    if (cached) return cached

    const url =
      `${this.baseUrl}/v1/markets/timesales` +
      `?symbol=${encodeURIComponent(symbol)}&interval=${interval}&start=${today}%2009:30&session_filter=open`

    const json = await this.fetchWithBreaker<TradierTimeSalesResponse>('timesales', url)
    const raw = json?.series?.data
    const entries: TradierTimeSaleEntry[] = Array.isArray(raw) ? raw : raw ? [raw] : []

    if (entries.length > 0) {
      await cacheSet(cacheKey, entries, 30_000, 'tradier')
    }

    console.log(`[Tradier] getTimeSales(${symbol}, ${interval}): ${entries.length} bars`)
    return entries
  }

  /**
   * Fetch available option expiration dates for a symbol.
   * Prefers today's date (0DTE) at call sites via resolveNearestExpiration.
   *
   * Cache TTL: 60 s — the expiration calendar rarely changes intraday.
   */
  async getExpirations(symbol: string): Promise<string[]> {
    if (!this.token) return []

    const cacheKey = `tradier:expirations:${symbol}`
    const cached = await cacheGet<string[]>(cacheKey)
    if (cached) return cached

    const url =
      `${this.baseUrl}/v1/markets/options/expirations` +
      `?symbol=${encodeURIComponent(symbol)}&includeAllRoots=true`

    const json = await this.fetchWithBreaker<{
      expirations?: { date: string | string[] } | null
    }>('expirations', url)

    const raw = json?.expirations?.date
    const dates: string[] = Array.isArray(raw) ? raw : raw ? [raw] : []

    if (dates.length > 0) {
      await cacheSet(cacheKey, dates, 60_000, 'tradier:expirations')
    }

    console.log(`[Tradier] getExpirations(${symbol}): ${dates.length} dates`)
    return dates
  }

  /**
   * Fetch real-time quotes for one or more symbols.
   * Accepts a comma-separated list or an array.
   *
   * Cache TTL: 5 s — quotes are near-real-time.
   */
  async getQuotes(symbols: string | string[]): Promise<TradierQuote[]> {
    if (!this.token) return []

    const symbolList = Array.isArray(symbols) ? symbols.join(',') : symbols
    const cacheKey = `tradier:quotes:${symbolList}`
    const cached = await cacheGet<TradierQuote[]>(cacheKey)
    if (cached) return cached

    const url =
      `${this.baseUrl}/v1/markets/quotes` +
      `?symbols=${encodeURIComponent(symbolList)}&greeks=false`

    const json = await this.fetchWithBreaker<TradierQuotesResponse>('quotes', url)
    const raw = json?.quotes?.quote
    const quotes: TradierQuote[] = Array.isArray(raw) ? raw : raw ? [raw] : []

    if (quotes.length > 0) {
      await cacheSet(cacheKey, quotes, 5_000, 'tradier')
    }

    console.log(`[Tradier] getQuotes(${symbolList}): ${quotes.length} quotes`)
    return quotes
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

let _instance: TradierClient | null = null

export function getTradierClient(): TradierClient {
  if (!_instance) _instance = new TradierClient()
  return _instance
}

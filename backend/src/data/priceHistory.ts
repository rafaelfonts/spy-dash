import { createClient } from '@supabase/supabase-js'
import { marketState, updateSPY } from './marketState'
import { CONFIG } from '../config'
import { getTradierClient } from '../lib/tradierClient'
import { cacheGet, cacheSet } from '../lib/cacheStore'
import type { PricePoint } from '../types/market'

const SPY_QUOTE_CACHE_KEY = 'spy_quote_snapshot'
const SPY_QUOTE_CACHE_TTL_MS = 14 * 60 * 60 * 1000 // 14h — survives overnight/weekend

const INTRADAY_CACHE_TTL_MS = 14 * 60 * 60 * 1000 // 14h — same as quote snapshot
const SPY_INTRADAY_KEY = 'spy_intraday'
const VIX_INTRADAY_KEY = 'vix_intraday'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const PERSIST_INTERVAL_MS = 60_000 // 1 minuto — evita 3600+ writes/hora
const lastPersisted: Record<string, number> = {}

let _lastVwap: number | null = null

/** Returns the VWAP of the most recent 1-min bar from Tradier timesales, or null if unavailable. */
export function getLastVwap(): number | null { return _lastVwap }

interface PriceTick {
  price: number
  bid: number | null
  ask: number | null
  volume: number | null
}

export function persistPriceTick(symbol: string, tick: PriceTick): void {
  const now = Date.now()
  if ((lastPersisted[symbol] ?? 0) + PERSIST_INTERVAL_MS > now) return
  lastPersisted[symbol] = now

  supabase
    .from('price_ticks')
    .insert({
      symbol,
      recorded_at: new Date().toISOString(),
      price: tick.price,
      bid: tick.bid,
      ask: tick.ask,
      volume: tick.volume !== null ? Math.trunc(tick.volume) : null,
    })
    .then(({ error }) => {
      if (error) console.error('[PriceHistory] Insert falhou:', error.message)
    })
}

/**
 * Restores SPY/VIX intraday time-series from the long-lived Redis cache (14h TTL).
 * Filters out stale data older than today (local timezone date comparison).
 * Runs first in startup chain — provides an instant chart on backend restart.
 */
export async function restoreIntradayFromRedis(): Promise<void> {
  const todayStr = new Date().toDateString()
  for (const { key, symbol } of [
    { key: SPY_INTRADAY_KEY, symbol: 'SPY' },
    { key: VIX_INTRADAY_KEY, symbol: 'VIX' },
  ]) {
    try {
      const cached = await cacheGet<PricePoint[]>(key)
      if (!cached?.length) continue
      // Filter to today's data only — discard stale cross-session points
      const todayPoints = cached.filter((pt) => new Date(pt.t).toDateString() === todayStr)
      if (!todayPoints.length) continue
      if (symbol === 'SPY') {
        marketState.spy.priceHistory = todayPoints
      } else {
        marketState.vix.priceHistory = todayPoints
      }
      console.log(`[Intraday] Restored ${todayPoints.length} points for ${symbol} from Redis cache`)
    } catch (err) {
      console.error(`[Intraday] Redis restore failed for ${symbol}:`, (err as Error).message)
    }
  }
}

/**
 * Persists the current in-memory intraday series to Redis every 60s.
 * Allows instant chart restoration after backend restarts during the trading day.
 */
export function startIntradayCachePersistence(): void {
  setInterval(() => {
    const spyHistory = marketState.spy.priceHistory
    const vixHistory = marketState.vix.priceHistory
    if (spyHistory.length > 0) {
      cacheSet(SPY_INTRADAY_KEY, spyHistory, INTRADAY_CACHE_TTL_MS, 'intraday').catch(console.error)
    }
    if (vixHistory.length > 0) {
      cacheSet(VIX_INTRADAY_KEY, vixHistory, INTRADAY_CACHE_TTL_MS, 'intraday').catch(console.error)
    }
  }, PERSIST_INTERVAL_MS)
}

export async function restorePriceHistory(): Promise<void> {
  for (const symbol of ['SPY', 'VIX']) {
    // Look back 5 days so weekends/holidays always capture the last full trading session.
    // Fetch descending (most recent first) then reverse to restore chronological order.
    const since = new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString()
    const { data, error } = await supabase
      .from('price_sparkline')
      .select('minute, price_avg')
      .eq('symbol', symbol)
      .gte('minute', since)
      .order('minute', { ascending: false })
      .limit(390)

    if (error) {
      console.error(`[PriceHistory] Falha ao restaurar ${symbol}:`, error.message)
      continue
    }
    if (!data?.length) continue

    const points: PricePoint[] = data
      .map((r) => ({
        t: new Date(r.minute as string).getTime(),
        p: parseFloat(r.price_avg as string),
      }))
      .reverse()

    if (symbol === 'SPY') {
      marketState.spy.priceHistory = points
    } else {
      marketState.vix.priceHistory = points
    }
    console.log(`[PriceHistory] Restaurado ${points.length} minutos de ${symbol}`)
  }
}

/**
 * Restores SPY intraday price history from Tradier 1-min time-sales.
 * Overwrites the Supabase-based history when available, since Tradier provides
 * richer intraday granularity (every 1-min bar since 09:30 ET).
 * Persists result to Redis intraday cache for fast subsequent restarts.
 * No-op if TRADIER_API_KEY is not configured.
 */
export async function restoreFromTradier(): Promise<void> {
  if (!CONFIG.TRADIER_API_KEY) return
  try {
    const bars = await getTradierClient().getTimeSales('SPY', '1min')
    if (!bars.length) return
    const points: PricePoint[] = bars.map((b) => ({
      t: new Date(b.time).getTime(),
      p: b.close,
    }))
    marketState.spy.priceHistory = points.slice(-390)
    const lastBar = bars[bars.length - 1]
    if (lastBar?.vwap) _lastVwap = lastBar.vwap
    console.log(`[PriceHistory] Restored ${points.length} bars from Tradier timesales` +
      (lastBar?.vwap ? ` | VWAP=${lastBar.vwap.toFixed(2)}` : ''))
    // Persist to Redis so subsequent restarts load instantly
    await cacheSet(SPY_INTRADAY_KEY, marketState.spy.priceHistory, INTRADAY_CACHE_TTL_MS, 'intraday')
  } catch (err) {
    console.error('[PriceHistory] Tradier restore failed:', (err as Error).message)
  }
}

/**
 * Restores SPY last quote from the long-lived Redis cache (14h TTL).
 * Runs on startup before Tradier restore — provides immediate data on server restart
 * when market is closed and DXFeed has no live data.
 */
export async function restoreSPYQuoteFromCache(): Promise<void> {
  try {
    const cached = await cacheGet<{
      last: number; bid: number | null; ask: number | null
      open: number | null; prevClose: number | null
      dayHigh: number | null; dayLow: number | null
      volume: number | null; change: number | null; changePct: number | null
    }>(SPY_QUOTE_CACHE_KEY)
    if (!cached || cached.last == null) return
    updateSPY(cached)
    console.log(`[PriceHistory] SPY quote restored from cache: last=${cached.last}`)
  } catch (err) {
    console.error('[PriceHistory] SPY quote cache restore failed:', (err as Error).message)
  }
}

/**
 * Restores SPY last quote (last, bid, ask, open, high, low, volume, change) from Tradier.
 * Tradier returns the last available price even when the market is closed, so this
 * prevents the SPY card from showing skeleton on server restart outside market hours.
 * Persists the result to a 14h Redis cache so subsequent restarts work without Tradier.
 * No-op if TRADIER_API_KEY is not configured.
 */
export async function restoreSPYQuoteFromTradier(): Promise<void> {
  if (!CONFIG.TRADIER_API_KEY) return
  try {
    const quotes = await getTradierClient().getQuotes(['SPY'])
    const q = quotes[0]
    if (!q || q.last == null) return
    const payload = {
      last:      q.last,
      bid:       q.bid      ?? null,
      ask:       q.ask      ?? null,
      open:      q.open     ?? null,
      prevClose: q.close    ?? null,
      dayHigh:   q.high     ?? null,
      dayLow:    q.low      ?? null,
      volume:    q.volume   ?? null,
      change:    q.change   ?? null,
      changePct: q.change_percentage ?? null,
    }
    updateSPY(payload)
    await cacheSet(SPY_QUOTE_CACHE_KEY, payload, SPY_QUOTE_CACHE_TTL_MS, 'tradier-quote')
    console.log(`[PriceHistory] SPY quote restored from Tradier: last=${q.last}`)
  } catch (err) {
    console.error('[PriceHistory] Tradier SPY quote restore failed:', (err as Error).message)
  }
}

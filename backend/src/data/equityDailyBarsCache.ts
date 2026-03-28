// backend/src/data/equityDailyBarsCache.ts
import { getTradierClient } from '../lib/tradierClient.js'
import { cacheGet, cacheSet } from '../lib/cacheStore.js'
import {
  calcSMA, calcADX, calcATR, calcAVWAP, calcZScore, calcRVOLD1, calcMTFAlignment,
} from '../lib/equityDailyTechnicals.js'
import type { EquityDailyContext, DailyBar } from '../types/market.js'
import { calcBBands } from '../lib/technicalCalcs.js'

const TTL_MS = 8 * 60 * 60 * 1000  // 8h
const CACHE_KEY = (symbol: string) => `equity:daily:${symbol}`
const MAX_PARALLEL = 10

// In-memory snapshot (symbol → context)
const _cache = new Map<string, EquityDailyContext>()

export function getDailyContext(symbol: string): EquityDailyContext | null {
  return _cache.get(symbol) ?? null
}

export function getAllDailyContexts(): Map<string, EquityDailyContext> {
  return _cache
}

async function fetchAndCompute(symbol: string): Promise<EquityDailyContext | null> {
  // Try Redis cache first
  const cached = await cacheGet<EquityDailyContext>(CACHE_KEY(symbol))
  if (cached) {
    _cache.set(symbol, cached)
    return cached
  }

  const tradier = getTradierClient()
  const history = await tradier.getHistory(symbol, 65).catch(() => null)
  if (!history || history.length < 20) return null

  // Convert to DailyBar
  const bars: DailyBar[] = history.map((h) => ({
    date: h.date,
    open: h.open,
    high: h.high,
    low: h.low,
    close: h.close,
    volume: h.volume,
  }))

  const lastClose = bars[bars.length - 1].close
  const sma20 = calcSMA(bars, 20)
  const sma50 = calcSMA(bars, 50)
  const adx14 = calcADX(bars, 14)
  const atr14 = calcATR(bars, 14)
  const avwapWeekly = calcAVWAP(bars, 'week')
  const avwapMonthly = calcAVWAP(bars, 'month')
  const zScore20d = calcZScore(bars, 20)
  const distFromMA20 = sma20 === 0 ? 0 : ((lastClose - sma20) / sma20) * 100
  const rvolD1 = calcRVOLD1(bars)
  const alignment = calcMTFAlignment(lastClose, sma20, sma50, avwapWeekly, adx14)

  // Bollinger width from daily closes
  const closes = bars.map((b) => b.close)
  const bbResult = closes.length >= 20 ? calcBBands(closes, 20) : null
  const bollingerWidth = bbResult?.bandwidth ?? 0

  const ctx: EquityDailyContext = {
    symbol,
    bars,
    sma20,
    sma50,
    adx14,
    avwapWeekly,
    avwapMonthly,
    zScore20d,
    distFromMA20,
    atr14,
    bollingerWidth,
    rvolD1,
    alignment,
    fetchedAt: Date.now(),
  }

  _cache.set(symbol, ctx)
  await cacheSet(CACHE_KEY(symbol), ctx, TTL_MS, 'equityDailyBarsCache')
  return ctx
}

// Batch refresh for a list of symbols (max MAX_PARALLEL concurrent)
export async function refreshDailyBarsCache(symbols: string[]): Promise<void> {
  const chunks: string[][] = []
  for (let i = 0; i < symbols.length; i += MAX_PARALLEL) {
    chunks.push(symbols.slice(i, i + MAX_PARALLEL))
  }
  for (const chunk of chunks) {
    await Promise.allSettled(chunk.map((s) => fetchAndCompute(s)))
  }
  console.log(`[equityDailyBarsCache] Refreshed ${symbols.length} symbols`)
}

// Pre-market refresh cadence: called once on startup + every 8h
export function startEquityDailyBarsCachePoll(getSymbols: () => string[]): void {
  async function run() {
    const symbols = getSymbols()
    if (symbols.length > 0) await refreshDailyBarsCache(symbols).catch((e) => console.warn('[equityDailyBarsCache] Refresh failed:', e))
    setTimeout(run, TTL_MS)
  }
  // Initial run after 5s (allow universe to load)
  setTimeout(run, 5_000)
  console.log('[equityDailyBarsCache] Cache poll scheduled (8h interval)')
}

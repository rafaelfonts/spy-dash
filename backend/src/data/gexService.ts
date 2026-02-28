/**
 * GexService — standalone GEX calculator driven entirely by Tradier data.
 *
 * calculateDailyGex(symbol):
 *  1. Fetches the nearest expiration (0DTE or next available) from Tradier
 *  2. Builds the per-strike GEX input (OI + gamma already in TradierClient)
 *  3. Runs findZeroGammaLevel (Fase 3: BS re-simulation via bisection)
 *  4. Runs calculateGEX (static GEX at current spot, with ZGL attached)
 *  5. Persists the result to Supabase cache (TTL: 5 min)
 *  6. Returns { totalNetGamma, callWall, putWall, maxGexStrike, minGexStrike, zeroGammaLevel, ... }
 */

import { CONFIG } from '../config'
import { getTradierClient } from '../lib/tradierClient'
import { calculateGEX, findZeroGammaLevel } from '../lib/gexCalculator'
import type { GEXProfile, ZeroGammaContract } from '../lib/gexCalculator'
import { cacheGet, cacheSet } from '../lib/cacheStore'
import { marketState, newsSnapshot } from './marketState'

// ---------------------------------------------------------------------------
// Public result shape
// ---------------------------------------------------------------------------

export interface DailyGexResult {
  totalNetGamma: number        // total GEX in $M (positive = long gamma, negative = short)
  callWall: number             // strike with highest call open interest
  putWall: number              // strike with highest put open interest
  maxGexStrike: number         // strike with largest |netGEX|
  minGexStrike: number         // strike with most negative netGEX (heaviest put pressure)
  flipPoint: number | null     // discrete: strike where cumulative GEX changes sign
  zeroGammaLevel: number | null // continuous: BS-simulated price where net gamma = 0
  regime: 'positive' | 'negative'
  expiration: string           // the expiration date used (YYYY-MM-DD)
  profile: GEXProfile          // full per-strike breakdown for charting
  calculatedAt: string         // ISO 8601
}

const CACHE_TTL_MS = 5 * 60_000  // 5 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read Fed Funds Rate from the FRED macro snapshot. Fallback: 5.3%. */
function getRiskFreeRate(): number {
  const dff = newsSnapshot.macro.find((m) => m.seriesId === 'DFF')
  if (dff?.value !== null && dff?.value !== undefined && isFinite(dff.value)) {
    return dff.value / 100
  }
  return 0.053
}

/**
 * Fetch available option expirations from Tradier and return the nearest one.
 * Prefers today's date (0DTE); otherwise the first future expiration.
 */
export async function resolveNearestExpiration(symbol: string): Promise<string | null> {
  const expirations = await getTradierClient().getExpirations(symbol)
  if (expirations.length === 0) return null

  const today = new Date().toISOString().slice(0, 10)
  if (expirations.includes(today)) return today

  const future = expirations.filter((d) => d >= today).sort()
  return future[0] ?? null
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function calculateDailyGex(symbol: string): Promise<DailyGexResult | null> {
  if (!CONFIG.TRADIER_API_KEY) {
    console.warn('[GexService] TRADIER_API_KEY not set — skipping GEX calculation')
    return null
  }

  const cacheKey = `gex:daily:${symbol}`
  const cached = await cacheGet<DailyGexResult>(cacheKey)
  if (cached) {
    console.log(`[GexService] Cache hit for ${symbol} GEX`)
    return cached
  }

  // 1. Resolve nearest expiration (0DTE preferred)
  const expiration = await resolveNearestExpiration(symbol)
  if (!expiration) {
    console.error('[GexService] No expiration found for', symbol)
    return null
  }

  // 2. Fetch full option chain (greeks=true handled by TradierClient)
  const client = getTradierClient()
  const options = await client.getOptionChain(symbol, expiration)
  if (options.length === 0) {
    console.error(`[GexService] Empty option chain for ${symbol} ${expiration}`)
    return null
  }

  // 3. Spot price: live marketState → Tradier quote fallback
  let spotPrice = marketState.spy.last ?? 0
  if (spotPrice <= 0) {
    const quotes = await client.getQuotes(symbol)
    spotPrice = quotes[0]?.last ?? 0
  }
  if (spotPrice <= 0) {
    console.error('[GexService] Cannot determine spot price for', symbol)
    return null
  }

  // 4. Compute DTE → T in years
  //    For 0DTE we use half a trading day to avoid division-by-zero in BS formulas.
  const today = new Date().toISOString().slice(0, 10)
  const msPerDay = 86_400_000
  const dteMs = new Date(expiration).getTime() - new Date(today).getTime()
  const dte = Math.max(0, Math.round(dteMs / msPerDay))
  const T = dte === 0 ? 0.5 / 365 : dte / 365

  const r = getRiskFreeRate()

  // 5. Build per-strike maps for calculateGEX and findZeroGammaLevel
  const strikeMap = new Map<
    number,
    { callOI: number; callGamma: number; putOI: number; putGamma: number }
  >()

  // ZGL contracts: one entry per option contract (not per strike pair)
  const zglContracts: ZeroGammaContract[] = []

  for (const opt of options) {
    // --- strikeMap for calculateGEX ---
    const entry = strikeMap.get(opt.strike) ?? {
      callOI: 0, callGamma: 0, putOI: 0, putGamma: 0,
    }
    if (opt.option_type === 'call') {
      entry.callOI = opt.open_interest ?? 0
      entry.callGamma = opt.greeks?.gamma ?? 0
    } else {
      entry.putOI = opt.open_interest ?? 0
      entry.putGamma = opt.greeks?.gamma ?? 0
    }
    strikeMap.set(opt.strike, entry)

    // --- ZGL contracts (need IV per contract for BS re-simulation) ---
    const oi = opt.open_interest ?? 0
    if (oi === 0) continue  // skip zero-OI contracts — no dealer hedge

    // IV priority: smv_vol (surface model) → mid_iv → bid_iv → 18% fallback
    const iv =
      (opt.greeks?.smv_vol ?? 0) > 0.005 ? opt.greeks!.smv_vol :
      (opt.greeks?.mid_iv  ?? 0) > 0.005 ? opt.greeks!.mid_iv  :
      (opt.greeks?.bid_iv  ?? 0) > 0.005 ? opt.greeks!.bid_iv  :
      0.18  // market-wide fallback (18%)

    zglContracts.push({ strike: opt.strike, type: opt.option_type, oi, iv, T })
  }

  const strikeInputs = Array.from(strikeMap.entries()).map(([strike, data]) => ({
    strike,
    ...data,
  }))

  // Guard: need OI data for a meaningful result
  const hasOI = strikeInputs.some((s) => s.callOI > 0 || s.putOI > 0)
  if (!hasOI) {
    console.warn(`[GexService] No OI data found for ${symbol} ${expiration}`)
    return null
  }

  // 6. Find Zero Gamma Level via BS re-simulation (async, yields to event loop)
  console.log(`[GexService] Running ZGL simulation on ${zglContracts.length} contracts...`)
  const zeroGammaLevel = await findZeroGammaLevel(zglContracts, spotPrice, r)

  // 7. Compute static GEX profile at current spot (ZGL attached for convenience)
  const profile = calculateGEX(strikeInputs, spotPrice, zeroGammaLevel)

  const result: DailyGexResult = {
    totalNetGamma: profile.totalGEX,
    callWall: profile.callWall,
    putWall: profile.putWall,
    maxGexStrike: profile.maxGammaStrike,
    minGexStrike: profile.minGammaStrike,
    flipPoint: profile.flipPoint,
    zeroGammaLevel: profile.zeroGammaLevel,
    regime: profile.regime,
    expiration,
    profile,
    calculatedAt: profile.calculatedAt,
  }

  console.log(
    `[GexService] ${symbol} ${expiration} DTE=${dte}: ` +
    `totalGEX=$${result.totalNetGamma}M regime=${result.regime} ` +
    `callWall=${result.callWall} putWall=${result.putWall} ` +
    `flip=${result.flipPoint ?? 'N/A'} ZGL=${result.zeroGammaLevel ?? 'N/A'} spot=${spotPrice}`,
  )

  // 8. Persist to Supabase cache (TTL: 5 min)
  await cacheSet(cacheKey, result, CACHE_TTL_MS, 'gex-service')

  return result
}

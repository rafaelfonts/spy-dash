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
import { calcVanna, calcCharm } from '../lib/blackScholes'
import { cacheGet, cacheSet } from '../lib/cacheStore'
import { marketState, newsSnapshot } from './marketState'
import { calculateMaxPain } from '../lib/maxPainCalculator'
import type { MaxPainResult } from '../lib/maxPainCalculator'

export type { GEXProfile }

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
  /** Vanna Exposure in $M (dealers' delta sensitivity to IV; positive = de-hedge buy when IV drops) */
  totalVannaExposure: number
  /** Charm Exposure in $M/day (dealers' delta decay per day; negative = selling pressure into expiry) */
  totalCharmExposure: number
  /** Per-strike VEX/CEX breakdown — top-20 by |vannaExp|. For AI prompt and future charts. */
  vannaByStrike: Array<{ strike: number; vannaExp: number; charmExp: number }>
  /** Volatility Trigger — GEX-weighted average price of the 3 strikes nearest the flipPoint.
   *  SPY > VT → long gamma regime (dealers suppress vol; favorable for premium selling).
   *  SPY < VT → short gamma regime (dealers amplify moves; increase margin or veto). */
  volatilityTrigger: number
  /** Max Pain — strike where total ITM option pain is minimized (market maker minimum payout). */
  maxPain: MaxPainResult | null
}

const CACHE_TTL_MS = 5 * 60_000  // 5 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Volatility Trigger — GEX-weighted average of the 3 strikes closest to refPrice.
 * refPrice: flipPoint ?? zeroGammaLevel ?? spotPrice.
 * Falls back to refPrice if byStrike is empty or all weights are zero.
 */
function calcVolatilityTrigger(
  byStrike: Array<{ strike: number; netGEX: number }>,
  refPrice: number,
): number {
  const candidates = byStrike
    .filter((s) => Math.abs(s.netGEX) > 0)
    .sort((a, b) => Math.abs(a.strike - refPrice) - Math.abs(b.strike - refPrice))
    .slice(0, 3)
  if (candidates.length === 0) return refPrice
  const totalWeight = candidates.reduce((sum, s) => sum + Math.abs(s.netGEX), 0)
  if (totalWeight === 0) return refPrice
  const vt = candidates.reduce((sum, s) => sum + s.strike * Math.abs(s.netGEX), 0) / totalWeight
  return Math.round(vt * 100) / 100
}

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

  // 8. Vanna & Charm Exposure (same sign convention as GEX: call +1, put -1)
  let totalVEX = 0
  let totalCEX = 0
  const vannaMap = new Map<number, { vannaExp: number; charmExp: number }>()
  for (const c of zglContracts) {
    const vanna = calcVanna(spotPrice, c.strike, c.T, r, c.iv)
    const charm = calcCharm(spotPrice, c.strike, c.T, r, c.iv)
    const sign = c.type === 'call' ? 1 : -1
    const notional = c.oi * 100 * spotPrice
    totalVEX += sign * notional * vanna
    totalCEX += sign * notional * (charm / 365)  // charm per day
    // per-strike accumulation
    const existing = vannaMap.get(c.strike) ?? { vannaExp: 0, charmExp: 0 }
    existing.vannaExp += sign * notional * vanna / 1_000_000
    existing.charmExp += sign * notional * (charm / 365) / 1_000_000
    vannaMap.set(c.strike, existing)
  }
  const totalVannaExposure = Math.round((totalVEX / 1_000_000) * 100) / 100   // $M
  const totalCharmExposure = Math.round((totalCEX / 1_000_000) * 100) / 100   // $M/day
  const vannaByStrike = Array.from(vannaMap.entries())
    .map(([strike, v]) => ({
      strike,
      vannaExp: Math.round(v.vannaExp * 100) / 100,
      charmExp: Math.round(v.charmExp * 100) / 100,
    }))
    .sort((a, b) => Math.abs(b.vannaExp) - Math.abs(a.vannaExp))
    .slice(0, 20)

  const vtRefPrice = profile.flipPoint ?? profile.zeroGammaLevel ?? spotPrice
  const volatilityTrigger = calcVolatilityTrigger(profile.byStrike, vtRefPrice)

  const maxPain = calculateMaxPain(
    profile.byStrike.map((s) => ({ strike: s.strike, callOI: s.callOI, putOI: s.putOI })),
    spotPrice,
  )

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
    totalVannaExposure,
    totalCharmExposure,
    vannaByStrike,
    volatilityTrigger,
    maxPain,
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

// ---------------------------------------------------------------------------
// Multi-expiration GEX
// ---------------------------------------------------------------------------

export interface GEXByExpiration {
  dte0:  DailyGexResult | null   // 0DTE (today)
  dte1:  DailyGexResult | null   // nearest expiration ≥ 1 day
  dte7:  DailyGexResult | null   // nearest expiration ≥ 7 days
  dte21: DailyGexResult | null   // nearest expiration ≥ 21 days
  dte45: DailyGexResult | null   // nearest expiration ≥ 45 days
  all:   DailyGexResult | null   // aggregated GEX across all buckets above
}

/** Returns the nearest expiration date with DTE ≥ minDTE, or null if none found. */
function resolveExpirationByMinDTE(
  expirations: string[],
  minDTE: number,
): string | null {
  const today = new Date().toISOString().slice(0, 10)
  const msPerDay = 86_400_000

  const candidates = expirations
    .filter((d) => {
      const dte = Math.round((new Date(d).getTime() - new Date(today).getTime()) / msPerDay)
      return dte >= minDTE
    })
    .sort()

  return candidates[0] ?? null
}

/**
 * Calculates GEX for a specific expiration date without using the global `gex:daily` cache.
 * Uses per-expiration cache key `gex:exp:${symbol}:${expiration}` (TTL 5min).
 */
async function calculateGexForExpiration(
  symbol: string,
  expiration: string,
  spotPrice: number,
): Promise<DailyGexResult | null> {
  const cacheKey = `gex:exp:${symbol}:${expiration}`
  const cached = await cacheGet<DailyGexResult>(cacheKey)
  if (cached) return cached

  const client = getTradierClient()
  const options = await client.getOptionChain(symbol, expiration)
  if (options.length === 0) {
    console.warn(`[GexService] Empty chain for ${symbol} ${expiration}`)
    return null
  }

  const today = new Date().toISOString().slice(0, 10)
  const msPerDay = 86_400_000
  const dteMs = new Date(expiration).getTime() - new Date(today).getTime()
  const dte = Math.max(0, Math.round(dteMs / msPerDay))
  const T = dte === 0 ? 0.5 / 365 : dte / 365
  const r = getRiskFreeRate()

  const strikeMap = new Map<
    number,
    { callOI: number; callGamma: number; putOI: number; putGamma: number }
  >()
  const zglContracts: ZeroGammaContract[] = []

  for (const opt of options) {
    const entry = strikeMap.get(opt.strike) ?? { callOI: 0, callGamma: 0, putOI: 0, putGamma: 0 }
    if (opt.option_type === 'call') {
      entry.callOI = opt.open_interest ?? 0
      entry.callGamma = opt.greeks?.gamma ?? 0
    } else {
      entry.putOI = opt.open_interest ?? 0
      entry.putGamma = opt.greeks?.gamma ?? 0
    }
    strikeMap.set(opt.strike, entry)

    const oi = opt.open_interest ?? 0
    if (oi === 0) continue
    const iv =
      (opt.greeks?.smv_vol ?? 0) > 0.005 ? opt.greeks!.smv_vol :
      (opt.greeks?.mid_iv  ?? 0) > 0.005 ? opt.greeks!.mid_iv  :
      (opt.greeks?.bid_iv  ?? 0) > 0.005 ? opt.greeks!.bid_iv  :
      0.18
    zglContracts.push({ strike: opt.strike, type: opt.option_type, oi, iv, T })
  }

  const strikeInputs = Array.from(strikeMap.entries()).map(([strike, data]) => ({ strike, ...data }))
  const hasOI = strikeInputs.some((s) => s.callOI > 0 || s.putOI > 0)
  if (!hasOI) return null

  const zeroGammaLevel = await findZeroGammaLevel(zglContracts, spotPrice, r)
  const profile = calculateGEX(strikeInputs, spotPrice, zeroGammaLevel)

  let totalVEX = 0
  let totalCEX = 0
  const vannaMapExp = new Map<number, { vannaExp: number; charmExp: number }>()
  for (const c of zglContracts) {
    const vanna = calcVanna(spotPrice, c.strike, c.T, r, c.iv)
    const charm = calcCharm(spotPrice, c.strike, c.T, r, c.iv)
    const sign = c.type === 'call' ? 1 : -1
    const notional = c.oi * 100 * spotPrice
    totalVEX += sign * notional * vanna
    totalCEX += sign * notional * (charm / 365)
    const existing = vannaMapExp.get(c.strike) ?? { vannaExp: 0, charmExp: 0 }
    existing.vannaExp += sign * notional * vanna / 1_000_000
    existing.charmExp += sign * notional * (charm / 365) / 1_000_000
    vannaMapExp.set(c.strike, existing)
  }
  const totalVannaExposure = Math.round((totalVEX / 1_000_000) * 100) / 100
  const totalCharmExposure = Math.round((totalCEX / 1_000_000) * 100) / 100
  const vannaByStrikeExp = Array.from(vannaMapExp.entries())
    .map(([strike, v]) => ({
      strike,
      vannaExp: Math.round(v.vannaExp * 100) / 100,
      charmExp: Math.round(v.charmExp * 100) / 100,
    }))
    .sort((a, b) => Math.abs(b.vannaExp) - Math.abs(a.vannaExp))
    .slice(0, 20)

  const vtRefPriceExp = profile.flipPoint ?? profile.zeroGammaLevel ?? spotPrice
  const volatilityTriggerExp = calcVolatilityTrigger(profile.byStrike, vtRefPriceExp)

  const maxPainExp = calculateMaxPain(
    profile.byStrike.map((s) => ({ strike: s.strike, callOI: s.callOI, putOI: s.putOI })),
    spotPrice,
  )

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
    totalVannaExposure,
    totalCharmExposure,
    vannaByStrike: vannaByStrikeExp,
    volatilityTrigger: volatilityTriggerExp,
    maxPain: maxPainExp,
  }

  await cacheSet(cacheKey, result, CACHE_TTL_MS, 'gex-service')
  return result
}

/**
 * Calculates GEX across multiple DTE buckets in parallel.
 * Results are broadcast as `gexByExpiration` in the `advanced-metrics` SSE event.
 */
export async function calculateAllExpirationsGex(symbol: string): Promise<GEXByExpiration> {
  if (!CONFIG.TRADIER_API_KEY) {
    return { dte0: null, dte1: null, dte7: null, dte21: null, dte45: null, all: null }
  }

  const client = getTradierClient()
  const expirations = await client.getExpirations(symbol)
  if (expirations.length === 0) {
    return { dte0: null, dte1: null, dte7: null, dte21: null, dte45: null, all: null }
  }

  // Resolve spot price once
  let spotPrice = marketState.spy.last ?? 0
  if (spotPrice <= 0) {
    const quotes = await client.getQuotes(symbol)
    spotPrice = quotes[0]?.last ?? 0
  }
  if (spotPrice <= 0) {
    return { dte0: null, dte1: null, dte7: null, dte21: null, dte45: null, all: null }
  }

  const today = new Date().toISOString().slice(0, 10)
  const exp0 = expirations.includes(today) ? today : null
  const exp1   = resolveExpirationByMinDTE(expirations, 1)
  const exp7   = resolveExpirationByMinDTE(expirations, 7)
  const exp21  = resolveExpirationByMinDTE(expirations, 21)
  const exp45  = resolveExpirationByMinDTE(expirations, 45)

  const [r0, r1, r7, r21, r45] = await Promise.allSettled([
    exp0  ? calculateGexForExpiration(symbol, exp0,  spotPrice) : Promise.resolve(null),
    exp1  ? calculateGexForExpiration(symbol, exp1,  spotPrice) : Promise.resolve(null),
    exp7  ? calculateGexForExpiration(symbol, exp7,  spotPrice) : Promise.resolve(null),
    exp21 ? calculateGexForExpiration(symbol, exp21, spotPrice) : Promise.resolve(null),
    exp45 ? calculateGexForExpiration(symbol, exp45, spotPrice) : Promise.resolve(null),
  ])

  const dte0  = r0.status  === 'fulfilled' ? r0.value  : null
  const dte1  = r1.status  === 'fulfilled' ? r1.value  : null
  const dte7  = r7.status  === 'fulfilled' ? r7.value  : null
  const dte21 = r21.status === 'fulfilled' ? r21.value : null
  const dte45 = r45.status === 'fulfilled' ? r45.value : null

  // Build aggregated "all" GEX by combining strike maps from all non-null buckets
  const buckets = [dte0, dte1, dte7, dte21, dte45].filter(Boolean) as DailyGexResult[]
  let all: DailyGexResult | null = null

  if (buckets.length > 0) {
    const r = getRiskFreeRate()
    const aggMap = new Map<number, { callOI: number; callGamma: number; putOI: number; putGamma: number }>()
    const aggZgl: ZeroGammaContract[] = []

    // Collect unique expirations to avoid double-counting when two buckets share same date
    const seenExp = new Set<string>()
    for (const bucket of buckets) {
      if (seenExp.has(bucket.expiration)) continue
      seenExp.add(bucket.expiration)

      for (const s of bucket.profile.byStrike) {
        const existing = aggMap.get(s.strike) ?? { callOI: 0, callGamma: 0, putOI: 0, putGamma: 0 }
        existing.callOI += s.callOI
        existing.putOI  += s.putOI
        // Gamma per-strike is accumulated as weighted average (OI-weighted)
        // For the aggregated profile we reuse the gamma from the first bucket that set this strike
        if (s.callOI > 0 && existing.callGamma === 0) existing.callGamma = s.callGEX / (s.callOI * (100 * spotPrice * spotPrice / 1_000_000) || 1)
        if (s.putOI  > 0 && existing.putGamma  === 0) existing.putGamma  = Math.abs(s.putGEX)  / (s.putOI  * (100 * spotPrice * spotPrice / 1_000_000) || 1)
        aggMap.set(s.strike, existing)
      }

      // Collect ZGL contracts from the bucket's underlying options (using profile data as proxy)
      // Since we don't re-fetch, we skip ZGL for the aggregated bucket
    }

    const strikeInputs = Array.from(aggMap.entries()).map(([strike, data]) => ({ strike, ...data }))
    const hasOI = strikeInputs.some((s) => s.callOI > 0 || s.putOI > 0)

    if (hasOI) {
      const zgl = aggZgl.length > 0 ? await findZeroGammaLevel(aggZgl, spotPrice, r) : null
      const profile = calculateGEX(strikeInputs, spotPrice, zgl)
      const totalVannaExposure = Math.round(buckets.reduce((sum, b) => sum + (b.totalVannaExposure ?? 0), 0) * 100) / 100
      const totalCharmExposure = Math.round(buckets.reduce((sum, b) => sum + (b.totalCharmExposure ?? 0), 0) * 100) / 100
      // Merge per-strike vannaByStrike across buckets (sum same strikes from different expirations)
      const aggVannaMap = new Map<number, { vannaExp: number; charmExp: number }>()
      for (const b of buckets) {
        for (const v of (b.vannaByStrike ?? [])) {
          const ex = aggVannaMap.get(v.strike) ?? { vannaExp: 0, charmExp: 0 }
          ex.vannaExp += v.vannaExp
          ex.charmExp += v.charmExp
          aggVannaMap.set(v.strike, ex)
        }
      }
      const vannaByStrikeAll = Array.from(aggVannaMap.entries())
        .map(([strike, v]) => ({
          strike,
          vannaExp: Math.round(v.vannaExp * 100) / 100,
          charmExp: Math.round(v.charmExp * 100) / 100,
        }))
        .sort((a, b) => Math.abs(b.vannaExp) - Math.abs(a.vannaExp))
        .slice(0, 20)
      const vtRefAll = profile.flipPoint ?? profile.zeroGammaLevel ?? spotPrice
      const volatilityTriggerAll = calcVolatilityTrigger(profile.byStrike, vtRefAll)
      const maxPainAll = calculateMaxPain(
        profile.byStrike.map((s) => ({ strike: s.strike, callOI: s.callOI, putOI: s.putOI })),
        spotPrice,
      )
      all = {
        totalNetGamma: profile.totalGEX,
        callWall: profile.callWall,
        putWall: profile.putWall,
        maxGexStrike: profile.maxGammaStrike,
        minGexStrike: profile.minGammaStrike,
        flipPoint: profile.flipPoint,
        zeroGammaLevel: profile.zeroGammaLevel,
        regime: profile.regime,
        expiration: 'ALL',
        profile,
        calculatedAt: profile.calculatedAt,
        totalVannaExposure,
        totalCharmExposure,
        vannaByStrike: vannaByStrikeAll,
        volatilityTrigger: volatilityTriggerAll,
        maxPain: maxPainAll,
      }
    }
  }

  console.log(
    `[GexService] Multi-exp GEX: ` +
    `0DTE=${dte0 ? dte0.regime : 'n/a'} ` +
    `1D=${dte1 ? dte1.regime : 'n/a'} ` +
    `7D=${dte7 ? dte7.regime : 'n/a'} ` +
    `21D=${dte21 ? dte21.regime : 'n/a'} ` +
    `45D=${dte45 ? dte45.regime : 'n/a'} ` +
    `ALL=${all ? all.regime : 'n/a'}`,
  )

  return { dte0, dte1, dte7, dte21, dte45, all }
}

// ===========================================================================
// Dynamic GEX — term structure scanner (0–60 DTE, structural landmarks)
// ===========================================================================

export interface GEXExpirationEntry {
  expiration: string        // YYYY-MM-DD
  dte: number               // days to expiry (0 = today in ET)
  isMonthlyOPEX: boolean    // true if 3rd Friday of the month
  isWeeklyOPEX: boolean     // true if any Friday
  label: string             // e.g. "MAR-14 (7D) OPEX" or "0DTE"
  gex: DailyGexResult
  gammaAnomaly: number      // |netGamma| normalised 0–1 across all selected expirations
}

export type GEXDynamic = GEXExpirationEntry[]

/** Returns DTE relative to today (ET time zone). Negative = past expiration. */
function calcDTEFromDate(expiration: string): number {
  const todayET = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2')
  const msPerDay = 86_400_000
  return Math.round((new Date(expiration).getTime() - new Date(todayET).getTime()) / msPerDay)
}

/** Returns true if `dateStr` (YYYY-MM-DD) is the 3rd Friday of its month. */
function isMonthlyOPEX(dateStr: string): boolean {
  const d = new Date(dateStr + 'T12:00:00Z')
  if (d.getUTCDay() !== 5) return false  // not a Friday
  const day = d.getUTCDate()
  return day >= 15 && day <= 21
}

/** Returns true if `dateStr` is any Friday. */
function isWeeklyOPEX(dateStr: string): boolean {
  return new Date(dateStr + 'T12:00:00Z').getUTCDay() === 5
}

/** Builds a human-readable label for an expiration entry. */
function buildExpirationLabel(dateStr: string, dte: number, monthly: boolean): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  const monthAbbr = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'][d.getUTCMonth()]
  const day = String(d.getUTCDate()).padStart(2, '0')
  const dteStr = dte === 0 ? '0DTE' : `${dte}D`
  const opexSuffix = monthly ? ' OPEX' : ''
  return `${monthAbbr}-${day} (${dteStr})${opexSuffix}`
}

/**
 * Selects up to 8 structurally significant expirations from the available list.
 * Targets DTE landmarks: [0, 3, 7, 14, 21, 35, 45, 60].
 * Prefers OPEX mensais when two expirations are equidistant from a landmark.
 */
export function selectStructuralExpirations(expirations: string[]): string[] {
  const LANDMARKS = [0, 3, 7, 14, 21, 35, 45, 60]
  const MAX_COUNT = 8

  const candidates = expirations
    .map((exp) => ({ exp, dte: calcDTEFromDate(exp), monthly: isMonthlyOPEX(exp) }))
    .filter((c) => c.dte >= 0 && c.dte <= 60)
    .sort((a, b) => a.dte - b.dte)

  if (candidates.length === 0) return []

  const selected = new Set<string>()
  for (const landmark of LANDMARKS) {
    let best: { exp: string; dist: number; monthly: boolean } | null = null
    for (const c of candidates) {
      const dist = Math.abs(c.dte - landmark)
      if (!best) {
        best = { exp: c.exp, dist, monthly: c.monthly }
      } else if (dist < best.dist) {
        best = { exp: c.exp, dist, monthly: c.monthly }
      } else if (dist === best.dist && c.monthly && !best.monthly) {
        // Prefer OPEX mensal on equidistant tie
        best = { exp: c.exp, dist, monthly: c.monthly }
      }
    }
    if (best) selected.add(best.exp)
    if (selected.size >= MAX_COUNT) break
  }

  return Array.from(selected).sort()
}

/**
 * Fetches all available expirations (0–60 DTE), selects the most structurally
 * significant ones via selectStructuralExpirations(), computes GEX for each in
 * parallel, and returns a GEXDynamic array sorted by DTE, annotated with metadata
 * and gammaAnomaly scores (0–1).
 */
export async function calculateDynamicGex(symbol: string): Promise<GEXDynamic> {
  if (!CONFIG.TRADIER_API_KEY) {
    console.warn('[GexService] TRADIER_API_KEY not set — skipping dynamic GEX')
    return []
  }

  const client = getTradierClient()
  const allExpirations = await client.getExpirations(symbol)
  if (allExpirations.length === 0) return []

  const selected = selectStructuralExpirations(allExpirations)
  if (selected.length === 0) return []

  // Resolve spot price once for all parallel calculations
  let spotPrice = marketState.spy.last ?? 0
  if (spotPrice <= 0) {
    const quotes = await client.getQuotes(symbol)
    spotPrice = quotes[0]?.last ?? 0
  }
  if (spotPrice <= 0) return []

  console.log(
    `[GexService] Dynamic GEX — expirations selecionadas: [${
      selected.map((e) => `${e}(${calcDTEFromDate(e)}D)`).join(', ')
    }]`,
  )

  const results = await Promise.allSettled(
    selected.map((exp) => calculateGexForExpiration(symbol, exp, spotPrice)),
  )

  const entries: GEXExpirationEntry[] = []
  for (let i = 0; i < selected.length; i++) {
    const r = results[i]
    if (r.status === 'rejected' || r.value === null) continue
    const expStr = selected[i]
    const dte = calcDTEFromDate(expStr)
    const monthly = isMonthlyOPEX(expStr)
    entries.push({
      expiration: expStr,
      dte,
      isMonthlyOPEX: monthly,
      isWeeklyOPEX: isWeeklyOPEX(expStr),
      label: buildExpirationLabel(expStr, dte, monthly),
      gex: r.value,
      gammaAnomaly: 0,  // normalised below
    })
  }

  if (entries.length > 0) {
    const maxAbs = Math.max(...entries.map((e) => Math.abs(e.gex.totalNetGamma)))
    if (maxAbs > 0) {
      for (const entry of entries) {
        entry.gammaAnomaly = Math.round((Math.abs(entry.gex.totalNetGamma) / maxAbs) * 100) / 100
      }
    }
  }

  entries.sort((a, b) => a.dte - b.dte)

  console.log(
    `[GexService] Dynamic GEX resultado: ` +
    entries.map((e) =>
      `${e.label}=${e.gex.regime}(${e.gex.totalNetGamma >= 0 ? '+' : ''}$${e.gex.totalNetGamma}M anomaly=${e.gammaAnomaly})`,
    ).join(' '),
  )

  return entries
}

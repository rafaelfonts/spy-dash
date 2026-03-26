// backend/src/lib/optionScreenerFilters.ts

import type { TradierOption } from './tradierClient'
import type { OptionCandidate } from '../types/optionScreener'

export interface FilterConfig {
  minIVR: number
  maxIVR: number
  minOI: number
  maxBidAskAbsolute: number    // e.g. 0.10
  maxBidAskPct: number         // e.g. 0.05 = 5%
  minOptionVolume: number
  minUnderlyingVolume: number
  minPrice: number
}

export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  minIVR: 40,
  maxIVR: 100,
  minOI: 10_000,
  maxBidAskAbsolute: 0.10,
  maxBidAskPct: 0.05,
  minOptionVolume: 200,
  minUnderlyingVolume: 500_000,
  minPrice: 20,
}

// Relaxed config for after-hours scans: volume/spread data is stale when market is closed.
// IVR and OI are structural (don't reset daily) so those thresholds are kept.
export const CLOSED_MARKET_FILTER_CONFIG: FilterConfig = {
  minIVR: 30,
  maxIVR: 100,
  minOI: 1_000,
  maxBidAskAbsolute: 1.00,
  maxBidAskPct: 0.50,
  minOptionVolume: 0,
  minUnderlyingVolume: 100_000,
  minPrice: 15,
}

/**
 * Find ATM option (call or put) closest to spot price.
 * Returns the option or null if chain is empty.
 */
export function findATMOption(options: TradierOption[], spot: number): TradierOption | null {
  if (options.length === 0) return null
  return options.reduce((best, opt) => {
    const d = Math.abs(opt.strike - spot)
    const bd = Math.abs(best.strike - spot)
    return d < bd ? opt : best
  })
}

/**
 * Returns true if a ticker's ATM option passes all liquidity filters.
 */
export function passesFilters(
  atmOption: TradierOption,
  underlyingVolume: number,
  underlyingPrice: number,
  ivRank: number,
  config: FilterConfig = DEFAULT_FILTER_CONFIG,
): boolean {
  if (underlyingPrice < config.minPrice) return false
  if (underlyingVolume < config.minUnderlyingVolume) return false
  if (ivRank < config.minIVR || ivRank > config.maxIVR) return false
  if (atmOption.open_interest < config.minOI) return false
  if (atmOption.volume < config.minOptionVolume) return false

  const spread = atmOption.ask - atmOption.bid
  if (spread < 0) return false
  if (spread > config.maxBidAskAbsolute) return false

  const midpoint = (atmOption.ask + atmOption.bid) / 2
  if (midpoint > 0 && spread / midpoint > config.maxBidAskPct) return false

  return true
}

/**
 * Compute Liquidity Score 0–100 for a passing candidate.
 *
 * Components:
 *   IVR component    (35pts): ivRank / 100 * 35
 *   Spread component (30pts): max(0, 1 - spread/0.10) * 30
 *   OI component     (20pts): log-scaled, teto 100k OI → 20pts
 *   RVOL component   (15pts): min(1, rvol * 0.5) * 15
 */
export function calculateLiquidityScore(
  ivRank: number,
  spread: number,
  openInterest: number,
  underlyingVolume: number,
  avg20dVolume: number,
): number {
  const ivrScore = (ivRank / 100) * 35

  const spreadScore = Math.max(0, 1 - spread / 0.10) * 30

  // log10(oi/1000) / log10(100) → normalizes 1k OI → 0, 100k OI → 1
  const oiNorm = openInterest > 0
    ? Math.min(1, Math.log10(Math.max(1, openInterest / 1000)) / Math.log10(100))
    : 0
  const oiScore = oiNorm * 20

  const rvol = avg20dVolume > 0 ? underlyingVolume / avg20dVolume : 1
  const rvolScore = Math.min(1, rvol * 0.5) * 15

  return Math.round(ivrScore + spreadScore + oiScore + rvolScore)
}

/**
 * Build OptionCandidate from computed fields.
 */
export function buildCandidate(
  symbol: string,
  price: number,
  ivRank: number,
  atmOption: TradierOption,
  underlyingVolume: number,
  avg20dVolume: number,
  nearestExpiration: string,
): OptionCandidate {
  const spread = atmOption.ask - atmOption.bid
  const midpoint = (atmOption.ask + atmOption.bid) / 2
  const spreadPct = midpoint > 0 ? spread / midpoint : 0

  const liquidityScore = calculateLiquidityScore(
    ivRank,
    spread,
    atmOption.open_interest,
    underlyingVolume,
    avg20dVolume,
  )

  return {
    symbol,
    price,
    ivRank,
    bidAskSpread: spread,
    spreadPct,
    openInterest: atmOption.open_interest,
    optionVolume: atmOption.volume,
    underlyingVolume,
    liquidityScore,
    nearestExpiration,
    lastUpdated: Date.now(),
  }
}

// backend/src/lib/optionScreenerFilters.ts

import type { TradierOption } from './tradierClient'
import type { OptionCandidate } from '../types/optionScreener'
import { ETF_TICKERS } from '../types/optionScreener'

export interface FilterConfig {
  minIVR: number
  maxIVR: number
  minOI: number
  maxBidAskAbsolute: number    // e.g. 0.10
  maxBidAskPct: number         // e.g. 0.05 = 5%
  minOptionVolume: number
  minUnderlyingVolume: number
  minPrice: number
  tickerType?: 'etf' | 'single_stock'        // if 'etf': apply maxBidAskAbsolute; if 'single_stock': skip absolute spread check
  minIRP?: number                              // optional IV Risk Premium filter (e.g. 0 = no negative IRP)
  termStructureVetoEnabled?: boolean           // if true, flag when TSS < -0.03
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
 * Returns passes/termStructureInverted if a ticker's ATM option passes all liquidity filters.
 */
export function passesFilters(
  atmOption: TradierOption,
  underlyingVolume: number,
  underlyingPrice: number,
  ivRank: number,
  config: FilterConfig = DEFAULT_FILTER_CONFIG,
  irp?: number | null,
): { passes: boolean; termStructureInverted: boolean } {
  if (underlyingPrice < config.minPrice) return { passes: false, termStructureInverted: false }
  if (underlyingVolume < config.minUnderlyingVolume) return { passes: false, termStructureInverted: false }
  if (ivRank < config.minIVR || ivRank > config.maxIVR) return { passes: false, termStructureInverted: false }
  if (atmOption.open_interest < config.minOI) return { passes: false, termStructureInverted: false }
  if (atmOption.volume < config.minOptionVolume) return { passes: false, termStructureInverted: false }

  const spread = atmOption.ask - atmOption.bid
  if (spread < 0) return { passes: false, termStructureInverted: false }

  // Only apply maxBidAskAbsolute for ETFs or when tickerType is not explicitly 'single_stock'
  if (config.tickerType !== 'single_stock' && spread > config.maxBidAskAbsolute) return { passes: false, termStructureInverted: false }

  const midpoint = (atmOption.ask + atmOption.bid) / 2
  if (midpoint > 0 && spread / midpoint > config.maxBidAskPct) return { passes: false, termStructureInverted: false }

  // IRP check: reject if IRP is below the minimum threshold
  if (config.minIRP !== undefined && irp !== null && irp !== undefined && irp < config.minIRP) return { passes: false, termStructureInverted: false }

  return { passes: true, termStructureInverted: false }
}

/**
 * Compute Liquidity Score 0–100 for a passing candidate.
 *
 * Components:
 *   IVR component     (35pts): ivRank / 100 * 35
 *   Spread component  (30pts): max(0, 1 - spread/0.10) * 30
 *   OI component      (20pts): log-scaled, teto 100k OI → 20pts
 *   RVOL component    (10pts): min(1, rvol * 0.5) * 10
 *   IRP/RVP component (10pts): bonus if irp > 0 AND rvp < 40 (premium seller setup)
 */
export function calculateLiquidityScore(
  ivRank: number,
  spread: number,
  openInterest: number,
  underlyingVolume: number,
  avg20dVolume: number,
  irp?: number | null,
  rvp?: number | null,
): number {
  const ivrScore = (ivRank / 100) * 35

  const spreadScore = Math.max(0, 1 - spread / 0.10) * 30

  // log10(oi/1000) / log10(100) → normalizes 1k OI → 0, 100k OI → 1
  const oiNorm = openInterest > 0
    ? Math.min(1, Math.log10(Math.max(1, openInterest / 1000)) / Math.log10(100))
    : 0
  const oiScore = oiNorm * 20

  const rvol = avg20dVolume > 0 ? underlyingVolume / avg20dVolume : 1
  const rvolScore = Math.min(1, rvol * 0.5) * 10   // reduced from 15 to 10

  // IRP/RVP bonus: both conditions met = 10pts, one = 5pts, neither = 0pts
  const irpOk = typeof irp === 'number' && isFinite(irp) && irp > 0
  const rvpOk = typeof rvp === 'number' && isFinite(rvp) && rvp < 40
  const irpRvpScore = (irpOk && rvpOk) ? 10 : (irpOk || rvpOk) ? 5 : 0

  return Math.round(ivrScore + spreadScore + oiScore + rvolScore + irpRvpScore)
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
  ivRankSource: 'tastytrade' | 'chain_fallback',
  irp?: number | null,
  rvp?: number | null,
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
    irp,
    rvp,
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
    ivRankSource,
    lastUpdated: Date.now(),
  }
}

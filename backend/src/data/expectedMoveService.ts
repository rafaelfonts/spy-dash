/**
 * ExpectedMoveService — Expected Move (1σ cone) from Tradier ATM straddle.
 *
 * Supports both swing expirations (21/45 DTE) and full scan (0–60 DTE) with iv_efficiency score.
 * EM = Call_ATM_mid + Put_ATM_mid. Cone is SPY ± EM; short put strike should be below SPY − EM.
 */

import { CONFIG } from '../config'
import { getTradierClient } from '../lib/tradierClient'
import type { TradierOption } from '../lib/tradierClient'
import { marketState } from './marketState'

export interface ExpectedMoveEntry {
  expirationDate: string
  dte: number
  expectedMove: number
  atmStrike: number
  /** IV efficiency: EM / (spot × √(dte/365)); higher = more premium relative to expected move. Set by getExpectedMoveAllExpirations. */
  ivEfficiency?: number
}

const MS_PER_DAY = 86_400_000

/** Returns the nearest expiration date with DTE ≥ minDTE, or null if none found. */
function resolveExpirationByMinDTE(
  expirations: string[],
  minDTE: number,
): string | null {
  const today = new Date().toISOString().slice(0, 10)
  const candidates = expirations
    .filter((d) => {
      const dte = Math.round((new Date(d).getTime() - new Date(today).getTime()) / MS_PER_DAY)
      return dte >= minDTE
    })
    .sort()
  return candidates[0] ?? null
}

function dteFromExpiration(expirationDate: string): number {
  const today = new Date().toISOString().slice(0, 10)
  const dteMs = new Date(expirationDate).getTime() - new Date(today).getTime()
  return Math.max(0, Math.round(dteMs / MS_PER_DAY))
}

/** Mid price from bid/ask; fallback to last if bid/ask missing or zero. */
function midPrice(opt: TradierOption): number {
  const bid = opt.bid ?? 0
  const ask = opt.ask ?? 0
  if (bid > 0 && ask > 0) return (bid + ask) / 2
  return opt.last ?? 0
}

/**
 * Computes Expected Move (ATM straddle price) for the given expiration from Tradier chain.
 * Returns null if chain is empty or no valid ATM pair.
 */
async function expectedMoveForExpiration(
  symbol: string,
  expiration: string,
  spot: number,
): Promise<ExpectedMoveEntry | null> {
  const client = getTradierClient()
  const options = await client.getOptionChain(symbol, expiration)
  if (options.length === 0) return null

  const strikes = [...new Set(options.map((o) => o.strike))]
  const atmStrike = strikes.reduce((best, s) =>
    Math.abs(s - spot) < Math.abs(best - spot) ? s : best,
  )

  const call = options.find((o) => o.option_type === 'call' && o.strike === atmStrike)
  const put = options.find((o) => o.option_type === 'put' && o.strike === atmStrike)
  if (!call || !put) return null

  const callMid = midPrice(call)
  const putMid = midPrice(put)
  if (callMid <= 0 && putMid <= 0) return null

  const expectedMove = callMid + putMid
  const dte = dteFromExpiration(expiration)

  return { expirationDate: expiration, dte, expectedMove, atmStrike }
}

/** IV efficiency = EM / (spot × √(dte/365)); higher means more premium per unit of expected move. */
function computeIvEfficiency(expectedMove: number, spot: number, dte: number): number {
  if (spot <= 0 || dte <= 0) return 0
  const sqrtT = Math.sqrt(dte / 365)
  const denominator = spot * sqrtT
  if (denominator <= 0) return 0
  return expectedMove / denominator
}

/**
 * Returns Expected Move (1σ) for 21 and 45 DTE expirations using Tradier option chains.
 * Uses marketState.spy.last for spot; falls back to Tradier SPY quote if needed.
 */
export async function getExpectedMoveForSwingExpirations(
  symbol: string,
): Promise<ExpectedMoveEntry[]> {
  if (!CONFIG.TRADIER_API_KEY) return []

  const client = getTradierClient()
  let spot = marketState.spy.last ?? 0
  if (spot <= 0) {
    const quotes = await client.getQuotes(symbol)
    spot = quotes[0]?.last ?? 0
  }
  if (spot <= 0) {
    console.warn('[ExpectedMove] No spot price available — skipping')
    return []
  }

  const expirations = await client.getExpirations(symbol)
  if (expirations.length === 0) return []

  const exp21 = resolveExpirationByMinDTE(expirations, 21)
  const exp45 = resolveExpirationByMinDTE(expirations, 45)

  const dates = [...new Set([exp21, exp45].filter(Boolean))] as string[]
  const results: ExpectedMoveEntry[] = []

  for (const expiration of dates) {
    const entry = await expectedMoveForExpiration(symbol, expiration, spot)
    if (entry) results.push(entry)
  }

  if (results.length > 0) {
    console.log(
      `[ExpectedMove] ${symbol} 21/45 DTE: ${results.map((r) => `${r.dte}D $${r.expectedMove.toFixed(2)}`).join(', ')}`,
    )
  }
  return results
}

const MAX_DTE_ALL_EXPIRATIONS = 60
const MAX_EXPIRATIONS_TO_FETCH = 12

/**
 * Returns Expected Move (1σ) for ALL expirations from 0 to ~60 DTE, with iv_efficiency score per expiration.
 * Used by the AI to scan all DTEs and pick the one with clearest opportunity.
 */
export async function getExpectedMoveAllExpirations(
  symbol: string,
): Promise<ExpectedMoveEntry[]> {
  if (!CONFIG.TRADIER_API_KEY) return []

  const client = getTradierClient()
  let spot = marketState.spy.last ?? 0
  if (spot <= 0) {
    const quotes = await client.getQuotes(symbol)
    spot = quotes[0]?.last ?? 0
  }
  if (spot <= 0) {
    console.warn('[ExpectedMove] No spot price available — skipping all expirations')
    return []
  }

  const expirations = await client.getExpirations(symbol)
  if (expirations.length === 0) return []

  const today = new Date().toISOString().slice(0, 10)
  const candidates = expirations
    .filter((d) => {
      const dte = Math.round((new Date(d).getTime() - new Date(today).getTime()) / MS_PER_DAY)
      return dte >= 0 && dte <= MAX_DTE_ALL_EXPIRATIONS
    })
    .sort()
    .slice(0, MAX_EXPIRATIONS_TO_FETCH)

  const results: ExpectedMoveEntry[] = []
  for (const expiration of candidates) {
    const entry = await expectedMoveForExpiration(symbol, expiration, spot)
    if (entry) {
      entry.ivEfficiency = computeIvEfficiency(entry.expectedMove, spot, entry.dte)
      results.push(entry)
    }
  }

  if (results.length > 0) {
    console.log(
      `[ExpectedMove] ${symbol} all DTE (0-${MAX_DTE_ALL_EXPIRATIONS}): ${results.length} expirations, ` +
      results.map((r) => `${r.dte}D $${r.expectedMove.toFixed(2)} eff=${r.ivEfficiency?.toFixed(3) ?? '—'}`).join('; '),
    )
  }
  return results
}

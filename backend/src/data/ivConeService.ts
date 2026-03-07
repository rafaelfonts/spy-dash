/**
 * ivConeService — IV vs Historical Volatility cone.
 *
 * Calculates HV10, HV20, HV60 locally from priceHistory (annualised log-return std dev).
 * HV30 comes from Tastytrade (more accurate — uses daily closes, not 1-min bars).
 * Compares IVx (Tastytrade composite IV index) against each HV period.
 *
 * coneLabel:
 *   'rich'  — IV > 1.30× HV30 (IV inflated vs realised vol — edge for sellers is smaller)
 *   'cheap' — IV < 0.80× HV30 (IV deflated vs realised vol — good for buyers)
 *   'fair'  — otherwise
 */

import { marketState } from './marketState'
import { cacheSet } from '../lib/cacheStore'

const CACHE_KEY = 'iv_cone_snapshot'
const CACHE_TTL_MS = 60 * 60 * 1000  // 60 min

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IVConeSnapshot {
  hv10:  number | null   // 10-day HV (local calculation)
  hv20:  number | null   // 20-day HV (local calculation)
  hv30:  number | null   // 30-day HV (Tastytrade API — source of truth)
  hv60:  number | null   // 60-day HV (local calculation)
  ivx:   number | null   // current IVx from Tastytrade (absolute IV level, %)
  ivVsHv10:  number | null   // ivx / hv10 ratio
  ivVsHv20:  number | null   // ivx / hv20 ratio
  ivVsHv30:  number | null   // ivx / hv30 ratio
  ivVsHv60:  number | null   // ivx / hv60 ratio
  coneLabel: 'rich' | 'fair' | 'cheap' | null
  capturedAt: string
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let ivConeSnapshot: IVConeSnapshot | null = null

export function getIVConeSnapshot(): IVConeSnapshot | null {
  return ivConeSnapshot
}

// ---------------------------------------------------------------------------
// HV calculation — annualised std dev of log-returns
// ---------------------------------------------------------------------------

/**
 * Computes HV for a given period from an array of prices.
 * Uses the last `period + 1` prices to compute `period` log-returns.
 * Annualises by √252 (trading days per year).
 * Returns null if insufficient data.
 */
export function computeHV(prices: number[], period: number): number | null {
  if (prices.length < period + 1) return null

  const slice = prices.slice(-(period + 1))
  const logReturns: number[] = []

  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1] <= 0 || slice[i] <= 0) continue
    logReturns.push(Math.log(slice[i] / slice[i - 1]))
  }

  if (logReturns.length < 2) return null

  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length
  const variance = logReturns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (logReturns.length - 1)
  const dailyStd = Math.sqrt(variance)

  // Annualise: 1-min bars → trading minutes per year (252 × 390)
  // But we use the bar count as our "day" proxy — annualise by √252
  const hvAnnualised = dailyStd * Math.sqrt(252) * 100  // in %

  return Math.round(hvAnnualised * 100) / 100
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

export function buildIVConeSnapshot(): IVConeSnapshot | null {
  const prices = marketState.spy.priceHistory.map((pt) => pt.p)
  const ivx   = marketState.ivRank.ivx    // % (e.g. 24.8)
  const hv30tt = marketState.ivRank.hv30  // % from Tastytrade (source of truth)

  if (prices.length < 11) return null  // need at least hv10

  const hv10 = computeHV(prices, 10)
  const hv20 = computeHV(prices, 20)
  const hv60 = computeHV(prices, 60)

  // Use Tastytrade HV30 as the reference (more accurate daily data)
  const hv30 = hv30tt ?? computeHV(prices, 30)

  const ratio = (hv: number | null): number | null => {
    if (ivx == null || hv == null || hv === 0) return null
    return Math.round((ivx / hv) * 100) / 100
  }

  const ivVsHv30 = ratio(hv30)

  const coneLabel: IVConeSnapshot['coneLabel'] =
    ivVsHv30 == null   ? null    :
    ivVsHv30 > 1.30    ? 'rich'  :
    ivVsHv30 < 0.80    ? 'cheap' :
    'fair'

  const snapshot: IVConeSnapshot = {
    hv10,
    hv20,
    hv30,
    hv60,
    ivx,
    ivVsHv10: ratio(hv10),
    ivVsHv20: ratio(hv20),
    ivVsHv30,
    ivVsHv60: ratio(hv60),
    coneLabel,
    capturedAt: new Date().toISOString(),
  }

  ivConeSnapshot = snapshot

  // Persist to Redis (60 min TTL — refreshed every 5-min tick)
  cacheSet(CACHE_KEY, snapshot, CACHE_TTL_MS, 'ivConeService').catch(() => {})

  return snapshot
}

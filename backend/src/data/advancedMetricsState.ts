/**
 * advancedMetricsState — in-memory snapshot for GEX + Volume Profile data.
 *
 * Mirrors the marketState / newsSnapshot pattern: a single module owns the
 * mutable state, updates it atomically, and publishes via the shared emitter.
 * Any number of consumers (SSE, REST, AI analysis) can read the snapshot
 * without triggering a new fetch.
 */

import { emitter } from './marketState'
import type { GEXDynamic } from './gexService'
import type { NoTradeResult, GexComparison, PriceDistribution, SurfaceQuality } from './regimeScorer'
import type { DANResult } from '../lib/danCalculator'
import type { RVOLSnapshot } from './rvolPoller'

export type { GEXDynamic }
export type { NoTradeResult }
export type { DANResult }
export type { RVOLSnapshot }

// ---------------------------------------------------------------------------
// SSE payload shape (what the frontend receives)
// ---------------------------------------------------------------------------

export interface AdvancedMetricsPayload {
  gex: {
    total: number           // total net GEX in $M
    callWall: number        // strike with highest call OI
    putWall: number         // strike with highest put OI
    zeroGamma: number | null // continuous ZGL from BS simulation
    flipPoint: number | null // discrete cumulative-GEX sign-change strike
    regime: 'positive' | 'negative'
    maxGexStrike: number
    minGexStrike: number
    expiration: string      // YYYY-MM-DD
    byStrike: Array<{ strike: number; netGEX: number; callGEX: number; putGEX: number; callOI: number; putOI: number }>
    vannaExposure: number   // VEX total $M (dealers' delta sensitivity to IV)
    charmExposure: number   // CEX total $M/day (dealers' delta decay per day)
    volatilityTrigger: number  // VT: GEX-weighted avg of 3 strikes nearest flipPoint
    maxPain: { maxPainStrike: number; distanceFromSpot: number; distancePct: number; pinRisk: 'high' | 'moderate' | 'low' } | null
  } | null
  profile: {
    poc: number             // Point of Control
    vah: number             // Value Area High
    val: number             // Value Area Low
    totalVolume: number
    barsProcessed: number
  } | null
  putCallRatio: {
    ratio: number
    putVolume: number
    callVolume: number
    label: 'bearish' | 'neutral' | 'bullish'
    expiration: string
  } | null
  gexDynamic: GEXDynamic | null  // dynamic term structure: array of GEXExpirationEntry sorted by DTE (0–60 DTE)
  timestamp: string         // ISO 8601 of last successful calculation
  /** Unified operability signal aggregating all structural vetos. */
  noTrade: NoTradeResult | null
  /** Delta-Adjusted Notional — directional hedge pressure from market makers ($M). */
  dan: DANResult | null
  /** Live regime snapshot computed every tick — available before first AI analysis. */
  regimePreview: {
    score: number
    vannaRegime: 'tailwind' | 'neutral' | 'headwind'
    charmPressure: 'significant' | 'moderate' | 'neutral'
    gexVsYesterday: GexComparison | null
    priceDistribution: PriceDistribution | null
    surfaceQuality: SurfaceQuality | null
  } | null
  /** Whether US equity markets are currently open (09:30–16:00 ET, Mon–Fri). */
  marketOpen: boolean
  /** Relative Volume — SPY institutional flow proxy (todayVol / avg20dVol). */
  rvol: RVOLSnapshot | null
}

// ---------------------------------------------------------------------------
// Module-level snapshot (updated atomically by the poller)
// ---------------------------------------------------------------------------

let snapshot: AdvancedMetricsPayload | null = null
let lastUpdatedAt = 0

export function getAdvancedMetricsSnapshot(): AdvancedMetricsPayload | null {
  return snapshot
}

export function getAdvancedMetricsAge(): number {
  return lastUpdatedAt
}

/**
 * Called by the poller after each successful calculation.
 * Updates the snapshot and broadcasts to all SSE clients via emitter.
 */
export function publishAdvancedMetrics(payload: AdvancedMetricsPayload): void {
  snapshot = payload
  lastUpdatedAt = Date.now()
  emitter.emit('advanced-metrics', payload)
}

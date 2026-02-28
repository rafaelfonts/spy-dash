/**
 * advancedMetricsState — in-memory snapshot for GEX + Volume Profile data.
 *
 * Mirrors the marketState / newsSnapshot pattern: a single module owns the
 * mutable state, updates it atomically, and publishes via the shared emitter.
 * Any number of consumers (SSE, REST, AI analysis) can read the snapshot
 * without triggering a new fetch.
 */

import { emitter } from './marketState'

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
  timestamp: string         // ISO 8601 of last successful calculation
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

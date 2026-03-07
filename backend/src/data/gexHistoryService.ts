/**
 * gexHistoryService — persists a daily GEX snapshot to Redis (7-day TTL)
 * and computes 5-day trend context for injection into the AI prompt.
 *
 * Redis key: gex:history:SPY:YYYY-MM-DD (ET timezone, one snapshot per day)
 * TTL: 7 days (604800000 ms)
 *
 * This is additive to regimeScorer.ts:gexDailyHistory (2-day in-memory, not replaced).
 */

import { cacheGet, cacheSet } from '../lib/cacheStore'

const GEX_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000   // 7 days
const GEX_HISTORY_KEY_PREFIX = 'gex:history:SPY:'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GEXDailySnapshot {
  netGex: number               // $B (totalNetGamma / 1000 to convert from $M)
  callWall: number
  putWall: number
  flipPoint: number | null
  volatilityTrigger: number | null
  zeroGammaLevel: number | null
  vannaExposure: number        // totalVannaExposure ($M)
  charmExposure: number        // totalCharmExposure ($M/day)
  capturedAt: string           // ISO date YYYY-MM-DD (ET timezone)
}

export interface GEXHistoryContext {
  gexTrend: 'accelerating_positive' | 'stable_positive' | 'declining' | 'accelerating_negative'
  gexChangeD1: number          // netGex today - netGex yesterday ($B)
  gexChange5d: number          // netGex today - netGex 5 days ago ($B), 0 if insufficient data
  flipPointTrend: 'rising' | 'stable' | 'falling' | 'unavailable'
  vtTrend: 'rising' | 'stable' | 'falling' | 'unavailable'
  vtChangeD1: number           // volatilityTrigger today - yesterday
  historySummary: string       // human-readable summary for AI prompt
  daysAvailable: number        // how many days of history were loaded (0–5)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getETDateString(): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2')
}

function getETDateMinus(daysBack: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysBack)
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2')
}

function fmt(n: number, decimals = 1): string {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(decimals)}`
}

function trendLabel(a: number | null, b: number | null, threshold = 1): 'rising' | 'stable' | 'falling' | 'unavailable' {
  if (a == null || b == null) return 'unavailable'
  const delta = a - b
  if (delta > threshold) return 'rising'
  if (delta < -threshold) return 'falling'
  return 'stable'
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/** Persist a GEX snapshot to Redis. Key includes the ET date for today. */
export async function saveGEXDailySnapshot(snapshot: GEXDailySnapshot): Promise<void> {
  const key = `${GEX_HISTORY_KEY_PREFIX}${snapshot.capturedAt}`
  await cacheSet(key, snapshot, GEX_HISTORY_TTL_MS, 'gexHistory')
  console.log(`[GEXHistory] Snapshot salvo: ${key} | netGex=${fmt(snapshot.netGex)}B`)
}

/**
 * Load up to `days` daily GEX snapshots from Redis (D-0 through D-(days-1)).
 * Returns array in ascending chronological order (oldest first).
 * Skips missing days (weekends, holidays, server downtime).
 */
export async function loadGEXHistory(days = 5): Promise<GEXDailySnapshot[]> {
  const results: GEXDailySnapshot[] = []
  // Load from oldest to newest
  for (let i = days - 1; i >= 0; i--) {
    const date = getETDateMinus(i)
    const key = `${GEX_HISTORY_KEY_PREFIX}${date}`
    const snap = await cacheGet<GEXDailySnapshot>(key)
    if (snap) results.push(snap)
  }
  return results
}

/**
 * Compute GEX trend context from an array of daily snapshots (oldest first).
 * Returns null if fewer than 2 days are available (no comparison possible).
 */
export function computeGEXHistoryContext(history: GEXDailySnapshot[]): GEXHistoryContext | null {
  if (history.length < 2) return null

  const today     = history[history.length - 1]
  const yesterday = history[history.length - 2]
  const oldest    = history[0]

  const gexChangeD1 = parseFloat((today.netGex - yesterday.netGex).toFixed(2))
  const gexChange5d = history.length >= 5
    ? parseFloat((today.netGex - oldest.netGex).toFixed(2))
    : 0

  // Determine trend
  let gexTrend: GEXHistoryContext['gexTrend']
  if (gexChangeD1 > 0.5 && gexChange5d > 1.0) {
    gexTrend = 'accelerating_positive'
  } else if (gexChangeD1 > 0.5 || gexChange5d > 0.5) {
    gexTrend = 'stable_positive'
  } else if (gexChangeD1 < -0.5 && gexChange5d < -1.0) {
    gexTrend = 'accelerating_negative'
  } else if (gexChangeD1 < -0.5 || gexChange5d < -0.5) {
    gexTrend = 'declining'
  } else {
    gexTrend = 'stable_positive'
  }

  const flipPointTrend = trendLabel(today.flipPoint, yesterday.flipPoint)
  const vtChangeD1     = today.volatilityTrigger != null && yesterday.volatilityTrigger != null
    ? parseFloat((today.volatilityTrigger - yesterday.volatilityTrigger).toFixed(2))
    : 0
  const vtTrend        = trendLabel(today.volatilityTrigger, yesterday.volatilityTrigger)

  // Build human-readable summary
  const trendDesc: Record<GEXHistoryContext['gexTrend'], string> = {
    accelerating_positive: 'acúmulo acelerado → pressão de vol decrescente',
    stable_positive:       'acúmulo moderado → vol contida',
    declining:             'desacúmulo → vol pode expandir',
    accelerating_negative: 'desacúmulo acelerado → cautela com expansão de vol',
  }
  const d5Note = history.length >= 5
    ? `, ${fmt(gexChange5d)}B vs 5d`
    : ` (histórico insuficiente para 5d — ${history.length}d disponíveis)`
  const historySummary =
    `GEX: ${fmt(gexChangeD1)}B vs ontem${d5Note} → ${trendDesc[gexTrend]}`

  return {
    gexTrend,
    gexChangeD1,
    gexChange5d,
    flipPointTrend,
    vtTrend,
    vtChangeD1,
    historySummary,
    daysAvailable: history.length,
  }
}

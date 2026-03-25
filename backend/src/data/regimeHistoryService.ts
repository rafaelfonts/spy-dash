/**
 * regimeHistoryService — computes, stores, and retrieves composite regime classifications.
 *
 * Persistence layers:
 *  1. Redis `regime:latest:SPY`        — most recent snapshot (5-min TTL, for fast access)
 *  2. Redis `regime:daily:SPY:YYYY-MM-DD` — daily summary (30-day TTL, for history)
 *  3. Supabase `regime_classifications` — full time-series for backtesting (fire-and-forget)
 *
 * Called from advancedMetricsPoller every 60s during market hours.
 *
 * Design notes:
 *  - All Supabase writes are fire-and-forget (non-blocking) to not delay the SSE tick.
 *  - Redis stores are awaited since they're sub-ms on Upstash.
 *  - Daily Redis key written only once per ET day (prevents re-inserts on restart).
 */

import { createClient } from '@supabase/supabase-js'
import { cacheGet, cacheSet } from '../lib/cacheStore'
import { computeCompositeRegime } from '../lib/compositeRegimeScorer'
import type { CompositeRegimeResult, CompositeRegimeInputs } from '../lib/compositeRegimeScorer'
import {
  extractFeatureVector,
  addToBuffer,
  classifyCurrentRegime,
  isTransitionDetected,
  getBufferSize,
} from '../lib/kmeansRegimeClassifier'
import type { KMeansRegimeResult } from '../lib/kmeansRegimeClassifier'
import { marketState } from './marketState'
import { getVIXTermStructureSnapshot } from './vixTermStructureState'
import type { GEXDynamic } from './gexService'
import type { PutCallRatioMulti } from '../types/market'

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

// ---------------------------------------------------------------------------
// Redis key constants
// ---------------------------------------------------------------------------

const LATEST_KEY       = 'regime:latest:SPY'
const LATEST_TTL_MS    = 5 * 60 * 1000      // 5 min (covers gaps between ticks)
const DAILY_KEY_PREFIX = 'regime:daily:SPY:'
const DAILY_TTL_MS     = 30 * 24 * 60 * 60 * 1000  // 30 days

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RegimeSnapshot extends CompositeRegimeResult {
  capturedAt: string     // ISO 8601
  etDate: string         // YYYY-MM-DD (ET timezone)
  ivHvSpread: number | null  // IVx% − HV30% in pp (not a component but stored for reference)
  gexSign: 'positive' | 'negative' | 'unknown'
  // Phase 3: K-means validation
  kmeans: KMeansRegimeResult | null
  transitionDetected: boolean
}

// ---------------------------------------------------------------------------
// ET date helper (mirrors pattern in regimeScorer.ts)
// ---------------------------------------------------------------------------

function getETDateString(): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2')
}

// ---------------------------------------------------------------------------
// Input assembly — reads from existing market state and computed snapshots
// ---------------------------------------------------------------------------

function assembleInputs(
  gexDynamic: GEXDynamic | null,
  putCallRatio: PutCallRatioMulti | null,
): { inputs: CompositeRegimeInputs; ivHvSpread: number | null; gexSign: 'positive' | 'negative' | 'unknown' } {
  const vix         = marketState.vix.last ?? null
  const ivRank      = marketState.ivRank.value ?? null
  const ivPercentile = marketState.ivRank.percentile ?? null
  const ivx         = marketState.ivRank.ivx ?? null
  const hv30        = marketState.ivRank.hv30 ?? null
  const termSnap    = getVIXTermStructureSnapshot()
  const vixTermSlope = termSnap?.steepness ?? null

  // Total net GEX across all expirations ($M)
  const totalNetGammaMillion = gexDynamic && gexDynamic.length > 0
    ? gexDynamic.reduce((sum, e) => sum + e.gex.totalNetGamma, 0)
    : null
  const gexSign: 'positive' | 'negative' | 'unknown' = totalNetGammaMillion != null
    ? (totalNetGammaMillion > 0 ? 'positive' : 'negative')
    : 'unknown'

  // Prefer 'Semanal' tier for PCR — most representative for multi-day strategies
  // Fall back to first available entry
  let pcrValue: number | null = null
  if (putCallRatio && putCallRatio.entries.length > 0) {
    const weekly = putCallRatio.entries.find((e) => e.tier === 'Semanal')
    const entry  = weekly ?? putCallRatio.entries[0]
    pcrValue = entry.ratio
  }

  // IV/HV spread in percentage points (stored for reference, not a component)
  const ivHvSpread = ivx != null && hv30 != null && hv30 > 0
    ? Math.round((ivx - hv30) * 10) / 10
    : null

  return {
    inputs: { vix, vixTermSlope, ivRank, ivPercentile, totalNetGammaMillion, putCallRatio: pcrValue },
    ivHvSpread,
    gexSign,
  }
}

// ---------------------------------------------------------------------------
// Core: compute + persist
// ---------------------------------------------------------------------------

/**
 * Computes composite regime score from current market state and persists it.
 * Called every poller tick (60s market hours, 5 min off-hours).
 *
 * @returns The computed RegimeSnapshot, or null if all critical inputs are missing.
 */
export async function computeAndSaveRegimeSnapshot(
  gexDynamic: GEXDynamic | null,
  putCallRatio: PutCallRatioMulti | null,
): Promise<RegimeSnapshot | null> {
  const { inputs, ivHvSpread, gexSign } = assembleInputs(gexDynamic, putCallRatio)

  // Require at least VIX to produce a meaningful snapshot
  if (inputs.vix == null) return null

  const result = computeCompositeRegime(inputs)
  const now    = new Date()
  const etDate = getETDateString()

  // Phase 3: K-means — feed current feature vector into rolling buffer, then classify
  const featureVec = extractFeatureVector(result.components)
  if (featureVec != null) addToBuffer(featureVec)
  const kmeansResult = classifyCurrentRegime()
  const transitionDetected = kmeansResult != null
    ? isTransitionDetected(kmeansResult.label, result.compositeScore)
    : false

  if (transitionDetected) {
    console.log(
      `[RegimeHistory] ⚠️ TRANSITION DETECTED: kmeans=${kmeansResult?.label} ` +
      `vs rule-based=${result.regimeLabel} (score=${result.compositeScore})`,
    )
  }

  const snapshot: RegimeSnapshot = {
    ...result,
    capturedAt: now.toISOString(),
    etDate,
    ivHvSpread,
    gexSign,
    kmeans: kmeansResult,
    transitionDetected,
  }

  // 1. Redis: latest snapshot (always overwrite, short TTL)
  await cacheSet(LATEST_KEY, snapshot, LATEST_TTL_MS, 'regime-history').catch((e) =>
    console.warn('[RegimeHistory] Redis latest write failed:', (e as Error).message),
  )

  // 2. Redis: daily summary (once per ET day — first write wins)
  const dailyKey = `${DAILY_KEY_PREFIX}${etDate}`
  const existingDaily = await cacheGet<RegimeSnapshot>(dailyKey).catch(() => null)
  if (!existingDaily) {
    await cacheSet(dailyKey, snapshot, DAILY_TTL_MS, 'regime-history-daily').catch(() => {})
  }

  // 3. Supabase: full time-series — fire and forget
  persistToSupabase(snapshot, inputs)

  return snapshot
}

// ---------------------------------------------------------------------------
// Redis getters
// ---------------------------------------------------------------------------

export async function getLatestRegimeSnapshot(): Promise<RegimeSnapshot | null> {
  return cacheGet<RegimeSnapshot>(LATEST_KEY).catch(() => null)
}

export async function getRegimeDailySnapshot(etDate: string): Promise<RegimeSnapshot | null> {
  return cacheGet<RegimeSnapshot>(`${DAILY_KEY_PREFIX}${etDate}`).catch(() => null)
}

// ---------------------------------------------------------------------------
// Supabase persistence (non-blocking)
// ---------------------------------------------------------------------------

function persistToSupabase(
  snapshot: RegimeSnapshot,
  inputs: CompositeRegimeInputs,
): void {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return

  // Round captured_at to the nearest minute to use as natural dedup key
  const capturedAtMinute = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString()

  // Normalized feature vector for optional pgvector similarity search
  // Dimensions: [vix_norm, term_slope_norm, iv_rank_norm, iv_pct_norm, gex_norm, pcr_norm]
  const features: number[] | null =
    snapshot.componentsAvailable >= 4
      ? [
          (snapshot.components.vix          ?? 50) / 100,
          (snapshot.components.termSlope     ?? 50) / 100,
          (snapshot.components.ivRank        ?? 50) / 100,
          (snapshot.components.ivPercentile  ?? 50) / 100,
          (snapshot.components.gex           ?? 50) / 100,
          (snapshot.components.putCallRatio  ?? 50) / 100,
        ]
      : null

  supabase
    .from('regime_classifications')
    .insert({
      captured_at:    capturedAtMinute,
      regime_label:   snapshot.regimeLabel,
      composite_score: snapshot.compositeScore,
      method:         'rule-based',
      confidence:     snapshot.confidence,
      // Raw inputs
      vix:            inputs.vix,
      iv_rank:        inputs.ivRank,
      iv_percentile:  inputs.ivPercentile,
      iv_hv_spread:   snapshot.ivHvSpread,
      vix_term_slope: inputs.vixTermSlope,
      gex_sign:       snapshot.gexSign,
      put_call_ratio: inputs.putCallRatio,
      // Component scores (0–100)
      comp_vix:          snapshot.components.vix,
      comp_term_slope:   snapshot.components.termSlope,
      comp_iv_rank:      snapshot.components.ivRank,
      comp_iv_percentile: snapshot.components.ivPercentile,
      comp_gex:          snapshot.components.gex,
      comp_pcr:          snapshot.components.putCallRatio,
      // pgvector feature array for similarity search
      features: features ? JSON.stringify(features) : null,
      // Phase 3: K-means validation fields
      kmeans_label:       snapshot.kmeans?.label ?? null,
      transition_detected: snapshot.transitionDetected,
      kmeans_buffer_size: snapshot.kmeans?.bufferSize ?? getBufferSize(),
      kmeans_converged:   snapshot.kmeans?.converged ?? null,
    })
    .then(
      ({ error }: { error: { message: string } | null }) => {
        if (error && !error.message.includes('duplicate')) {
          console.warn('[RegimeHistory] Supabase insert failed:', error.message)
        }
      },
      () => {} // rejection handler — PromiseLike-safe, completely non-blocking
    )
}

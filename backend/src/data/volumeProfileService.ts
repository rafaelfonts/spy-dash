/**
 * VolumeProfileService — intraday Volume Profile and POC from Tradier Time & Sales.
 *
 * Design decisions:
 *  - 1-min OHLCV bars from Tradier are accumulated in-process across polls.
 *    The bar's `volume` field represents SPY share volume for that minute.
 *    We distribute each bar's volume across its [low, high] range uniformly
 *    into $0.10 buckets — this approximates the Footprint/Volume Profile
 *    without requiring tick-level data.
 *  - A rolling in-memory state avoids re-fetching the full day on every poll.
 *    Only bars with timestamps newer than the last seen bar are processed.
 *  - Value Area uses the standard CME algorithm: expand from POC outward,
 *    adding the higher-volume side first, until 70% of total volume is covered.
 */

import { getTradierClient } from '../lib/tradierClient'
import { CONFIG } from '../config'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VolumeBucket {
  price: number   // lower edge of the bucket (e.g. 530.10 means [530.10, 530.20))
  volume: number  // total volume attributed to this price level
}

export interface VolumeProfileResult {
  poc: number                  // price level with the highest volume
  valueAreaHigh: number        // upper edge of the 70% Value Area
  valueAreaLow: number         // lower edge of the 70% Value Area
  totalVolume: number          // sum of all volume processed
  profileData: VolumeBucket[]  // sorted ascending by price
  barsProcessed: number        // number of 1-min bars included
  sessionStart: string         // ISO 8601 of the earliest bar
  calculatedAt: string         // ISO 8601
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BUCKET_SIZE = 0.10      // $0.10 price buckets
const VALUE_AREA_PCT = 0.70   // 70% of total volume

// ---------------------------------------------------------------------------
// In-memory accumulation state (reset at session boundary)
// ---------------------------------------------------------------------------

interface AccumulationState {
  /** Key: bucket price (lower edge, rounded). Value: total volume. */
  buckets: Map<number, number>
  /** ISO date string of the trading session (YYYY-MM-DD). Reset daily. */
  sessionDate: string
  /** ISO 8601 timestamp of the last bar we processed. Used to skip re-processing. */
  lastBarTime: string
  /** Total bars accumulated so far. */
  barCount: number
  /** ISO 8601 of the first bar in the session. */
  sessionStart: string
}

let state: AccumulationState | null = null

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function getOrInitState(): AccumulationState {
  const today = getTodayDate()
  if (!state || state.sessionDate !== today) {
    // New trading session — reset accumulation
    state = {
      buckets: new Map(),
      sessionDate: today,
      lastBarTime: '',
      barCount: 0,
      sessionStart: '',
    }
  }
  return state
}

// ---------------------------------------------------------------------------
// Core: distribute a bar's volume across its price range into buckets
// ---------------------------------------------------------------------------

/**
 * For a 1-min bar with a known [low, high] range and total volume,
 * distribute the volume uniformly across all $0.10 buckets it spans.
 *
 * Example: low=530.03, high=530.27, volume=50_000 spans buckets
 *   530.00, 530.10, 530.20 → ~16_666 volume each.
 */
function distributeToBuckets(
  buckets: Map<number, number>,
  low: number,
  high: number,
  volume: number,
): void {
  if (volume <= 0 || low > high) return

  // Snap low down and high up to bucket boundaries
  const bucketLow = Math.floor(low / BUCKET_SIZE) * BUCKET_SIZE
  const bucketHigh = Math.floor(high / BUCKET_SIZE) * BUCKET_SIZE

  // Count how many buckets this bar spans
  const numBuckets = Math.round((bucketHigh - bucketLow) / BUCKET_SIZE) + 1
  const volumePerBucket = volume / numBuckets

  for (let i = 0; i < numBuckets; i++) {
    // Round to avoid floating-point drift accumulating over thousands of bars
    const bucketPrice = Math.round((bucketLow + i * BUCKET_SIZE) * 100) / 100
    buckets.set(bucketPrice, (buckets.get(bucketPrice) ?? 0) + volumePerBucket)
  }
}

// ---------------------------------------------------------------------------
// Core: compute POC and Value Area from the accumulated bucket map
// ---------------------------------------------------------------------------

function computeProfile(
  buckets: Map<number, number>,
  barCount: number,
  sessionStart: string,
): VolumeProfileResult {
  if (buckets.size === 0) {
    const now = new Date().toISOString()
    return {
      poc: 0, valueAreaHigh: 0, valueAreaLow: 0, totalVolume: 0,
      profileData: [], barsProcessed: 0, sessionStart: now, calculatedAt: now,
    }
  }

  // Build sorted array once — O(N log N)
  const sorted: VolumeBucket[] = Array.from(buckets.entries())
    .map(([price, volume]) => ({ price, volume: Math.round(volume) }))
    .sort((a, b) => a.price - b.price)

  const totalVolume = sorted.reduce((sum, b) => sum + b.volume, 0)

  // POC: bucket with highest volume
  const pocBucket = sorted.reduce((max, b) => (b.volume > max.volume ? b : max))
  const poc = pocBucket.price

  // Value Area (CME algorithm):
  //   Start at POC. Maintain two pointers expanding outward.
  //   Each step, add the side (up or down) with the higher volume.
  //   Stop when accumulated VA volume ≥ 70% of total.
  const pocIdx = sorted.findIndex((b) => b.price === poc)
  let lo = pocIdx
  let hi = pocIdx
  let vaVolume = pocBucket.volume

  const target = totalVolume * VALUE_AREA_PCT

  while (vaVolume < target && (lo > 0 || hi < sorted.length - 1)) {
    const nextLoVol = lo > 0 ? sorted[lo - 1].volume : -1
    const nextHiVol = hi < sorted.length - 1 ? sorted[hi + 1].volume : -1

    if (nextLoVol >= nextHiVol) {
      lo--
      vaVolume += sorted[lo].volume
    } else {
      hi++
      vaVolume += sorted[hi].volume
    }
  }

  return {
    poc,
    valueAreaHigh: sorted[hi].price + BUCKET_SIZE, // upper edge of highest bucket
    valueAreaLow: sorted[lo].price,                 // lower edge of lowest bucket
    totalVolume: Math.round(totalVolume),
    profileData: sorted,
    barsProcessed: barCount,
    sessionStart,
    calculatedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Fetch new 1-min bars from Tradier (incremental), accumulate into the
 * in-memory bucket map, and return the current Volume Profile snapshot.
 *
 * Safe to call on a tight poll interval — only new bars (after lastBarTime)
 * are processed. The full day's buckets are always reflected in the result.
 */
export async function buildVolumeProfile(
  symbol: string,
): Promise<VolumeProfileResult | null> {
  if (!CONFIG.TRADIER_API_KEY) {
    console.warn('[VolumeProfile] TRADIER_API_KEY not set — skipping')
    return null
  }

  const s = getOrInitState()
  const client = getTradierClient()

  // Fetch today's 1-min bars (TradierClient caches for 30s internally)
  const bars = await client.getTimeSales(symbol, '1min')
  if (bars.length === 0) {
    console.warn(`[VolumeProfile] No bars returned for ${symbol}`)
    return s.barCount > 0 ? computeProfile(s.buckets, s.barCount, s.sessionStart) : null
  }

  // Filter to market-hours bars (09:30–16:00 ET) and only process new ones
  // Tradier returns time in "YYYY-MM-DDTHH:MM:SS" local-ish format with session_filter=open,
  // so all returned bars should already be within market hours — we still skip
  // anything we've already accumulated to avoid double-counting.
  let newBars = 0
  for (const bar of bars) {
    if (bar.time <= s.lastBarTime) continue  // already processed
    if (bar.volume <= 0) continue            // no trade activity in this bar

    distributeToBuckets(s.buckets, bar.low, bar.high, bar.volume)
    s.barCount++
    newBars++

    if (!s.sessionStart) s.sessionStart = bar.time
    if (bar.time > s.lastBarTime) s.lastBarTime = bar.time
  }

  if (newBars > 0) {
    console.log(
      `[VolumeProfile] ${symbol}: +${newBars} new bars ` +
      `(total=${s.barCount}, buckets=${s.buckets.size}, last=${s.lastBarTime})`,
    )
  }

  return computeProfile(s.buckets, s.barCount, s.sessionStart)
}

/**
 * Returns the last computed profile without making any network call.
 * Returns null if no data has been accumulated yet in this session.
 */
export function getLastVolumeProfile(symbol: string): VolumeProfileResult | null {
  const today = getTodayDate()
  if (!state || state.sessionDate !== today || state.barCount === 0) return null
  return computeProfile(state.buckets, state.barCount, state.sessionStart)
}

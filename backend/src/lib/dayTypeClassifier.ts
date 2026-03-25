/**
 * dayTypeClassifier — classifies the current intraday day type for SPY.
 *
 * Based on the Steidlmayer/Dalton market profile typology simplified to three
 * actionable categories for premium selling:
 *
 *  - range_bound: price is consolidating, dealers are suppressing vol (GEX+)
 *                 → ideal for iron condors and short straddles
 *  - trending:    directional move underway, dealers amplifying (GEX−)
 *                 → avoid new short premium positions
 *  - neutral:     neither clearly range nor trend
 *
 * Inputs (all from existing market state — zero new API calls):
 *  - SPY day range% = (dayHigh − dayLow) / prevClose × 100
 *  - SPY open distance% = (last − open) / open × 100
 *  - GEX regime: positive (mean-reverting) vs negative (amplifying)
 *  - VIX change% from previous close
 *
 * Confidence is set based on how many conditions cleanly agree.
 *
 * For 45DTE strategies, day_type is context only (intraday noise dilutes over time).
 * For 0DTE/1DTE, day_type is a primary signal — avoid selling into trending days.
 */

export type DayTypeLabel = 'range_bound' | 'trending' | 'neutral' | 'unknown'

export interface DayTypeResult {
  label: DayTypeLabel
  confidence: number  // 0–1
  rangePercent: number | null  // (dayHigh − dayLow) / prevClose × 100
  openDistancePct: number | null  // |last − open| / open × 100
}

export interface DayTypeInputs {
  spyLast: number | null
  spyOpen: number | null
  spyPrevClose: number | null
  dayHigh: number | null
  dayLow: number | null
  gexPositive: boolean | null   // null = unknown
  vixChangePct: number | null
}

// ---------------------------------------------------------------------------
// Thresholds (document-aligned, adjusted for % not ATR-ratio)
// ---------------------------------------------------------------------------

const RANGE_TIGHT_PCT    = 0.50   // < 0.5% daily range → tight / range day
const RANGE_TREND_PCT    = 1.20   // > 1.2% daily range → potential trend day
const OPEN_DIST_FLAT_PCT = 0.30   // |open dist| < 0.30% → anchored near open (range)
const OPEN_DIST_TREND_PCT = 0.80  // |open dist| > 0.80% → moved away from open (trending)
const VIX_SPIKE_PCT      = 5.0   // VIX up > 5% intraday → elevated stress

export function classifyDayType(inputs: DayTypeInputs): DayTypeResult {
  const { spyLast, spyOpen, spyPrevClose, dayHigh, dayLow, gexPositive, vixChangePct } = inputs

  // Need at least high/low/prevClose to compute range
  if (dayHigh == null || dayLow == null || spyPrevClose == null || spyPrevClose <= 0) {
    return { label: 'unknown', confidence: 0, rangePercent: null, openDistancePct: null }
  }

  const rangePercent = ((dayHigh - dayLow) / spyPrevClose) * 100
  const openDistancePct =
    spyLast != null && spyOpen != null && spyOpen > 0
      ? Math.abs((spyLast - spyOpen) / spyOpen) * 100
      : null

  const vixSpiking = vixChangePct != null && vixChangePct > VIX_SPIKE_PCT

  // --- Scoring: count how many signals align for each type ---
  let rangeScore = 0
  let trendScore = 0

  // Range signals
  if (rangePercent < RANGE_TIGHT_PCT) rangeScore += 2
  if (openDistancePct != null && openDistancePct < OPEN_DIST_FLAT_PCT) rangeScore += 1
  if (gexPositive === true) rangeScore += 2
  if (!vixSpiking) rangeScore += 1

  // Trend signals
  if (rangePercent > RANGE_TREND_PCT) trendScore += 2
  if (openDistancePct != null && openDistancePct > OPEN_DIST_TREND_PCT) trendScore += 1
  if (gexPositive === false) trendScore += 2
  if (vixSpiking) trendScore += 1

  // Determine label and confidence
  let label: DayTypeLabel
  let confidence: number

  if (rangeScore >= 4 && rangeScore > trendScore + 1) {
    // Clearly range-bound
    label = 'range_bound'
    confidence = Math.min(0.50 + (rangeScore - trendScore) * 0.10, 0.92)
  } else if (trendScore >= 4 && trendScore > rangeScore + 1) {
    // Clearly trending
    label = 'trending'
    confidence = Math.min(0.50 + (trendScore - rangeScore) * 0.10, 0.92)
  } else {
    // Mixed signals
    label = 'neutral'
    confidence = 0.55 - Math.abs(rangeScore - trendScore) * 0.03
  }

  return {
    label,
    confidence: Math.round(confidence * 100) / 100,
    rangePercent: Math.round(rangePercent * 100) / 100,
    openDistancePct: openDistancePct != null ? Math.round(openDistancePct * 100) / 100 : null,
  }
}

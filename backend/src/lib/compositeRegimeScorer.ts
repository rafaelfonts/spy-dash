/**
 * compositeRegimeScorer — deterministic 0–100 weighted composite regime score
 * for SPY options premium selling.
 *
 * Based on the methodology described in the regime detection research document.
 * Each component maps its input to a 0–100 sub-score (higher = more volatile/risky).
 * The composite is a weighted average of the six components.
 *
 * Weight allocation (total = 1.0):
 *   VIX level         0.30  — primary volatility barometer
 *   VIX term slope    0.20  — contango/backwardation regime
 *   IV Rank           0.15  — option sellers' edge vs 52-week history
 *   IV Percentile     0.15  — probability-based edge quantile
 *   GEX sign          0.10  — microstructural vol amplification / suppression
 *   Put/Call Ratio    0.10  — directional flow / hedging demand
 *
 * Regime labels from composite score (same thresholds as ECB SWARCH 3-state model):
 *   LOW_VOL   < 25
 *   NORMAL    25–50
 *   ELEVATED  50–75
 *   HIGH_VOL  > 75
 *
 * This is a pure function — no side-effects, no external state access.
 * The caller (regimeHistoryService) is responsible for reading from marketState.
 */

export type CompositeRegimeLabel = 'LOW_VOL' | 'NORMAL' | 'ELEVATED' | 'HIGH_VOL'

export interface CompositeRegimeComponents {
  /** VIX level component (0–100). Linear: 12→0, 40→100. */
  vix: number | null
  /** Term structure slope component (0–100). Contango +8%→0, backwardation −8%→100. */
  termSlope: number | null
  /** IV Rank component (0–100). Direct pass-through. */
  ivRank: number | null
  /** IV Percentile component (0–100). Direct pass-through. */
  ivPercentile: number | null
  /** GEX component (0–100). Tanh-normalized: +3000M→~12, 0→50, −3000M→~88. */
  gex: number | null
  /** Put/Call Ratio component (0–100). Linear: 0.5→0, 1.5→100. */
  putCallRatio: number | null
}

export interface CompositeRegimeResult {
  /** Weighted composite score 0–100 (higher = more volatile / riskier). */
  compositeScore: number
  /** Categorical regime label derived from compositeScore. */
  regimeLabel: CompositeRegimeLabel
  /** Per-component sub-scores (0–100) before weighting. null = data unavailable. */
  components: CompositeRegimeComponents
  /** Data confidence 0–1 based on how many of the 6 components have data. */
  confidence: number
  /** Number of components used (max 6). */
  componentsAvailable: number
}

// ---------------------------------------------------------------------------
// Weights (must sum to 1.0)
// ---------------------------------------------------------------------------

const W_VIX        = 0.30
const W_TERM_SLOPE = 0.20
const W_IV_RANK    = 0.15
const W_IV_PCT     = 0.15
const W_GEX        = 0.10
const W_PCR        = 0.10

// ---------------------------------------------------------------------------
// Component reference bounds
// ---------------------------------------------------------------------------

const VIX_MIN   = 12   // historical bottom ~10th percentile (complacency)
const VIX_MAX   = 40   // top ~5% of readings (crisis)

const SLOPE_MAX_CONTANGO  = 8.0   // +8% = strong contango → 0 (low vol)
const SLOPE_MAX_BACKWD    = 8.0   // −8% = deep backwardation → 100 (high vol)

const PCR_LOW  = 0.5   // calls dominate → bullish → 0 (low-risk for premium selling)
const PCR_HIGH = 1.5   // puts dominate → bearish/hedging → 100 (high-risk)

const GEX_SCALE = 3000  // $M reference scale for tanh normalization

// ---------------------------------------------------------------------------
// Component helpers
// ---------------------------------------------------------------------------

function clamp(x: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, x))
}

/**
 * VIX component: linear interpolation.
 * 12 → 0, 40 → 100, extrapolated outside range (then clamped).
 */
export function vixComponent(vix: number): number {
  return clamp((vix - VIX_MIN) / (VIX_MAX - VIX_MIN) * 100)
}

/**
 * Term structure slope component.
 * Strong contango (+8% or more) → 0 (favorable: theta efficient, vol suppressed).
 * Deep backwardation (−8% or less) → 100 (unfavorable: spot stress).
 * Flat (0%) → 50.
 */
export function termSlopeComponent(steepnessPct: number): number {
  // Invert slope: positive slope (contango) → lower component
  return clamp((-steepnessPct + SLOPE_MAX_BACKWD) / (SLOPE_MAX_CONTANGO + SLOPE_MAX_BACKWD) * 100)
}

/**
 * IV Rank component: direct pass-through (already 0–100).
 * Higher rank = more expensive relative to 52-week history = more seller edge.
 * Note: higher IV Rank = BETTER for sellers, but here we're building a "volatility/risk" score.
 * We treat high IV as "elevated regime" since it usually comes with higher market risk.
 */
export function ivRankComponent(ivRank: number): number {
  return clamp(ivRank)
}

/**
 * IV Percentile component: direct pass-through (already 0–100).
 */
export function ivPercentileComponent(ivPercentile: number): number {
  return clamp(ivPercentile)
}

/**
 * GEX component: tanh normalization around ±GEX_SCALE.
 * Strongly positive GEX (dealers long gamma, suppressing vol) → low component (near 0).
 * Negative GEX (dealers short gamma, amplifying vol) → high component (near 100).
 *
 * tanh(1) ≈ 0.762, so:
 *  +3000M → 50 * (1 − tanh(1)) ≈ 12   (suppressed)
 *  0      → 50                          (neutral)
 *  −3000M → 50 * (1 − tanh(−1)) ≈ 88  (amplified)
 */
export function gexComponent(totalNetGammaMillion: number): number {
  const t = Math.tanh(totalNetGammaMillion / GEX_SCALE)
  return clamp(50 * (1 - t))
}

/**
 * Put/Call Ratio component: linear interpolation.
 * 0.5 (calls dominate, bullish flow) → 0.
 * 1.0 (neutral) → 50.
 * 1.5 (puts dominate, hedging demand) → 100.
 */
export function pcrComponent(putCallRatio: number): number {
  return clamp((putCallRatio - PCR_LOW) / (PCR_HIGH - PCR_LOW) * 100)
}

// ---------------------------------------------------------------------------
// Regime label mapping
// ---------------------------------------------------------------------------

export function regimeLabelFromScore(score: number): CompositeRegimeLabel {
  if (score < 25) return 'LOW_VOL'
  if (score < 50) return 'NORMAL'
  if (score < 75) return 'ELEVATED'
  return 'HIGH_VOL'
}

// ---------------------------------------------------------------------------
// Main composite scorer — pure function
// ---------------------------------------------------------------------------

export interface CompositeRegimeInputs {
  /** VIX last price (e.g. 21.8). null if unavailable. */
  vix: number | null
  /** VIX term structure steepness % (positive = contango, negative = backwardation). */
  vixTermSlope: number | null
  /** IV Rank 0–100 from Tastytrade. */
  ivRank: number | null
  /** IV Percentile 0–100 from Tastytrade. */
  ivPercentile: number | null
  /** Total net GEX across all expirations in $M (positive = dealers long gamma). */
  totalNetGammaMillion: number | null
  /** Aggregate Put/Call Ratio (volume-based). Prefer Semanal tier if available. */
  putCallRatio: number | null
}

export function computeCompositeRegime(inputs: CompositeRegimeInputs): CompositeRegimeResult {
  const {
    vix,
    vixTermSlope,
    ivRank,
    ivPercentile,
    totalNetGammaMillion,
    putCallRatio,
  } = inputs

  // Compute per-component scores
  const compVix       = vix                  != null ? vixComponent(vix)                          : null
  const compTermSlope = vixTermSlope         != null ? termSlopeComponent(vixTermSlope)            : null
  const compIvRank    = ivRank               != null ? ivRankComponent(ivRank)                     : null
  const compIvPct     = ivPercentile         != null ? ivPercentileComponent(ivPercentile)         : null
  const compGex       = totalNetGammaMillion != null ? gexComponent(totalNetGammaMillion)          : null
  const compPcr       = putCallRatio         != null ? pcrComponent(putCallRatio)                  : null

  // Weighted sum — redistribute weights if components are missing
  let weightedSum = 0
  let weightTotal = 0

  if (compVix       != null) { weightedSum += compVix       * W_VIX;        weightTotal += W_VIX }
  if (compTermSlope != null) { weightedSum += compTermSlope * W_TERM_SLOPE;  weightTotal += W_TERM_SLOPE }
  if (compIvRank    != null) { weightedSum += compIvRank    * W_IV_RANK;     weightTotal += W_IV_RANK }
  if (compIvPct     != null) { weightedSum += compIvPct     * W_IV_PCT;      weightTotal += W_IV_PCT }
  if (compGex       != null) { weightedSum += compGex       * W_GEX;         weightTotal += W_GEX }
  if (compPcr       != null) { weightedSum += compPcr       * W_PCR;         weightTotal += W_PCR }

  // Normalize by available weight (graceful degradation)
  const compositeScore = weightTotal > 0
    ? Math.round((weightedSum / weightTotal) * 10) / 10  // 1 decimal
    : 50  // default to NORMAL when no data

  const componentsAvailable = [compVix, compTermSlope, compIvRank, compIvPct, compGex, compPcr]
    .filter((v) => v != null).length

  // Confidence scales with data completeness
  const confidence = componentsAvailable >= 6 ? 0.85
    : componentsAvailable === 5           ? 0.75
    : componentsAvailable === 4           ? 0.65
    : componentsAvailable === 3           ? 0.55
    : componentsAvailable === 2           ? 0.40
    : componentsAvailable === 1           ? 0.30
    : 0.20

  return {
    compositeScore,
    regimeLabel:          regimeLabelFromScore(compositeScore),
    confidence,
    componentsAvailable,
    components: {
      vix:          compVix       != null ? Math.round(compVix * 10) / 10       : null,
      termSlope:    compTermSlope != null ? Math.round(compTermSlope * 10) / 10 : null,
      ivRank:       compIvRank    != null ? Math.round(compIvRank * 10) / 10    : null,
      ivPercentile: compIvPct     != null ? Math.round(compIvPct * 10) / 10     : null,
      gex:          compGex       != null ? Math.round(compGex * 10) / 10       : null,
      putCallRatio: compPcr       != null ? Math.round(compPcr * 10) / 10       : null,
    },
  }
}

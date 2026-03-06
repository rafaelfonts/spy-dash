/**
 * regimeScorer — server-side computation of regime_score (0–10), vanna_regime,
 * charm_pressure, price_distribution, and gex_vs_yesterday.
 *
 * Values are injected into the AI prompt as pre-computed facts so that
 * gpt-4o-mini copies them literally instead of inferring from prose.
 */

import { marketState, newsSnapshot } from './marketState'
import { getVIXTermStructureSnapshot } from './vixTermStructureState'
import { getExpectedMoveSnapshot } from './expectedMoveState'
import type { GEXByExpiration } from './gexService'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PriceDistribution {
  p10: number
  p25: number
  p50: number
  p75: number
  p90: number
  expected_range_1sigma: string
}

export interface RegimeScorerResult {
  score: number               // 0–10, integer, clamped
  vannaRegime: 'tailwind' | 'neutral' | 'headwind'
  charmPressure: 'significant' | 'moderate' | 'neutral'
  priceDistribution: PriceDistribution | null
}

export type GexComparison =
  | 'stronger_positive'
  | 'weaker_positive'
  | 'unchanged'
  | 'weaker_negative'
  | 'stronger_negative'

// ---------------------------------------------------------------------------
// GEX history for gex_vs_yesterday (in-memory, resets on server restart)
// ---------------------------------------------------------------------------

let gexDailyHistory: Array<{ date: string; total: number }> = []

function getETDateString(): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2')
}

export function updateGexHistory(total: number): void {
  const etDate = getETDateString()
  if (!gexDailyHistory.length || gexDailyHistory.at(-1)!.date !== etDate) {
    gexDailyHistory.push({ date: etDate, total })
    if (gexDailyHistory.length > 2) gexDailyHistory.shift()
  } else {
    gexDailyHistory.at(-1)!.total = total
  }
}

export function getGexVsYesterday(current: number): GexComparison | null {
  if (gexDailyHistory.length < 2) return null
  const prev = gexDailyHistory[0].total
  const change = current - prev
  const threshold = Math.max(Math.abs(prev) * 0.05, 0.5)
  if (Math.abs(change) < threshold) return 'unchanged'
  if (current >= 0 && prev >= 0) return change > 0 ? 'stronger_positive' : 'weaker_positive'
  if (current < 0 && prev < 0) return change > 0 ? 'weaker_negative' : 'stronger_negative'
  return change > 0 ? 'stronger_positive' : 'stronger_negative'
}

// ---------------------------------------------------------------------------
// Price distribution from Expected Move (21D-closest entry)
// ---------------------------------------------------------------------------

function computePriceDistribution(spot: number): PriceDistribution | null {
  const emSnapshot = getExpectedMoveSnapshot()
  if (!emSnapshot || Object.keys(emSnapshot.byExpiry).length === 0) return null

  // Find entry with DTE closest to 21
  let bestEntry: { dte: number; expectedMove: number } | null = null
  for (const entry of Object.values(emSnapshot.byExpiry)) {
    if (!bestEntry || Math.abs(entry.dte - 21) < Math.abs(bestEntry.dte - 21)) {
      bestEntry = entry
    }
  }
  if (!bestEntry || bestEntry.expectedMove <= 0) return null

  const em = bestEntry.expectedMove
  const sigma = em / 1.645  // treat EM as ±1.645σ (90% CI of straddle)

  const p10 = spot - 1.645 * sigma  // ≈ spot - em
  const p25 = spot - 0.674 * sigma
  const p50 = spot
  const p75 = spot + 0.674 * sigma
  const p90 = spot + 1.645 * sigma  // ≈ spot + em

  return {
    p10: parseFloat(p10.toFixed(2)),
    p25: parseFloat(p25.toFixed(2)),
    p50: parseFloat(p50.toFixed(2)),
    p75: parseFloat(p75.toFixed(2)),
    p90: parseFloat(p90.toFixed(2)),
    expected_range_1sigma: `$${(spot - sigma).toFixed(2)}–$${(spot + sigma).toFixed(2)}`,
  }
}

// ---------------------------------------------------------------------------
// Main regime scorer
// ---------------------------------------------------------------------------

export function computeRegimeScore(gexByExpiration: GEXByExpiration | null): RegimeScorerResult {
  const ivRank = marketState.ivRank.value ?? null
  const hv30 = marketState.ivRank.hv30 ?? null
  const ivHvRatio = ivRank != null && hv30 != null && hv30 > 0 ? ivRank / hv30 : null
  const vixLast = marketState.vix.last ?? null
  const spyLast = marketState.spy.last ?? null

  const gexAll = gexByExpiration?.all ?? null
  const totalNetGamma = gexAll?.totalNetGamma ?? null
  const vex = gexAll?.totalVannaExposure ?? null
  const cex = gexAll?.totalCharmExposure ?? null
  const vt = gexAll?.volatilityTrigger ?? null
  const zgl = gexAll?.zeroGammaLevel ?? null

  const termStructure = getVIXTermStructureSnapshot()

  const earningsCritical = (newsSnapshot.earnings ?? []).some(
    (e) => e.daysToEarnings != null && e.daysToEarnings >= 0 && e.daysToEarnings <= 2,
  )

  // --- Scoring (raw may go negative before clamp) ---
  let raw = 0

  if (ivRank != null) {
    if (ivRank >= 30) raw += 2
    else if (ivRank >= 20) raw += 1
  }

  if (ivHvRatio != null) {
    if (ivHvRatio >= 1.0) raw += 2
    else if (ivHvRatio >= 0.9) raw += 1
  }

  if (totalNetGamma != null && totalNetGamma > 0) raw += 2

  if (spyLast != null && vt != null && spyLast > vt) raw += 1

  if (vex != null && vex > 0 && vixLast != null && vixLast < 20) raw += 1

  if (termStructure?.structure === 'contango') raw += 1

  // Penalties
  if (vixLast != null && vixLast > 25) raw -= 2
  if (earningsCritical) raw -= 2
  if (spyLast != null && zgl != null && spyLast < zgl) raw -= 1

  const score = Math.max(0, Math.min(10, raw))

  // --- vanna_regime ---
  let vannaRegime: 'tailwind' | 'neutral' | 'headwind'
  if (vex != null && vex > 2 && vixLast != null && vixLast < 20) {
    vannaRegime = 'tailwind'
  } else if (vex != null && vex < -2) {
    vannaRegime = 'headwind'
  } else if (vixLast != null && vixLast > 20) {
    vannaRegime = 'headwind'
  } else {
    vannaRegime = 'neutral'
  }

  // --- charm_pressure ---
  let charmPressure: 'significant' | 'moderate' | 'neutral'
  const absCex = cex != null ? Math.abs(cex) : null
  if (absCex != null && absCex > 2) {
    charmPressure = 'significant'
  } else if (absCex != null && absCex > 0.5) {
    charmPressure = 'moderate'
  } else {
    charmPressure = 'neutral'
  }

  // --- price_distribution ---
  const priceDistribution = spyLast != null ? computePriceDistribution(spyLast) : null

  return { score, vannaRegime, charmPressure, priceDistribution }
}

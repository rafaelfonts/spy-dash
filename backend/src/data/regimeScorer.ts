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
import { getOpexStatus } from './opexCalendar'
import { getSkewSnapshot } from './skewState'
import type { GEXDynamic } from './gexService'
import { GEX_THRESHOLDS } from '../lib/gexThresholds'

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
  /** Number of times GEX regime flipped sign today (positive↔negative). ≥2 = structural indecision. */
  regimeFlipCount: number
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
// Intraday regime flip tracking
// Tracks sign changes in GEX regime (positive→negative or negative→positive)
// within a single trading day. Resets when ET date changes.
// ---------------------------------------------------------------------------

interface RegimeSnapshot {
  time: number              // epoch ms
  regime: 'positive' | 'negative'
  date: string              // ET date YYYY-MM-DD
}

let intradayRegimeHistory: RegimeSnapshot[] = []

/** Called every tick from advancedMetricsPoller to update regime flip tracking. */
export function updateRegimeHistory(regime: 'positive' | 'negative'): void {
  const etDate = getETDateString()
  // Reset history if day changed
  if (intradayRegimeHistory.length > 0 && intradayRegimeHistory[0].date !== etDate) {
    intradayRegimeHistory = []
  }
  // Only record if regime changed from last snapshot
  const last = intradayRegimeHistory.at(-1)
  if (!last || last.regime !== regime) {
    intradayRegimeHistory.push({ time: Date.now(), regime, date: etDate })
    // Keep max 100 snapshots to bound memory
    if (intradayRegimeHistory.length > 100) intradayRegimeHistory.shift()
  }
}

/**
 * Returns the number of regime sign changes today (positive↔negative).
 * The first entry is not a flip — flips start at the 2nd snapshot.
 */
export function getRegimeFlipCount(): number {
  if (intradayRegimeHistory.length < 2) return 0
  return intradayRegimeHistory.length - 1
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

export function computeRegimeScore(gexDynamic: GEXDynamic | null): RegimeScorerResult {
  const ivRank = marketState.ivRank.value ?? null
  const hv30 = marketState.ivRank.hv30 ?? null
  const ivHvRatio = ivRank != null && hv30 != null && hv30 > 0 ? ivRank / hv30 : null
  const vixLast = marketState.vix.last ?? null
  const spyLast = marketState.spy.last ?? null

  // Aggregate across all dynamic entries; use lowest-DTE entry for intraday anchors (VT, ZGL)
  const entries = gexDynamic ?? []
  const lowestDTE = entries.length > 0 ? entries[0].gex : null
  const totalNetGamma = entries.length > 0
    ? entries.reduce((sum, e) => sum + e.gex.totalNetGamma, 0)
    : null
  const vex = entries.length > 0
    ? entries.reduce((sum, e) => sum + (e.gex.totalVannaExposure ?? 0), 0)
    : null
  const cex = entries.length > 0
    ? entries.reduce((sum, e) => sum + (e.gex.totalCharmExposure ?? 0), 0)
    : null
  // VT and ZGL from lowest-DTE entry (most impactful for intraday regime)
  const vt = lowestDTE?.volatilityTrigger ?? null
  const zgl = lowestDTE?.zeroGammaLevel ?? null

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

  if (vex != null && vex > GEX_THRESHOLDS.VEX_TAILWIND && vixLast != null && vixLast < 20) raw += 1

  if (termStructure?.structure === 'contango') raw += 1

  // Penalties
  if (vixLast != null && vixLast > 25) raw -= 2
  if (earningsCritical) raw -= 2
  if (spyLast != null && zgl != null && spyLast < zgl) raw -= 1

  const score = Math.max(0, Math.min(10, raw))

  // --- vanna_regime ---
  let vannaRegime: 'tailwind' | 'neutral' | 'headwind'
  if (vex != null && vex > GEX_THRESHOLDS.VEX_TAILWIND && vixLast != null && vixLast < 20) {
    vannaRegime = 'tailwind'
  } else if (vex != null && vex < GEX_THRESHOLDS.VEX_HEADWIND) {
    vannaRegime = 'headwind'
  } else if (vixLast != null && vixLast > 20) {
    vannaRegime = 'headwind'
  } else {
    vannaRegime = 'neutral'
  }

  // --- charm_pressure ---
  let charmPressure: 'significant' | 'moderate' | 'neutral'
  const absCex = cex != null ? Math.abs(cex) : null
  if (absCex != null && absCex > GEX_THRESHOLDS.CEX_SIGNIFICANT) {
    charmPressure = 'significant'
  } else if (absCex != null && absCex > GEX_THRESHOLDS.CEX_MODERATE) {
    charmPressure = 'moderate'
  } else {
    charmPressure = 'neutral'
  }

  // --- price_distribution ---
  const priceDistribution = spyLast != null ? computePriceDistribution(spyLast) : null

  // --- regime flip count ---
  const regimeFlipCount = getRegimeFlipCount()

  return { score, vannaRegime, charmPressure, priceDistribution, regimeFlipCount }
}

// ---------------------------------------------------------------------------
// NoTrade Score — aggregates all active vetos into a single operability signal
// ---------------------------------------------------------------------------

export type NoTradeLevel = 'clear' | 'caution' | 'avoid'

export interface NoTradeResult {
  /** Sum of veto weights (higher = more reasons NOT to trade). */
  noTradeScore: number
  /** Human-readable list of active veto reasons. */
  activeVetos: string[]
  /** Operability level derived from noTradeScore: clear(0-1) / caution(2-4) / avoid(5+). */
  noTradeLevel: NoTradeLevel
}

/**
 * Aggregates all structural veto conditions into a single NoTrade signal.
 * Each veto carries a weight; the sum determines the operability level.
 *
 * Weight reference:
 *  - Post-OPEX day: 3 (GEX resetado, vol pode expandir)
 *  - VEX negative + VIX >20: 3 (amplificação bearish)
 *  - Regime flipped ≥2x: 2 (structural indecision)
 *  - Skew flat/inverted (RR25 > -0.3): 2 (puts não pagam extra)
 *  - SPY < VT + VIX >18: 2 (short gamma env)
 *  - OPEX day: 2 (liquidação de posições)
 *  - Earnings ≤2 dias: 1 (per component)
 *  - GEX all-negative: 1 (amplificação generalizada)
 *  - VIX spike >20%: 1
 */
export function computeNoTradeScore(gexDynamic: GEXDynamic | null): NoTradeResult {
  const activeVetos: string[] = []
  let noTradeScore = 0

  const opex = getOpexStatus()
  const vixLast = marketState.vix.last ?? null
  const vixChangePct = marketState.vix.changePct ?? null
  const spyLast = marketState.spy.last ?? null
  const flipCount = getRegimeFlipCount()

  // Post-OPEX: heaviest veto (weight 3)
  if (opex.isPostOpex) {
    noTradeScore += 3
    activeVetos.push('Pós-OPEX: GEX resetado — vol pode expandir abruptamente')
  }

  // VEX negative + VIX >20 compound veto (weight 3)
  const vexAll = gexDynamic && gexDynamic.length > 0
    ? gexDynamic.reduce((sum, e) => sum + (e.gex.totalVannaExposure ?? 0), 0)
    : null
  if (vexAll !== null && vexAll < GEX_THRESHOLDS.VEX_DANGER && vixLast !== null && vixLast > 20) {
    noTradeScore += 3
    activeVetos.push(`VEX=${vexAll.toFixed(1)}M negativo + VIX=${vixLast.toFixed(1)} >20 — amplificação bearish`)
  }

  // Regime flip ≥2 (weight 2)
  if (flipCount >= 2) {
    noTradeScore += 2
    activeVetos.push(`Regime GEX flipou ${flipCount}x hoje — mercado estruturalmente indeciso`)
  }

  // Skew flat (weight 2): RR25 > -1.0% — puts sem prêmio suficiente para put spread
  // Skew invertido (weight +1 adicional): RR25 > 0% — calls mais caras que puts (destrutivo)
  const skewSnap = getSkewSnapshot()
  const relevantSkew = skewSnap?.dte21 ?? skewSnap?.dte7 ?? skewSnap?.dte0
  if (relevantSkew && relevantSkew.riskReversal25 > -1.0) {
    noTradeScore += 2
    activeVetos.push(`Skew flat: RR25=${relevantSkew.riskReversal25.toFixed(2)}% — puts sem prêmio para put spread`)
  }
  if (relevantSkew && relevantSkew.riskReversal25 > 0) {
    noTradeScore += 1
    activeVetos.push('Skew INVERTIDO — calls mais caras que puts, NÃO vender put spread')
  }

  // SPY below VT + VIX >18 (weight 2)
  const vtAll = gexDynamic && gexDynamic.length > 0 ? gexDynamic[0].gex.volatilityTrigger ?? null : null
  if (vtAll !== null && spyLast !== null && spyLast < vtAll && (vixLast ?? 0) > 18) {
    noTradeScore += 2
    activeVetos.push(`SPY $${spyLast.toFixed(2)} < VT $${vtAll.toFixed(2)} com VIX>18 — short gamma environment`)
  }

  // OPEX day (weight 2)
  if (opex.isOpexDay) {
    noTradeScore += 2
    activeVetos.push('OPEX hoje: liquidação de posições — não abrir novas entradas')
  }

  // Earnings ≤2 dias (weight 1 each, max 2)
  const urgentEarnings = (newsSnapshot.earnings ?? []).filter(
    (e) => e.daysToEarnings != null && e.daysToEarnings >= 0 && e.daysToEarnings <= 2,
  )
  if (urgentEarnings.length > 0) {
    const w = Math.min(urgentEarnings.length, 2)
    noTradeScore += w
    activeVetos.push(`Earnings em ≤2 dias: ${urgentEarnings.slice(0, 4).map((e) => e.symbol).join(', ')}`)
  }

  // All-negative GEX regime (weight 1)
  if (gexDynamic && gexDynamic.length > 0 && gexDynamic.every((e) => e.gex.regime === 'negative')) {
    noTradeScore += 1
    activeVetos.push(`GEX negativo em todos os ${gexDynamic.length} vencimentos — ambiente de amplificação`)
  }

  // VIX spike >20% (weight 1)
  if (vixChangePct !== null && Math.abs(vixChangePct) > 20) {
    noTradeScore += 1
    activeVetos.push(`VIX spike ${vixChangePct >= 0 ? '+' : ''}${vixChangePct.toFixed(1)}% — aguardar normalização`)
  }

  const noTradeLevel: NoTradeLevel =
    noTradeScore >= 5 ? 'avoid' :
    noTradeScore >= 2 ? 'caution' :
    'clear'

  return { noTradeScore, activeVetos, noTradeLevel }
}

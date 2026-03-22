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
import { getTechnicalSnapshot } from './technicalIndicatorsState'
import { getOptionChainSnapshot } from './optionChain'
import { buildSurfaceFromChain, getClosestSmile, getSurfaceQuality } from '../lib/volSurface'
import type { VolSmile, SurfaceQuality } from '../lib/volSurface'
import type { GEXDynamic } from './gexService'
import { GEX_THRESHOLDS } from '../lib/gexThresholds'
import { getRVOLSnapshot } from './rvolPoller'
import { classifyDayType } from '../lib/dayTypeClassifier'
import type { DayTypeResult } from '../lib/dayTypeClassifier'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RegimeLabel =
  | 'low_vol_suppressed'
  | 'normal_mean_reverting'
  | 'normal_amplifying'
  | 'elevated_vol_mean_reverting'
  | 'elevated_vol_amplifying'
  | 'high_vol_stress'
  | 'unknown'

export interface RegimeLabelResult {
  label: RegimeLabel
  confidence: number  // 0–1
}

export type { DayTypeResult }

export interface PriceDistribution {
  p10: number
  p25: number
  p50: number
  p75: number
  p90: number
  expected_range_1sigma: string
  /** true when left tail was adjusted using the option chain vol surface. */
  skewAdjusted: boolean
  /** true when the quadratic vol surface was used (vs. RR25-only fallback). */
  surfaceFitted: boolean
}

export interface RegimeScorerResult {
  score: number               // 0–10, integer, clamped
  vannaRegime: 'tailwind' | 'neutral' | 'headwind'
  charmPressure: 'significant' | 'moderate' | 'neutral'
  priceDistribution: PriceDistribution | null
  /** Number of times GEX regime flipped sign today (positive↔negative). ≥2 = structural indecision. */
  regimeFlipCount: number
  /** Quality of the fitted vol surface (null when chain unavailable). */
  surfaceQuality: SurfaceQuality | null
}

export type { SurfaceQuality }

export type GexComparison =
  | 'stronger_positive'
  | 'weaker_positive'
  | 'unchanged'
  | 'weaker_negative'
  | 'stronger_negative'

// ---------------------------------------------------------------------------
// GEX history for gex_vs_yesterday e gex_trend_5d (in-memory, max 5 entries)
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
    if (gexDailyHistory.length > 5) gexDailyHistory.shift()  // max 5 dias
  } else {
    gexDailyHistory.at(-1)!.total = total
  }
}

export function getGexVsYesterday(current: number): GexComparison | null {
  if (gexDailyHistory.length < 2) return null
  const prev = gexDailyHistory[gexDailyHistory.length - 2].total
  const change = current - prev
  const threshold = Math.max(Math.abs(prev) * 0.05, 0.5)
  if (Math.abs(change) < threshold) return 'unchanged'
  if (current >= 0 && prev >= 0) return change > 0 ? 'stronger_positive' : 'weaker_positive'
  if (current < 0 && prev < 0) return change > 0 ? 'weaker_negative' : 'stronger_negative'
  return change > 0 ? 'stronger_positive' : 'stronger_negative'
}

/**
 * Tendência de 5 dias do GEX total ($M).
 * Retorna null quando há menos de 3 entradas (sem tendência confiável).
 * Threshold de 10% relativo ou 0.5$M absoluto para classificar como rising/falling.
 */
export function getGexTrend5d(): 'rising' | 'flat' | 'falling' | null {
  if (gexDailyHistory.length < 3) return null
  const oldest = gexDailyHistory[0].total
  const newest = gexDailyHistory.at(-1)!.total
  const threshold = Math.max(Math.abs(oldest) * 0.10, 0.5)
  const change = newest - oldest
  if (change > threshold) return 'rising'
  if (change < -threshold) return 'falling'
  return 'flat'
}

/**
 * Pré-popula gexDailyHistory com até 5 dias de história do Redis.
 * Chamado no startup do servidor via index.ts.
 * GEXDailySnapshot.netGex está em $B — convertemos para $M (×1000) para alinhar
 * com o updateGexHistory que recebe valores em $M do advancedMetricsPoller.
 */
export async function seedGexHistoryFromRedis(): Promise<void> {
  try {
    // Import dinâmico para evitar dependência circular em tempo de inicialização
    const { loadGEXHistory } = await import('./gexHistoryService')
    const history = await loadGEXHistory(5)
    if (history.length === 0) {
      console.log('[RegimeScorer] Seed GEX history: sem dados Redis para pré-popular')
      return
    }
    // Pré-popular sem sobrescrever entradas do dia atual (se já existirem)
    const today = getETDateString()
    for (const snap of history) {
      if (!gexDailyHistory.some((h) => h.date === snap.capturedAt)) {
        gexDailyHistory.push({
          date: snap.capturedAt,
          total: snap.netGex * 1000,  // $B → $M
        })
      }
    }
    // Garantir ordem cronológica e limite de 5
    gexDailyHistory.sort((a, b) => a.date.localeCompare(b.date))
    if (gexDailyHistory.length > 5) gexDailyHistory = gexDailyHistory.slice(-5)
    console.log(
      `[RegimeScorer] Seed GEX history: ${gexDailyHistory.length} dias carregados ` +
      `[${gexDailyHistory.map((h) => `${h.date}:${h.total >= 0 ? '+' : ''}${h.total.toFixed(1)}M`).join(', ')}] ` +
      `(hoje=${today})`,
    )
  } catch (err) {
    console.warn('[RegimeScorer] Seed GEX history falhou — inicia sem histórico:', (err as Error).message)
  }
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

function computePriceDistribution(
  spot: number,
): { dist: PriceDistribution | null; smiles: VolSmile[]; surfaceQuality: SurfaceQuality | null } {
  const emSnapshot = getExpectedMoveSnapshot()
  if (!emSnapshot || Object.keys(emSnapshot.byExpiry).length === 0) {
    return { dist: null, smiles: [], surfaceQuality: null }
  }

  // Find entry with DTE closest to 21
  let bestEntry: { dte: number; expectedMove: number } | null = null
  for (const entry of Object.values(emSnapshot.byExpiry)) {
    if (!bestEntry || Math.abs(entry.dte - 21) < Math.abs(bestEntry.dte - 21)) {
      bestEntry = entry
    }
  }
  if (!bestEntry || bestEntry.expectedMove <= 0) {
    return { dist: null, smiles: [], surfaceQuality: null }
  }

  const em = bestEntry.expectedMove
  const sigma = em / 1.645  // treat EM as ±1.645σ (90% CI of straddle)

  // ---------------------------------------------------------------------------
  // Vol surface — build from chain if available
  // ---------------------------------------------------------------------------
  const chain = getOptionChainSnapshot()
  const smiles: VolSmile[] = chain && chain.length > 0 ? buildSurfaceFromChain(chain, spot) : []
  const surfaceQuality = smiles.length > 0 ? getSurfaceQuality(smiles) : null

  let p10: number, p25: number, p50: number, p75: number, p90: number
  let skewAdjusted = false
  let surfaceFitted = false

  // Primary path: use quadratic smile when available with R² ≥ 0.70
  const smile21d = getClosestSmile(smiles, 21)
  if (smile21d && smile21d.r2 >= 0.70 && smile21d.a > 0) {
    // Approximate log-moneyness at p10 / p25 initial estimates
    const k_p10 = Math.log(Math.max(spot - 1.645 * sigma, 1) / spot)
    const k_p25 = Math.log(Math.max(spot - 0.674 * sigma, 1) / spot)
    const k_p90 = Math.log((spot + 1.645 * sigma) / spot)

    const iv_atm = Math.max(smile21d.a, 0.01)
    const iv_p10 = Math.max(smile21d.a + smile21d.b * k_p10 + smile21d.c * k_p10 * k_p10, 0.01)
    const iv_p25 = Math.max(smile21d.a + smile21d.b * k_p25 + smile21d.c * k_p25 * k_p25, 0.01)
    const iv_p90 = Math.max(smile21d.a + smile21d.b * k_p90 + smile21d.c * k_p90 * k_p90, 0.01)

    // Scale sigma at each percentile by the smile vol ratio
    // A higher vol at the p10 strike means the tail is fatter than log-normal
    p10 = spot - 1.645 * sigma * (iv_p10 / iv_atm)
    p25 = spot - 0.674 * sigma * (iv_p25 / iv_atm)
    p50 = spot
    p75 = spot + 0.674 * sigma
    p90 = spot + 1.645 * sigma * (iv_p90 / iv_atm)

    skewAdjusted = iv_p10 > iv_atm * 1.01  // meaningful asymmetry detected
    surfaceFitted = true

  } else {
    // Fallback: RR25-based skew adjustment (2-point linear interpolation)
    const skewSnap = getSkewSnapshot()
    const skewEntry = skewSnap?.dte21 ?? skewSnap?.dte7 ?? skewSnap?.dte0
    const hasSkew = skewEntry != null && skewEntry.riskReversal25 < -1.0

    if (hasSkew && skewEntry) {
      const skewFactor = Math.min(Math.abs(skewEntry.riskReversal25) / 100, 0.05)
      const leftShift = spot * skewFactor * 0.5
      p10 = spot - 1.645 * sigma - leftShift * 1.5
      p25 = spot - 0.674 * sigma - leftShift * 0.8
      p50 = spot
      p75 = spot + 0.674 * sigma
      p90 = spot + 1.645 * sigma * 0.90
      skewAdjusted = true
    } else {
      p10 = spot - 1.645 * sigma
      p25 = spot - 0.674 * sigma
      p50 = spot
      p75 = spot + 0.674 * sigma
      p90 = spot + 1.645 * sigma
    }
  }

  const dist: PriceDistribution = {
    p10: parseFloat(p10.toFixed(2)),
    p25: parseFloat(p25.toFixed(2)),
    p50: parseFloat(p50.toFixed(2)),
    p75: parseFloat(p75.toFixed(2)),
    p90: parseFloat(p90.toFixed(2)),
    expected_range_1sigma: `$${(spot - sigma).toFixed(2)}–$${(spot + sigma).toFixed(2)}`,
    skewAdjusted,
    surfaceFitted,
  }

  return { dist, smiles, surfaceQuality }
}

// ---------------------------------------------------------------------------
// Regime label — semantic categorical classification from existing state
// ---------------------------------------------------------------------------

/**
 * Derives a human-readable regime label + confidence from existing computed data.
 * Phase 1: deterministic rules from VIX level + GEX sign.
 * Phase 2 will replace this with the full 0–100 composite scoring.
 *
 * Confidence reflects how many indicators agree with the label:
 *  - IV Rank confirms VIX level: +0.15
 *  - Term structure consistent with GEX sign: +0.15
 *  - IV/HV spread confirms seller edge: +0.10
 */
export function computeRegimeLabel(gexDynamic: GEXDynamic | null): RegimeLabelResult {
  const vixLast = marketState.vix.last ?? null
  const ivRank  = marketState.ivRank.value ?? null
  const ivx     = marketState.ivRank.ivx ?? null
  const hv30    = marketState.ivRank.hv30 ?? null
  const termStructure = getVIXTermStructureSnapshot()

  // Derive GEX sign from aggregated net gamma (all expirations)
  const totalNetGamma = gexDynamic && gexDynamic.length > 0
    ? gexDynamic.reduce((sum, e) => sum + e.gex.totalNetGamma, 0)
    : null
  const gexPositive = totalNetGamma != null ? totalNetGamma > 0 : null

  // Base label from VIX level + GEX sign
  let label: RegimeLabel = 'unknown'

  if (vixLast != null) {
    if (vixLast < 15) {
      label = 'low_vol_suppressed'
    } else if (vixLast < 20) {
      label = gexPositive === false ? 'normal_amplifying' : 'normal_mean_reverting'
    } else if (vixLast < 30) {
      label = gexPositive === false ? 'elevated_vol_amplifying' : 'elevated_vol_mean_reverting'
    } else {
      label = 'high_vol_stress'
    }
  }

  // Confidence — starts at 0.55, add alignment bonuses
  let confidence = 0.55

  // IV Rank aligns with VIX level
  if (ivRank != null && vixLast != null) {
    const highVolLabel = label === 'elevated_vol_amplifying' || label === 'elevated_vol_mean_reverting' || label === 'high_vol_stress'
    const lowVolLabel  = label === 'low_vol_suppressed' || label === 'normal_mean_reverting'
    if (highVolLabel && ivRank >= 40)  confidence += 0.15
    if (lowVolLabel  && ivRank < 30)   confidence += 0.15
    if (highVolLabel && ivRank < 20)   confidence -= 0.10  // contradiction
  }

  // Term structure consistent with GEX regime
  if (termStructure?.structure != null) {
    const ts = termStructure.structure
    if (gexPositive === true  && ts === 'contango')      confidence += 0.10
    if (gexPositive === false && ts === 'backwardation') confidence += 0.10
    if (ts === 'humped')                                  confidence -= 0.05  // event uncertainty
  }

  // IV/HV spread confirms seller edge for elevated labels
  if (ivx != null && hv30 != null && hv30 > 0) {
    const spread = ivx - hv30
    const sellerLabel = label === 'elevated_vol_mean_reverting' || label === 'normal_mean_reverting'
    if (sellerLabel && spread > 3.0) confidence += 0.10
    if (sellerLabel && spread < 0)   confidence -= 0.10
  }

  // Missing VIX: unknown label, low confidence
  if (vixLast == null) {
    confidence = 0.20
  }

  confidence = Math.max(0.15, Math.min(0.92, confidence))

  return {
    label,
    confidence: Math.round(confidence * 100) / 100,
  }
}

// ---------------------------------------------------------------------------
// Day type from current market state
// ---------------------------------------------------------------------------

export function computeDayTypeFromState(gexDynamic: GEXDynamic | null): DayTypeResult {
  const totalNetGamma = gexDynamic && gexDynamic.length > 0
    ? gexDynamic.reduce((sum, e) => sum + e.gex.totalNetGamma, 0)
    : null
  const gexPositive = totalNetGamma != null ? totalNetGamma > 0 : null

  return classifyDayType({
    spyLast:      marketState.spy.last,
    spyOpen:      marketState.spy.open,
    spyPrevClose: marketState.spy.prevClose,
    dayHigh:      marketState.spy.dayHigh,
    dayLow:       marketState.spy.dayLow,
    gexPositive,
    vixChangePct: marketState.vix.changePct,
  })
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

  // --- Momentum técnico (RSI + MACD crossover) — máx ±2 pontos ---
  // Lido do snapshot mais recente do technicalIndicatorsPoller (Wilder EMA RSI).
  // Só aplica quando há dados suficientes (dataStatus='ok').
  const tech = getTechnicalSnapshot()
  if (tech?.dataStatus === 'ok') {
    const rsi14 = tech.rsi14
    const crossover = tech.macd.crossover

    // RSI em zona bullish (55–70): momentum confirma long gamma — +1
    // RSI sobrecomprado (>72): risco aumentado para short put — -1
    // RSI em zona bearish (20–35): pressão downside — -1
    if (rsi14 > 55 && rsi14 <= 70) raw += 1
    else if (rsi14 > 72) raw -= 1
    else if (rsi14 >= 20 && rsi14 < 35) raw -= 1

    // MACD crossover: confirmação direcional (+1 / -1)
    if (crossover === 'bullish') raw += 1
    else if (crossover === 'bearish') raw -= 1
  }

  // RVOL > 1.5 com acumulação + VIX < 18 + GEX positivo → fluxo institucional comprador
  const rvol = getRVOLSnapshot()
  if (
    rvol && rvol.rvol > 1.5 &&
    rvol.rvolBias === 'accumulation' &&
    vixLast != null && vixLast < 18 &&
    totalNetGamma != null && totalNetGamma > 0
  ) {
    raw += 1
  }

  // Clampar em 0–10 (max interno pode chegar a 13 com momentum + RVOL confirmando tudo)
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

  // --- price_distribution + vol surface ---
  let priceDistribution: PriceDistribution | null = null
  let surfaceQuality: SurfaceQuality | null = null
  if (spyLast != null) {
    const { dist, surfaceQuality: sq } = computePriceDistribution(spyLast)
    priceDistribution = dist
    surfaceQuality = sq
  }

  // --- regime flip count ---
  const regimeFlipCount = getRegimeFlipCount()

  return { score, vannaRegime, charmPressure, priceDistribution, regimeFlipCount, surfaceQuality }
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
  const termStructure = getVIXTermStructureSnapshot()

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

  // GEX caindo 5d + regime negativo (weight 2): dealers em modo de venda estrutural
  const gexTrend5d = getGexTrend5d()
  const allNegative = gexDynamic && gexDynamic.length > 0 && gexDynamic.every((e) => e.gex.regime === 'negative')
  if (gexTrend5d === 'falling' && allNegative) {
    noTradeScore += 2
    activeVetos.push('GEX queda 5d + regime negativo — dealers em modo de venda estrutural')
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

  // VIX1D proxy > 1.15× VIX spot (weight 2): backwardation de curtíssimo prazo
  // O mercado de opções está pagando mais pelo vencimento imediato do que pelo VIX spot —
  // sinal de stress intraday iminente (análogo ao VIX1D/VIX da CBOE).
  const vix1dRatio = termStructure?.vix1dRatio ?? null
  if (vix1dRatio !== null && vix1dRatio > 1.15) {
    noTradeScore += 2
    activeVetos.push(`VIX1D/VIX=${vix1dRatio.toFixed(2)} — backwardation de curtíssimo prazo, stress intraday iminente`)
  }

  // Term structure humped (weight 1): barriga da curva elevada acima dos dois extremos.
  // Indica evento binário precificado no mid-term (FOMC, CPI, OPEX) — convexidade adversa
  // para posições short volatilidade naquele vencimento.
  if (termStructure?.structure === 'humped') {
    const curvatureLbl = termStructure.curvature != null ? ` (curvature=${termStructure.curvature.toFixed(1)}%)` : ''
    noTradeScore += 1
    activeVetos.push(`Term structure humped${curvatureLbl} — evento binário precificado na barriga, risco de convexidade`)
  }

  // RVOL > 1.5 + VIX > 20 + SPY caindo → distribuição institucional agressiva (weight 1)
  const rvolSnap = getRVOLSnapshot()
  if (
    rvolSnap && rvolSnap.rvol > 1.5 &&
    rvolSnap.rvolBias === 'distribution' &&
    (vixLast ?? 0) > 20
  ) {
    noTradeScore += 1
    activeVetos.push(`RVOL=${rvolSnap.rvol.toFixed(2)}× distribuição institucional + VIX>${(vixLast ?? 0).toFixed(0)} — venda com volume acima do normal`)
  }

  const noTradeLevel: NoTradeLevel =
    noTradeScore >= 5 ? 'avoid' :
    noTradeScore >= 2 ? 'caution' :
    'clear'

  return { noTradeScore, activeVetos, noTradeLevel }
}

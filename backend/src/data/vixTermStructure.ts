import type { OptionExpiry } from './optionChain'

export interface VIXTermStructureResult {
  spot: number                                   // VIX spot price passed in
  curve: Array<{ dte: number; iv: number }>      // sorted ascending by DTE
  /**
   * Shape of the vol term structure:
   *   contango     — IV increases with tenor (>+2% from short to long)
   *   backwardation — IV decreases with tenor (< -2% from short to long)
   *   flat         — IV roughly constant (|steepness| ≤ 2%)
   *   humped       — mid-term IV elevated above both short and long ends;
   *                  indicates a discrete event (FOMC, CPI) priced in the belly of the curve.
   */
  structure: 'contango' | 'backwardation' | 'flat' | 'humped'
  steepness: number                              // (longTermIV - shortTermIV) / shortTermIV * 100
  /**
   * IV at the middle tenor of the curve (median-DTE point); null when curve has < 3 points.
   * A mid-term IV materially above both ends signals a pre-binary-event structure (humped).
   */
  midTermIV: number | null
  /**
   * Curvature: (midTermIV - shortTermIV) / shortTermIV * 100.
   * Positive = humped (belly elevated). Negative = monotonically falling.
   * null when curve has < 3 points.
   */
  curvature: number | null
  capturedAt: string                             // ISO 8601
  /**
   * IV do vencimento mais próximo (VIX-like%, ×100), proxy do VIX1D da CBOE.
   * null quando a curva tem menos de 1 ponto válido.
   */
  vix1dProxy: number | null
  /**
   * vix1dProxy / spot. Ratio > 1.15 = backwardation de curtíssimo prazo:
   * mercado pagando mais pelo vencimento imediato do que pelo VIX spot — stress iminente.
   */
  vix1dRatio: number | null
}

/**
 * Derives a volatility term structure from the existing SPY option chain.
 * Uses the ATM strike's IV (strike closest to current SPY price) per expiration
 * as a proxy for forward implied volatility at each tenor.
 *
 * Steepness thresholds: >2% = contango, <-2% = backwardation, else flat.
 * Humped: mid-term IV > both short-term and long-term by >3% relative — pre-event structure.
 * vix1dProxy: IV (%) do menor DTE — proxy do VIX1D CBOE.
 * vix1dRatio: vix1dProxy / vixSpot — >1.15 = stress intraday iminente.
 */
export function inferTermStructure(
  optionChain: OptionExpiry[],
  vixSpot: number,
  spyPrice: number,
): VIXTermStructureResult | null {
  if (optionChain.length === 0 || spyPrice <= 0) return null

  const sorted = [...optionChain].sort((a, b) => a.dte - b.dte)

  const curve = sorted
    .map((exp) => {
      // Find the ATM call (strike closest to current SPY price with a valid IV)
      const atmCall = exp.calls
        .filter((c) => c.iv !== null && c.iv > 0)
        .sort((a, b) => Math.abs(a.strike - spyPrice) - Math.abs(b.strike - spyPrice))[0]

      if (!atmCall?.iv) return null

      // Convert IV decimal to VIX-like annualised % (multiply by 100)
      return { dte: exp.dte, iv: Math.round(atmCall.iv * 100 * 10) / 10 }
    })
    .filter((p): p is { dte: number; iv: number } => p !== null)

  if (curve.length < 2) return null

  const shortTermIV = curve[0].iv
  const longTermIV = curve[curve.length - 1].iv

  // Guard: avoid division by zero
  if (shortTermIV <= 0) return null

  const steepness = Math.round(((longTermIV - shortTermIV) / shortTermIV) * 100 * 10) / 10

  // Curvature and mid-term IV — requires ≥ 3 curve points
  let midTermIV: number | null = null
  let curvature: number | null = null
  if (curve.length >= 3) {
    const midIdx = Math.floor(curve.length / 2)
    midTermIV = curve[midIdx].iv
    curvature = Math.round(((midTermIV - shortTermIV) / shortTermIV) * 100 * 10) / 10
  }

  // Structure classification:
  // 1. Humped: mid-term IV elevated above both ends by >3% relative (pre-event belly)
  //    This indicates the market is pricing a specific binary event (FOMC, CPI, earnings)
  //    in the mid-term bucket — convexity is adverse for short-vol positions at that tenor.
  // 2. Otherwise: standard contango / flat / backwardation based on end-to-end steepness.
  let structure: VIXTermStructureResult['structure']
  const isHumped = (
    midTermIV !== null &&
    curvature !== null &&
    curvature > 3.0 &&                           // mid is >3% above front end
    midTermIV > longTermIV                        // and also above back end
  )
  if (isHumped) {
    structure = 'humped'
  } else {
    structure = steepness > 2 ? 'contango' : steepness < -2 ? 'backwardation' : 'flat'
  }

  // VIX1D proxy: IV do menor DTE da curva (já em VIX-like %, ×100)
  const vix1dProxy = curve[0].iv
  const vix1dRatio = vixSpot > 0 ? Math.round((vix1dProxy / vixSpot) * 1000) / 1000 : null

  return {
    spot: vixSpot,
    curve,
    structure,
    steepness,
    midTermIV,
    curvature,
    capturedAt: new Date().toISOString(),
    vix1dProxy,
    vix1dRatio,
  }
}

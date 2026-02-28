import type { OptionExpiry } from './optionChain'

export interface VIXTermStructureResult {
  spot: number                                   // VIX spot price passed in
  curve: Array<{ dte: number; iv: number }>      // sorted ascending by DTE
  structure: 'contango' | 'backwardation' | 'flat'
  steepness: number                              // (longTermIV - shortTermIV) / shortTermIV * 100
  capturedAt: string                             // ISO 8601
}

/**
 * Derives a volatility term structure from the existing SPY option chain.
 * Uses the ATM strike's IV (strike closest to current SPY price) per expiration
 * as a proxy for forward implied volatility at each tenor.
 *
 * Steepness thresholds: >2% = contango, <-2% = backwardation, else flat.
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
  const structure =
    steepness > 2 ? 'contango' : steepness < -2 ? 'backwardation' : 'flat'

  return {
    spot: vixSpot,
    curve,
    structure,
    steepness,
    capturedAt: new Date().toISOString(),
  }
}

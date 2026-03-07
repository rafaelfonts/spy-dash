/**
 * Max Pain Calculator — pure function, no side effects.
 *
 * Max Pain = the strike price where the total intrinsic value (dollar pain) of all
 * in-the-money options is minimized, i.e., the price where option sellers (market
 * makers) would pay out the least if the underlying expired at that price.
 *
 * Algorithm (standard):
 *   For each candidate strike S:
 *     pain(S) = Σ max(0, S − K) × callOI(K) + Σ max(0, K − S) × putOI(K)  for all K
 *   maxPainStrike = argmin pain(S)
 *
 * Multiplied by 100 (contract size) internally for correctness, but since it's
 * a relative minimization the factor cancels — result is just the strike with min pain.
 */

export interface MaxPainInput {
  strike: number
  callOI: number
  putOI: number
}

export interface MaxPainResult {
  maxPainStrike: number
  distanceFromSpot: number       // signed: positive = max pain above spot
  distancePct: number            // signed %
  pinRisk: 'high' | 'moderate' | 'low'  // high <0.5%, moderate 0.5–1.5%, low >1.5%
}

/**
 * Calculates Max Pain from a strike-level OI breakdown.
 * Returns null if input is empty or all OI is zero.
 */
export function calculateMaxPain(
  strikes: MaxPainInput[],
  spotPrice: number,
): MaxPainResult | null {
  if (strikes.length === 0) return null

  const hasOI = strikes.some((s) => s.callOI > 0 || s.putOI > 0)
  if (!hasOI) return null

  // For each candidate strike, compute total pain
  let minPain = Infinity
  let maxPainStrike = strikes[0].strike

  for (const candidate of strikes) {
    const S = candidate.strike
    let pain = 0

    for (const k of strikes) {
      // Call pain: calls are ITM when S > K (spot at S, calls struck at K expire ITM)
      if (S > k.strike) {
        pain += (S - k.strike) * k.callOI
      }
      // Put pain: puts are ITM when K > S (spot at S, puts struck at K expire ITM)
      if (k.strike > S) {
        pain += (k.strike - S) * k.putOI
      }
    }

    if (pain < minPain) {
      minPain = pain
      maxPainStrike = S
    }
  }

  const distanceFromSpot = maxPainStrike - spotPrice
  const distancePct = spotPrice > 0 ? (distanceFromSpot / spotPrice) * 100 : 0
  const absPct = Math.abs(distancePct)

  const pinRisk: MaxPainResult['pinRisk'] =
    absPct < 0.5 ? 'high' :
    absPct < 1.5 ? 'moderate' :
    'low'

  return {
    maxPainStrike,
    distanceFromSpot: Math.round(distanceFromSpot * 100) / 100,
    distancePct: Math.round(distancePct * 100) / 100,
    pinRisk,
  }
}

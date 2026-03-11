/**
 * Black-Scholes-Merton Greeks calculator — pure TypeScript, zero dependencies.
 *
 * Conventions:
 *   S     = spot price
 *   K     = strike price
 *   T     = time to expiry in years (dte/365; use 0.5/365 for 0DTE)
 *   r     = risk-free rate as decimal (e.g. 0.053 for 5.3%)
 *   sigma = implied volatility as decimal (e.g. 0.15 for 15%)
 *   type  = 'call' | 'put'
 */

/**
 * Standard normal CDF using Abramowitz & Stegun approximation (26.2.17).
 * Max absolute error: 7.5e-8
 */
function normCdf(x: number): number {
  if (x >= 8) return 1
  if (x <= -8) return 0

  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const poly =
    t * (0.319381530 +
    t * (-0.356563782 +
    t * (1.781477937 +
    t * (-1.821255978 +
    t * 1.330274429))))
  const approx = 1 - normPdf(x) * poly

  return x >= 0 ? approx : 1 - approx
}

/**
 * Standard normal PDF.
 */
function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
}

/**
 * Compute d1 and d2 for BSM. Returns null if inputs are invalid.
 */
function d1d2(
  S: number, K: number, T: number, r: number, sigma: number
): { d1: number; d2: number } | null {
  if (S <= 0 || K <= 0 || T <= 0) return null
  const sigClamped = Math.max(sigma, 0.001)
  const sqrtT = Math.sqrt(T)
  const d1 = (Math.log(S / K) + (r + 0.5 * sigClamped * sigClamped) * T) / (sigClamped * sqrtT)
  const d2 = d1 - sigClamped * sqrtT
  return { d1, d2 }
}

/**
 * Delta — rate of change of option price with respect to spot.
 *   Call: Φ(d1)          (0 to 1)
 *   Put:  Φ(d1) - 1      (-1 to 0)
 */
export function calcDelta(
  S: number, K: number, T: number, r: number, sigma: number,
  type: 'call' | 'put'
): number {
  const dd = d1d2(S, K, T, r, sigma)
  if (!dd) {
    // Boundary values when T=0: 1 if ITM, 0 if OTM
    const itm = type === 'call' ? S > K : S < K
    return type === 'call' ? (itm ? 1 : 0) : (itm ? -1 : 0)
  }
  const phi_d1 = normCdf(dd.d1)
  return type === 'call' ? phi_d1 : phi_d1 - 1
}

/**
 * Gamma — rate of change of delta with respect to spot (same for call and put).
 *   φ(d1) / (S * σ * √T)
 */
export function calcGamma(
  S: number, K: number, T: number, r: number, sigma: number
): number {
  const dd = d1d2(S, K, T, r, sigma)
  if (!dd) return 0
  const sigClamped = Math.max(sigma, 0.001)
  return normPdf(dd.d1) / (S * sigClamped * Math.sqrt(T))
}

/**
 * Theta — daily dollar decay (always negative for long options, divided by 365).
 *   Call: (-S·φ(d1)·σ/(2√T) - r·K·e^(-rT)·Φ(d2)) / 365
 *   Put:  (-S·φ(d1)·σ/(2√T) + r·K·e^(-rT)·Φ(-d2)) / 365
 */
export function calcTheta(
  S: number, K: number, T: number, r: number, sigma: number,
  type: 'call' | 'put'
): number {
  const dd = d1d2(S, K, T, r, sigma)
  if (!dd) return 0
  const sigClamped = Math.max(sigma, 0.001)
  const sqrtT = Math.sqrt(T)
  const common = -S * normPdf(dd.d1) * sigClamped / (2 * sqrtT)
  const disc = K * Math.exp(-r * T)

  const theta = type === 'call'
    ? (common - r * disc * normCdf(dd.d2)) / 365
    : (common + r * disc * normCdf(-dd.d2)) / 365

  return theta
}

/**
 * Vega — dollar sensitivity per 1% change in implied volatility (÷100 from raw BSM vega).
 *   S · φ(d1) · √T / 100
 */
export function calcVega(
  S: number, K: number, T: number, r: number, sigma: number
): number {
  const dd = d1d2(S, K, T, r, sigma)
  if (!dd) return 0
  return S * normPdf(dd.d1) * Math.sqrt(T) / 100
}

/**
 * Vanna — ∂Δ/∂σ (delta sensitivity to IV). Same for call and put in BSM.
 *   Vanna = S · φ(d1) · √T · (-d2/σ)
 * Used for VEX (Vanna Exposure) aggregation: OI × 100 × S × vanna → $ exposure per 1 decimal σ move.
 */
export function calcVanna(
  S: number, K: number, T: number, r: number, sigma: number
): number {
  const dd = d1d2(S, K, T, r, sigma)
  if (!dd) return 0
  const sigClamped = Math.max(sigma, 0.001)
  const sqrtT = Math.sqrt(T)
  return S * normPdf(dd.d1) * sqrtT * (-dd.d2 / sigClamped)
}

/**
 * Charm — ∂Δ/∂t (delta decay per year). Negative for long options as time passes.
 *   Charm = -φ(d1) · (2rT - d2·σ·√T) / (2T·σ·√T)
 * Return is per year. For $M/day CEX use: (OI × 100 × S × charm) / 365 / 1e6.
 */
export function calcCharm(
  S: number, K: number, T: number, r: number, sigma: number
): number {
  const dd = d1d2(S, K, T, r, sigma)
  if (!dd) return 0
  const sigClamped = Math.max(sigma, 0.001)
  const sqrtT = Math.sqrt(T)
  const numerator = 2 * r * T - dd.d2 * sigClamped * sqrtT
  const denominator = 2 * T * sigClamped * sqrtT
  if (denominator <= 0) return 0
  return -normPdf(dd.d1) * numerator / denominator
}

/**
 * Risk-neutral probability that spot finishes above K at expiry (short put expires OTM).
 * Returns N(d2). Use for POP (Probability of Profit) of a sold put: POP = P(S > K) = N(d2).
 * S, K, T, r, sigma: same conventions as other BSM functions; sigma in decimal (e.g. 0.18 for 18%).
 * Returns value in [0, 1] (e.g. 0.72 = 72% POP).
 */
export function calcProbabilityOTMPut(
  S: number, K: number, T: number, r: number, sigma: number,
): number {
  const dd = d1d2(S, K, T, r, sigma)
  if (!dd) {
    if (T <= 0) return S > K ? 1 : 0
    return 0
  }
  return normCdf(dd.d2)
}

/**
 * Skew-adjusted POP for a short put at strike K.
 *
 * The flat-vol POP (calcProbabilityOTMPut) underestimates the real probability of loss
 * for OTM puts because it ignores the volatility smile: puts at 25-delta trade at a
 * higher IV than ATM (put skew). Using ATM vol for a deep OTM put overstates POP.
 *
 * This function interpolates the implied vol between ATM and the 25-delta put IV
 * proportionally to how far OTM the strike is relative to the theoretical 25d strike.
 * Beyond the 25-delta point, the vol is extrapolated linearly (capped at +50% of the
 * 25d IV premium to avoid numerical instability at very deep OTM strikes).
 *
 * @param S              Spot price
 * @param K              Put strike price (K ≤ S for OTM/ATM puts)
 * @param T              Time to expiry in years (dte/365; min 0.5/365 for 0DTE)
 * @param r              Risk-free rate as decimal (e.g. 0.053)
 * @param atmIV          ATM implied volatility as decimal (e.g. 0.18 for 18%)
 * @param put25dIVRatio  put-25d IV / ATM IV ratio — from SkewEntry.ivAtmSkewRatio.
 *                       Should be ≥ 1.0 in normal negative-skew markets.
 *                       Pass 1.0 (flat vol) when skew is unavailable or mild.
 * @returns POP in [0, 1]
 */
export function calcSkewAdjustedPOP(
  S: number,
  K: number,
  T: number,
  r: number,
  atmIV: number,
  put25dIVRatio: number,
): number {
  if (T <= 0) return S > K ? 1 : 0
  // Clamp ratio: must be ≥ 1.0 (put25d IV is never cheaper than ATM in normal skew)
  const ratio = Math.max(put25dIVRatio, 1.0)

  if (K >= S || ratio <= 1.0) {
    // ATM/ITM or no meaningful skew — use flat vol
    return calcProbabilityOTMPut(S, K, T, r, atmIV)
  }

  // Theoretical 25-delta put strike (lognormal approximation):
  //   N(d2) = 0.25 → d2 = Φ⁻¹(0.25) ≈ -0.674
  //   K_25d ≈ S × exp(-(r + σ²/2)T + 0.674·σ·√T)
  //   Simplified: K_25d ≈ S × exp(-0.674 · σ · √T)
  const sqrtT = Math.sqrt(T)
  const k25dApprox = S * Math.exp(-(r + 0.5 * atmIV * atmIV) * T + 0.674 * atmIV * sqrtT)

  // put25d IV = atmIV × ratio
  const put25dIV = atmIV * ratio

  if (K >= k25dApprox) {
    // Strike is between ATM and the 25d put: linear interpolation of vol
    const range = S - k25dApprox
    if (range <= 0) return calcProbabilityOTMPut(S, K, T, r, atmIV)
    const interpFrac = Math.max(0, Math.min(1, (S - K) / range))
    const interpolatedIV = atmIV + interpFrac * (put25dIV - atmIV)
    return calcProbabilityOTMPut(S, K, T, r, interpolatedIV)
  }

  // Strike is more OTM than the 25d put: linear extrapolation beyond put25dIV.
  // Capped at +50% of the premium to avoid instability at very deep OTM strikes.
  const beyond = (S - K) / (S - k25dApprox) - 1  // fraction beyond the 25d point
  const extraIV = put25dIV * (1 + Math.min(beyond * 0.5, 0.5))
  return calcProbabilityOTMPut(S, K, T, r, extraIV)
}

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

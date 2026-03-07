/**
 * Delta-Adjusted Notional (DAN) Calculator — pure function, no side effects.
 *
 * DAN measures the true directional hedge pressure from market makers (dealers),
 * expressed in dollar terms. Unlike raw P/C ratio (volume), DAN accounts for
 * how much each option actually moves the dealer's delta book.
 *
 * Formula (per contract):
 *   DAN = |delta| × OI × 100 × spot
 *
 * Convention (dealer perspective — standard for GEX analysis):
 *   - Call: dealer is SHORT the call → delta > 0 → dealer BUYS spot to hedge
 *     → callDAN is positive (buy pressure)
 *   - Put: dealer is SHORT the put → delta < 0 → dealer SELLS spot to hedge
 *     → putDAN is negative (sell pressure)
 *   - netDAN = callDAN + putDAN (signed)
 *     Positive = call-dominated (net buy pressure from dealer hedging)
 *     Negative = put-dominated (net sell pressure from dealer hedging)
 *
 * Values are in millions of USD ($M).
 */

export interface DANInput {
  strike: number
  option_type: 'call' | 'put'
  open_interest: number
  delta: number  // from BS or Tradier greeks (call: 0..1, put: -1..0)
}

export interface DANResult {
  callDAN: number       // total call delta exposure in $M (positive = dealer buy pressure)
  putDAN: number        // total put delta exposure in $M (negative = dealer sell pressure)
  netDAN: number        // callDAN + putDAN (signed)
  danBias: 'call_dominated' | 'put_dominated' | 'neutral'
  callDominancePct: number   // callDAN / (|callDAN| + |putDAN|) × 100
}

/**
 * Calculates Delta-Adjusted Notional from an option chain.
 * Returns null if input is empty or all OI/delta is zero.
 */
export function calculateDAN(
  options: DANInput[],
  spotPrice: number,
): DANResult | null {
  if (options.length === 0 || spotPrice <= 0) return null

  let rawCallDAN = 0
  let rawPutDAN = 0

  for (const opt of options) {
    const oi = opt.open_interest ?? 0
    if (oi <= 0) continue

    const delta = opt.delta
    if (delta == null || !isFinite(delta)) continue

    // DAN = |delta| × OI × 100 × spot (in dollars)
    const dan = Math.abs(delta) * oi * 100 * spotPrice

    if (opt.option_type === 'call') {
      rawCallDAN += dan   // dealer hedges by buying spot (positive)
    } else {
      rawPutDAN -= dan    // dealer hedges by selling spot (negative)
    }
  }

  const callDAN = Math.round((rawCallDAN / 1_000_000) * 100) / 100   // $M
  const putDAN = Math.round((rawPutDAN / 1_000_000) * 100) / 100     // $M (negative)
  const netDAN = Math.round((callDAN + putDAN) * 100) / 100

  const totalMagnitude = Math.abs(callDAN) + Math.abs(putDAN)
  if (totalMagnitude === 0) return null

  const callDominancePct = Math.round((Math.abs(callDAN) / totalMagnitude) * 10000) / 100

  // Neutral if |netDAN| < 10% of total magnitude
  const neutralThreshold = totalMagnitude * 0.10
  const danBias: DANResult['danBias'] =
    Math.abs(netDAN) < neutralThreshold ? 'neutral' :
    netDAN > 0 ? 'call_dominated' :
    'put_dominated'

  return { callDAN, putDAN, netDAN, danBias, callDominancePct }
}

import { calcGamma } from './blackScholes'

export interface StrikeGEX {
  strike: number
  callGEX: number   // in millions of dollars
  putGEX: number
  netGEX: number    // callGEX + putGEX
  callOI: number
  putOI: number
}

export interface GEXProfile {
  byStrike: StrikeGEX[]
  totalGEX: number          // sum of all netGEX
  flipPoint: number | null  // strike where cumulative GEX changes sign (discrete)
  zeroGammaLevel: number | null // continuous ZGL via BS re-simulation (Fase 3)
  maxGammaStrike: number    // strike with largest |netGEX|
  minGammaStrike: number    // strike with most negative netGEX (strongest put wall)
  callWall: number          // strike with highest call open interest
  putWall: number           // strike with highest put open interest
  regime: 'positive' | 'negative'
  calculatedAt: string      // ISO 8601
}

// ---------------------------------------------------------------------------
// calculateGEX — static GEX at the current spot price
// ---------------------------------------------------------------------------

export function calculateGEX(
  strikes: Array<{
    strike: number
    callOI: number
    callGamma: number
    putOI: number
    putGamma: number
  }>,
  spotPrice: number,
  zeroGammaLevel?: number | null,
): GEXProfile {
  // GEX = OI × gamma × 100 × S² / 1_000_000 (normalize to $M)
  const multiplier = (100 * spotPrice * spotPrice) / 1_000_000

  const byStrike: StrikeGEX[] = strikes
    .map((s) => {
      const callGEX = s.callOI * s.callGamma * multiplier
      const putGEX = -1 * s.putOI * s.putGamma * multiplier // puts: negative
      return {
        strike: s.strike,
        callGEX: Math.round(callGEX * 100) / 100,
        putGEX: Math.round(putGEX * 100) / 100,
        netGEX: Math.round((callGEX + putGEX) * 100) / 100,
        callOI: s.callOI,
        putOI: s.putOI,
      }
    })
    .sort((a, b) => a.strike - b.strike)

  const totalGEX = byStrike.reduce((sum, s) => sum + s.netGEX, 0)

  // Flip Point (discrete): strike where cumulative GEX changes sign, top-down
  let cumulative = 0
  let flipPoint: number | null = null
  for (let i = byStrike.length - 1; i >= 0; i--) {
    const prevCum = cumulative
    cumulative += byStrike[i].netGEX
    if ((prevCum >= 0 && cumulative < 0) || (prevCum < 0 && cumulative >= 0)) {
      flipPoint = byStrike[i].strike
      break
    }
  }

  const fallback = { strike: spotPrice, netGEX: 0, callOI: 0, putOI: 0 }

  const maxGamma =
    byStrike.length > 0
      ? byStrike.reduce((max, s) => (Math.abs(s.netGEX) > Math.abs(max.netGEX) ? s : max))
      : fallback

  const minGamma =
    byStrike.length > 0
      ? byStrike.reduce((min, s) => (s.netGEX < min.netGEX ? s : min))
      : fallback

  const callWallStrike =
    byStrike.length > 0
      ? byStrike.reduce((max, s) => (s.callOI > max.callOI ? s : max))
      : fallback

  const putWallStrike =
    byStrike.length > 0
      ? byStrike.reduce((max, s) => (s.putOI > max.putOI ? s : max))
      : fallback

  const roundedTotal = Math.round(totalGEX * 100) / 100

  if (Math.abs(roundedTotal) > 500) {
    console.warn(
      `[GEX] Total GEX fora do range esperado: $${roundedTotal}M (esperado: -500M a +500M)`,
    )
  }

  return {
    byStrike,
    totalGEX: roundedTotal,
    flipPoint,
    zeroGammaLevel: zeroGammaLevel ?? null,
    maxGammaStrike: maxGamma.strike,
    minGammaStrike: minGamma.strike,
    callWall: callWallStrike.strike,
    putWall: putWallStrike.strike,
    regime: totalGEX >= 0 ? 'positive' : 'negative',
    calculatedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// ZeroGammaContract — per-option input for ZGL simulation
// ---------------------------------------------------------------------------

export interface ZeroGammaContract {
  strike: number
  type: 'call' | 'put'
  oi: number
  /** Implied volatility as decimal (e.g. 0.15). Use smv_vol > mid_iv > fallback. */
  iv: number
  /** Time to expiry in years. Use 0.5/365 for 0DTE. */
  T: number
}

// ---------------------------------------------------------------------------
// findZeroGammaLevel — continuous ZGL via Black-Scholes re-simulation
//
// Algorithm:
//   netGamma(S) = Σ[ callOI_i × BS_gamma(S, K_i, ...) - putOI_i × BS_gamma(S, K_i, ...) ]
//
//   We find the root of netGamma(S) = 0 using bisection over [spotMin, spotMax].
//   Bisection is O(N × log((range)/precision)) ≈ 200 contracts × 14 iterations = ~2800 ops.
//
//   To avoid blocking the event loop on large chains, we yield via setImmediate
//   every YIELD_EVERY iterations.
//
// Risk-free rate: passed in as `r` (use the same FRED DFF value used elsewhere).
// ---------------------------------------------------------------------------

const YIELD_EVERY = 4   // yield every N bisection steps (each step = O(N) BS calcs)

function netGammaAtPrice(
  contracts: ZeroGammaContract[],
  S: number,
  r: number,
): number {
  // GEX(S) = Σ( sign × OI × gamma_BS(S) × 100 × S² ) / 1_000_000
  // The S² factor doesn't affect the zero-crossing, but we keep full formula
  // for consistency with calculateGEX so the ZGL is comparable to totalGEX.
  const multiplier = (100 * S * S) / 1_000_000
  let total = 0
  for (const c of contracts) {
    const g = calcGamma(S, c.strike, c.T, r, c.iv)
    const sign = c.type === 'call' ? 1 : -1
    total += sign * c.oi * g * multiplier
  }
  return total
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export async function findZeroGammaLevel(
  contracts: ZeroGammaContract[],
  spotPrice: number,
  r: number = 0.053,
  /** Search range as fraction of spot (default ±7%). */
  rangePct: number = 0.07,
  /** Target precision in dollars (default $0.01). */
  precision: number = 0.01,
): Promise<number | null> {
  if (contracts.length === 0) return null

  const lo = spotPrice * (1 - rangePct)
  const hi = spotPrice * (1 + rangePct)

  const gLo = netGammaAtPrice(contracts, lo, r)
  const gHi = netGammaAtPrice(contracts, hi, r)

  // If gamma doesn't change sign across the range, there is no ZGL in this window.
  // Fall back to the price with the smallest |netGamma| as a best-effort estimate.
  if (Math.sign(gLo) === Math.sign(gHi)) {
    // Grid scan at $1 increments to find closest-to-zero — yields periodically
    let bestPrice = spotPrice
    let bestAbs = Math.abs(netGammaAtPrice(contracts, spotPrice, r))
    let step = 0

    for (let S = lo; S <= hi; S += 1) {
      const abs = Math.abs(netGammaAtPrice(contracts, S, r))
      if (abs < bestAbs) {
        bestAbs = abs
        bestPrice = S
      }
      step++
      if (step % YIELD_EVERY === 0) await yieldToEventLoop()
    }

    console.warn(
      `[ZGL] No sign change in [${lo.toFixed(2)}, ${hi.toFixed(2)}]; ` +
      `closest-to-zero: S=${bestPrice.toFixed(2)} netGamma=${bestAbs.toFixed(4)}M`,
    )
    return Math.round(bestPrice * 100) / 100
  }

  // Standard bisection
  let low = gLo < 0 ? lo : hi
  let high = gLo < 0 ? hi : lo
  // Invariant: netGamma(low) < 0, netGamma(high) > 0
  let step = 0

  while (high - low > precision) {
    const mid = (low + high) / 2
    const gMid = netGammaAtPrice(contracts, mid, r)

    if (gMid < 0) {
      low = mid
    } else {
      high = mid
    }

    step++
    if (step % YIELD_EVERY === 0) await yieldToEventLoop()
  }

  const zgl = Math.round(((low + high) / 2) * 100) / 100
  console.log(
    `[ZGL] Converged in ${step} steps: ZGL=${zgl} ` +
    `(spot=${spotPrice.toFixed(2)}, range=[${lo.toFixed(2)}, ${hi.toFixed(2)}])`,
  )
  return zgl
}

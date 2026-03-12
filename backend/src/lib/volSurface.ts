/**
 * volSurface — Quadratic vol smile fit via OLS per expiration.
 *
 * Fits IV(k) = a + b·k + c·k² where k = log(K/S) using all option chain points.
 * OLS via closed-form 3×3 matrix inversion (no external dependencies).
 *
 * Usage:
 *   const smiles = buildSurfaceFromChain(chain, spot)
 *   const iv = getSmileIV(spot, strike, dteYears, smiles)
 */

import type { OptionExpiry } from '../data/optionChain'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VolSurfacePoint {
  strike: number
  iv: number        // decimal (0.15 = 15%)
}

export interface VolSmile {
  a: number         // intercept — approx ATM IV (k=0)
  b: number         // skew slope (< 0 = negative skew, puts > calls)
  c: number         // curvature / convexity (> 0 = typical smile)
  dte: number       // calendar days to expiration
  spotAtFit: number
  n: number         // number of points used for fit
  r2: number        // goodness of fit (0–1)
}

export interface SurfaceQuality {
  expirationsFitted: number
  avgR2: number
  status: 'fitted' | 'partial' | 'unavailable'
}

// ---------------------------------------------------------------------------
// 3×3 OLS helpers — closed-form inversion, no dependencies
// ---------------------------------------------------------------------------

/** Row-major 3×3 matrix. Index mapping: [0,1,2, 3,4,5, 6,7,8] */
type Mat3 = [
  number, number, number,
  number, number, number,
  number, number, number,
]

function det3(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  )
}

/** Returns the inverse of m, or null if singular (|det| < 1e-12). */
function inv3(m: Mat3): Mat3 | null {
  const d = det3(m)
  if (Math.abs(d) < 1e-12) return null
  const inv = 1 / d
  return [
    inv * (m[4] * m[8] - m[5] * m[7]),
    inv * (m[2] * m[7] - m[1] * m[8]),
    inv * (m[1] * m[5] - m[2] * m[4]),
    inv * (m[5] * m[6] - m[3] * m[8]),
    inv * (m[0] * m[8] - m[2] * m[6]),
    inv * (m[2] * m[3] - m[0] * m[5]),
    inv * (m[3] * m[7] - m[4] * m[6]),
    inv * (m[1] * m[6] - m[0] * m[7]),
    inv * (m[0] * m[4] - m[1] * m[3]),
  ]
}

/** Multiply 3×3 matrix by 3-vector → 3-vector. */
function matVec3(m: Mat3, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

// ---------------------------------------------------------------------------
// Core: fit quadratic smile IV(k) = a + b·k + c·k² via OLS
// ---------------------------------------------------------------------------

/**
 * Fits IV(k) = a + b·k + c·k² via OLS where k = log(K/S).
 *
 * Filters to valid IV points within ±15% log-moneyness (avoids far-wing noise).
 * Requires ≥ 4 valid points to over-determine 3 parameters.
 * Returns null when the fit is ill-conditioned or there are insufficient points.
 */
export function fitSmile(
  points: VolSurfacePoint[],
  spot: number,
  dte: number,
): VolSmile | null {
  if (spot <= 0) return null

  // Filter: valid IV, finite strike, within ±15% moneyness
  const valid = points.filter(
    (p) =>
      p.iv > 0 &&
      p.iv < 5 &&    // cap at 500% IV to exclude bad data
      p.strike > 0 &&
      isFinite(p.iv) &&
      Math.abs(Math.log(p.strike / spot)) <= 0.15,
  )
  if (valid.length < 4) return null  // need ≥ 4 to over-determine 3 params

  // Accumulate X'X (3×3 symmetric) and X'y (3-vector)
  // X row = [1, k, k²]  →  X'X = Σ [1, k, k²]' [1, k, k²]
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0
  let t0 = 0, t1 = 0, t2 = 0

  for (const pt of valid) {
    const k  = Math.log(pt.strike / spot)
    const k2 = k * k
    s0 += 1
    s1 += k
    s2 += k2
    s3 += k * k2   // k³
    s4 += k2 * k2  // k⁴
    t0 += pt.iv
    t1 += pt.iv * k
    t2 += pt.iv * k2
  }

  // X'X = [[s0,s1,s2],[s1,s2,s3],[s2,s3,s4]]
  const XtX: Mat3 = [
    s0, s1, s2,
    s1, s2, s3,
    s2, s3, s4,
  ]
  const inv = inv3(XtX)
  if (!inv) return null

  const [a, b, c] = matVec3(inv, [t0, t1, t2])

  // Compute R² goodness of fit
  const meanIV = t0 / valid.length
  let ssRes = 0, ssTot = 0
  for (const pt of valid) {
    const k = Math.log(pt.strike / spot)
    const fitted = a + b * k + c * k * k
    ssRes += (pt.iv - fitted) ** 2
    ssTot += (pt.iv - meanIV) ** 2
  }
  const r2 = ssTot < 1e-10 ? 1 : Math.max(0, 1 - ssRes / ssTot)

  return { a, b, c, dte, spotAtFit: spot, n: valid.length, r2 }
}

// ---------------------------------------------------------------------------
// Evaluate smile at arbitrary (S, K, T)
// ---------------------------------------------------------------------------

/**
 * Interpolates IV for a given (S, K) using the nearest DTE smile.
 *
 * Evaluates the polynomial in log-moneyness `k = log(K/S)`.
 * Falls back to `atmIV` when no smiles are available.
 * Floors the result at 1% IV to avoid degenerate inputs to BS.
 */
export function getSmileIV(
  S: number,
  K: number,
  dteYears: number,
  smiles: VolSmile[],
  atmIV = 0.15,
): number {
  if (smiles.length === 0 || S <= 0 || K <= 0) return atmIV

  const targetDte = dteYears * 365

  // Find closest DTE smile
  let best = smiles[0]
  let bestDiff = Math.abs(smiles[0].dte - targetDte)
  for (const s of smiles) {
    const diff = Math.abs(s.dte - targetDte)
    if (diff < bestDiff) {
      bestDiff = diff
      best = s
    }
  }

  // Evaluate quadratic in log-moneyness
  const k  = Math.log(K / S)
  const iv = best.a + best.b * k + best.c * k * k

  return Math.max(iv, 0.01)
}

// ---------------------------------------------------------------------------
// Build surface from option chain snapshot
// ---------------------------------------------------------------------------

/**
 * Builds a VolSmile[] from all expirations in the option chain.
 * Each expiration produces one smile fit (skipped if data is insufficient).
 * Sorted by ascending DTE.
 */
export function buildSurfaceFromChain(
  chain: OptionExpiry[],
  spot: number,
): VolSmile[] {
  const smiles: VolSmile[] = []

  for (const expiry of chain) {
    const points: VolSurfacePoint[] = []

    // Combine calls and puts — both contribute to the same surface
    for (const leg of [...expiry.calls, ...expiry.puts]) {
      if (leg.iv != null && leg.iv > 0 && leg.strike > 0) {
        points.push({ strike: leg.strike, iv: leg.iv })
      }
    }

    const smile = fitSmile(points, spot, expiry.dte)
    if (smile) smiles.push(smile)
  }

  smiles.sort((a, b) => a.dte - b.dte)
  return smiles
}

// ---------------------------------------------------------------------------
// Surface quality summary (for prompt injection and logging)
// ---------------------------------------------------------------------------

/**
 * Summarises surface quality across all fitted smiles.
 * status = 'fitted' when avg R² ≥ 0.85, 'partial' when avg R² ≥ 0.50,
 * 'unavailable' when no smiles were fitted.
 */
export function getSurfaceQuality(smiles: VolSmile[]): SurfaceQuality {
  if (smiles.length === 0) {
    return { expirationsFitted: 0, avgR2: 0, status: 'unavailable' }
  }
  const avgR2 = smiles.reduce((s, v) => s + v.r2, 0) / smiles.length
  return {
    expirationsFitted: smiles.length,
    avgR2,
    status: avgR2 >= 0.85 ? 'fitted' : avgR2 >= 0.50 ? 'partial' : 'unavailable',
  }
}

/**
 * Returns the smile closest to a target DTE (in calendar days), or null.
 */
export function getClosestSmile(smiles: VolSmile[], targetDte: number): VolSmile | null {
  if (smiles.length === 0) return null
  let best = smiles[0]
  let bestDiff = Math.abs(smiles[0].dte - targetDte)
  for (const s of smiles) {
    const diff = Math.abs(s.dte - targetDte)
    if (diff < bestDiff) {
      bestDiff = diff
      best = s
    }
  }
  return best
}

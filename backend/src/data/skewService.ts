/**
 * skewService — calcula Risk Reversal 25-delta, Put Skew Slope e IV Ratio ATM
 * por bucket de DTE a partir da option chain em memória.
 *
 * Valores em pontos percentuais (ex: -3.0 = put IV 3% acima de call IV).
 * Chamado pelo skewPoller a cada 60s (mercado aberto) / 5min (fora).
 */

import type { OptionExpiry, OptionLeg } from './optionChain'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SkewEntry {
  expiration: string
  dte: number
  /** IV(put 25d) − IV(call 25d), em %pts. Negativo = put skew normal. */
  riskReversal25: number
  /** IV(put 25d) − IV(put 10d), em %pts. Mede inclinação da asa esquerda. */
  putSkewSlope: number
  /** IV ATM (50-delta put/call), em %. */
  ivAtm: number
  /** iv_put_25d / iv_atm. >1 = puts caras relative ao ATM. */
  ivAtmSkewRatio: number
  /** Classificação qualitativa do skew. */
  skewLabel: 'steep' | 'normal' | 'flat' | 'inverted'
  capturedAt: string
}

export interface SkewByDTE {
  dte0:  SkewEntry | null   // 0DTE (today, ≤ 2 DTE)
  dte7:  SkewEntry | null   // ~7D (3–14 DTE)
  dte21: SkewEntry | null   // ~21D (14–35 DTE)
  dte45: SkewEntry | null   // ~45D (≥ 35 DTE)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the leg with |abs(delta)| closest to targetAbsDelta. */
function findClosestDelta(legs: OptionLeg[], targetAbsDelta: number): OptionLeg | null {
  let best: OptionLeg | null = null
  let bestDist = Infinity
  for (const leg of legs) {
    if (leg.iv == null || leg.iv <= 0 || leg.delta == null) continue
    const dist = Math.abs(Math.abs(leg.delta) - targetAbsDelta)
    if (dist < bestDist) {
      bestDist = dist
      best = leg
    }
  }
  return best
}

function skewLabel(rr25: number): SkewEntry['skewLabel'] {
  if (rr25 < -2.5) return 'steep'
  if (rr25 < -0.5) return 'normal'
  if (rr25 < 0)    return 'flat'
  return 'inverted'
}

/** Selects the OptionExpiry closest to a target DTE, within the given range [minDte, maxDte]. */
function selectExpiry(
  chain: OptionExpiry[],
  targetDte: number,
  minDte: number,
  maxDte: number,
): OptionExpiry | null {
  const candidates = chain.filter((e) => e.dte >= minDte && e.dte <= maxDte)
  if (candidates.length === 0) return null
  return candidates.reduce((best, cur) =>
    Math.abs(cur.dte - targetDte) < Math.abs(best.dte - targetDte) ? cur : best,
  )
}

/** Computes a SkewEntry for a given expiry, or null if data insufficient. */
function computeSkewEntry(expiry: OptionExpiry): SkewEntry | null {
  const validPuts  = expiry.puts.filter((l)  => l.iv != null && l.iv > 0 && l.delta != null)
  const validCalls = expiry.calls.filter((l) => l.iv != null && l.iv > 0 && l.delta != null)

  if (validPuts.length < 5 || validCalls.length < 5) return null

  const put25d  = findClosestDelta(validPuts,  0.25)
  const call25d = findClosestDelta(validCalls, 0.25)
  const put10d  = findClosestDelta(validPuts,  0.10)
  const atmPut  = findClosestDelta(validPuts,  0.50)
  const atmCall = findClosestDelta(validCalls, 0.50)

  // Require put25d and call25d; put10d optional (slope may be null)
  if (!put25d || !call25d) return null

  const ivPut25  = put25d.iv!
  const ivCall25 = call25d.iv!
  const ivPut10  = put10d?.iv ?? null
  const ivAtmRaw = (atmPut?.iv ?? atmCall?.iv) ?? null

  if (ivAtmRaw == null || ivAtmRaw <= 0) return null

  const rr25     = (ivPut25 - ivCall25) * 100              // %pts
  const slope    = ivPut10 != null ? (ivPut25 - ivPut10) * 100 : 0  // %pts (0 if 10d unavailable)
  const ivAtmPct = ivAtmRaw * 100                          // %
  const ratio    = parseFloat((ivPut25 / ivAtmRaw).toFixed(3))

  return {
    expiration: expiry.expirationDate,
    dte: expiry.dte,
    riskReversal25: parseFloat(rr25.toFixed(2)),
    putSkewSlope: parseFloat(slope.toFixed(2)),
    ivAtm: parseFloat(ivAtmPct.toFixed(2)),
    ivAtmSkewRatio: ratio,
    skewLabel: skewLabel(rr25),
    capturedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function calculateSkewByDTE(chain: OptionExpiry[]): SkewByDTE {
  const exp0  = selectExpiry(chain,  0,  0,  2)
  const exp7  = selectExpiry(chain,  7,  3, 14)
  const exp21 = selectExpiry(chain, 21, 14, 35)
  const exp45 = selectExpiry(chain, 45, 35, 90)

  return {
    dte0:  exp0  ? computeSkewEntry(exp0)  : null,
    dte7:  exp7  ? computeSkewEntry(exp7)  : null,
    dte21: exp21 ? computeSkewEntry(exp21) : null,
    dte45: exp45 ? computeSkewEntry(exp45) : null,
  }
}

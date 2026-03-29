// backend/src/lib/volMetrics.ts
// Pure functions for institutional volatility metrics (no I/O, no side effects).

/**
 * IV Risk Premium: measures how much implied vol exceeds realized vol.
 * IRP = ivAtm - hv30
 * Both params in percentage points (e.g., 22.4 for 22.4%).
 * Returns null if either param is null, undefined, NaN, or not finite.
 */
export function calculateIRP(
  ivAtm: number | null,
  hv30: number | null
): number | null {
  if (
    ivAtm == null || hv30 == null ||
    !isFinite(ivAtm) || !isFinite(hv30) ||
    isNaN(ivAtm) || isNaN(hv30)
  ) {
    return null;
  }
  return ivAtm - hv30;
}

/**
 * 25-Delta Risk Reversal: measures skew between OTM puts and calls.
 * RR25 = avgPutIV(25Δ) - avgCallIV(25Δ)
 * Negative values indicate put skew (typical for equities).
 * Returns null if fewer than 2 valid calls or puts in the 25Δ band.
 */
export function calculateRR25(
  options: Array<{
    option_type: string;
    greeks?: { delta?: number | null; smv_vol?: number | null };
  }>
): number | null {
  const callIVs: number[] = [];
  const putIVs: number[] = [];

  for (const opt of options) {
    const delta = opt.greeks?.delta;
    const smvVol = opt.greeks?.smv_vol;

    if (
      delta == null || !isFinite(delta) || isNaN(delta) ||
      smvVol == null || !isFinite(smvVol) || isNaN(smvVol) || smvVol === 0
    ) {
      continue;
    }

    const iv = smvVol * 100;

    if (opt.option_type === 'call') {
      if (delta >= 0.20 && delta <= 0.30) {
        callIVs.push(iv);
      }
    } else if (opt.option_type === 'put') {
      if (Math.abs(delta) >= 0.20 && Math.abs(delta) <= 0.30) {
        putIVs.push(iv);
      }
    }
  }

  if (callIVs.length < 2 || putIVs.length < 2) {
    return null;
  }

  const avgCallIV = callIVs.reduce((sum, v) => sum + v, 0) / callIVs.length;
  const avgPutIV = putIVs.reduce((sum, v) => sum + v, 0) / putIVs.length;

  return Math.round((avgPutIV - avgCallIV) * 10) / 10;
}

/**
 * Term Structure Slope: ratio of long-term to short-term IV minus 1.
 * TSS = (ivLongTerm / ivShortTerm) - 1
 * Returns decimal (e.g., 0.031 = +3.1% contango, -0.024 = backwardation).
 * Returns null if either param is invalid or ivShortTerm <= 0.
 */
export function calculateTSS(
  ivShortTerm: number | null,
  ivLongTerm: number | null
): number | null {
  if (
    ivShortTerm == null || ivLongTerm == null ||
    !isFinite(ivShortTerm) || !isFinite(ivLongTerm) ||
    isNaN(ivShortTerm) || isNaN(ivLongTerm) ||
    ivShortTerm <= 0
  ) {
    return null;
  }
  return (ivLongTerm / ivShortTerm) - 1;
}

/**
 * Realized Volatility Percentile: where current HV5 sits vs. the past windowDays.
 * Uses population stddev; returns percentile 0–100 (integer).
 * Returns null if closes array is too short (< windowDays + 5).
 */
export function calculateRVP(
  closes: number[],
  windowDays: number = 90
): number | null {
  if (closes.length < windowDays + 5) {
    return null;
  }

  // Compute log returns
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }

  // Helper: population stddev of a 5-element slice
  function hv5FromSlice(slice: number[]): number {
    const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length;
    return Math.sqrt(variance) * Math.sqrt(252) * 100;
  }

  // Current HV5 from the last 5 log returns
  const currentHV5 = hv5FromSlice(logReturns.slice(-5));

  // Historical HV5 values: windowDays windows ending at positions -(windowDays+4) through -5
  // i.e., we compute HV5 for each window of the last windowDays + 4 log returns, excluding the final 5
  const historicalHV5s: number[] = [];
  const histStart = logReturns.length - windowDays - 4;
  for (let i = histStart + 4; i < logReturns.length - 5 + 1; i++) {
    historicalHV5s.push(hv5FromSlice(logReturns.slice(i - 4, i + 1)));
  }

  if (historicalHV5s.length === 0) {
    return null;
  }

  const countBelow = historicalHV5s.filter((v) => v < currentHV5).length;
  const percentile = (countBelow / historicalHV5s.length) * 100;

  return Math.round(percentile);
}

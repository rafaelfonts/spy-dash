// backend/src/lib/technicalCalcs.ts
// Pure calculation functions extracted from technicalIndicatorsPoller.ts.
// No side effects, no imports from project modules.
// IMPORTANT: calcRSI uses Wilder's smoothing (two-phase), NOT simple moving average.

/**
 * RSI com suavização de Wilder (EMA fator 1/period).
 * Requer prices.length >= period*2 para warm-up correto.
 * Retorna 50 (neutro) quando série é muito curta ou completamente flat.
 */
export function calcRSI(prices: number[], period = 14): number {
  if (prices.length < period * 2) return 50

  // Fase 1: semente via média simples dos primeiros `period` deltas
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1]
    if (diff > 0) avgGain += diff
    else avgLoss += Math.abs(diff)
  }
  avgGain /= period
  avgLoss /= period

  // Fase 2: EMA de Wilder para o restante da série
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period
  }

  if (avgGain === 0 && avgLoss === 0) return 50  // flat market → neutral
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

export function calcEMA(prices: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const ema: number[] = [prices[0]]
  for (let i = 1; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[i - 1] * (1 - k))
  }
  return ema
}

export function calcMACD(prices: number[]): {
  value: number; signal: number; histogram: number
  crossover: 'bullish' | 'bearish' | 'none'
} | null {
  if (prices.length < 35) return null
  const ema12 = calcEMA(prices, 12)
  const ema26 = calcEMA(prices, 26)
  const macdLine = ema12.map((v, i) => v - ema26[i])
  // Use the FULL macdLine for the signal EMA — NOT just the last 9 elements
  const signalLine = calcEMA(macdLine, 9)
  const macdVal = macdLine[macdLine.length - 1]
  const signalVal = signalLine[signalLine.length - 1]
  const histNow = macdVal - signalVal
  const histPrev = macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2]
  const crossover: 'bullish' | 'bearish' | 'none' =
    histPrev <= 0 && histNow > 0 ? 'bullish'
    : histPrev >= 0 && histNow < 0 ? 'bearish'
    : 'none'
  return { value: macdVal, signal: signalVal, histogram: histNow, crossover }
}

/**
 * Returns null when stdDev === 0 (flat prices — e.g. market closed).
 * Returns { upper, middle, lower, percentB, bandwidth } — note: NO `position` field.
 * Callers that need TechnicalData['bbands'] (which has position) must build it separately.
 */
export function calcBBands(prices: number[], period = 20): {
  upper: number; middle: number; lower: number
  percentB: number | null; bandwidth: number | null
} | null {
  const slice = prices.slice(-period)
  if (slice.length < period) return null
  const middle = slice.reduce((a, b) => a + b, 0) / period
  const variance = slice.reduce((acc, p) => acc + (p - middle) ** 2, 0) / period
  const stdDev = Math.sqrt(variance)
  if (stdDev === 0) return null
  const upper = middle + 2 * stdDev
  const lower = middle - 2 * stdDev
  const lastPrice = prices[prices.length - 1]
  const percentB = (lastPrice - lower) / (upper - lower)
  const bandwidth = (upper - lower) / middle
  return { upper, middle, lower, percentB, bandwidth }
}

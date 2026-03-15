// backend/src/lib/equityTechnicals.ts
import { calcRSI, calcMACD, calcBBands } from './technicalCalcs.js'
import type { EquityTechnicals } from '../types/market.js'

export interface TradierBar {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export function computeEquityTechnicals(bars: TradierBar[]): EquityTechnicals {
  const prices = bars.map((b) => b.close)

  // RSI — requires 28+ bars for Wilder warm-up (period*2)
  const rsiRaw = prices.length >= 28 ? calcRSI(prices, 14) : null
  const rsiZone: EquityTechnicals['rsiZone'] =
    rsiRaw == null ? 'neutral'
    : rsiRaw < 30 ? 'oversold'
    : rsiRaw > 70 ? 'overbought'
    : 'neutral'

  // MACD — requires 35+ bars
  const macdResult = prices.length >= 35 ? calcMACD(prices) : null
  const macdCross: EquityTechnicals['macdCross'] =
    macdResult?.crossover === 'bullish' ? 'bullish'
    : macdResult?.crossover === 'bearish' ? 'bearish'
    : 'none'
  const macd = macdResult
    ? { value: macdResult.value, signal: macdResult.signal, histogram: macdResult.histogram }
    : null

  // BBands — requires 20+ bars
  const bbResult = prices.length >= 20 ? calcBBands(prices, 20) : null
  const bb = bbResult
    ? { upper: bbResult.upper, middle: bbResult.middle, lower: bbResult.lower }
    : null

  // VWAP intraday (typical price * volume)
  let vwap: number | null = null
  const totalVolume = bars.reduce((s, b) => s + b.volume, 0)
  if (totalVolume > 0) {
    const pvSum = bars.reduce((s, b) => s + (b.high + b.low + b.close) / 3 * b.volume, 0)
    vwap = pvSum / totalVolume
  }

  // Trend: compare avg of last 10 closes vs prior 10
  let trend: EquityTechnicals['trend'] = 'sideways'
  if (prices.length >= 20) {
    const recent = prices.slice(-10).reduce((s, p) => s + p, 0) / 10
    const earlier = prices.slice(-20, -10).reduce((s, p) => s + p, 0) / 10
    const pctDiff = (recent - earlier) / earlier
    if (pctDiff > 0.002) trend = 'uptrend'
    else if (pctDiff < -0.002) trend = 'downtrend'
  }

  console.log(
    `[equityTechnicals] RSI=${rsiRaw?.toFixed(1) ?? 'N/A'} MACD=${macdCross} BB=%B=${bbResult?.percentB?.toFixed(2) ?? 'N/A'} trend=${trend}`
  )

  return {
    rsi: rsiRaw,
    rsiZone,
    macd,
    macdCross,
    bb,
    bbPercentB: bbResult?.percentB ?? null,
    bbBandwidth: bbResult?.bandwidth ?? null,
    vwap,
    trend,
  }
}

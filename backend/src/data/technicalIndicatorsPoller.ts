/**
 * technicalIndicatorsPoller — calculates RSI, MACD and Bollinger Bands locally
 * from marketState.spy.priceHistory (390 1-minute bars from Tradier).
 *
 * No external API dependency. Runs every 2 minutes.
 * Requires at least 35 prices for MACD to be reliable. Publishes dataStatus='waiting'
 * with barsAvailable count when priceHistory is insufficient, so the frontend can show
 * an inactivity indicator instead of stale or false-default values.
 */

import { marketState } from './marketState'
import { publishTechnicalData } from './technicalIndicatorsState'
import type { TechnicalData } from './technicalIndicatorsState'
import { buildIVConeSnapshot } from './ivConeService'

// ---------------------------------------------------------------------------
// Pure calculation helpers
// ---------------------------------------------------------------------------

function calcRSI(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50
  let gains = 0
  let losses = 0
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1]
    if (diff > 0) gains += diff
    else losses += Math.abs(diff)
  }
  const avgGain = gains / period
  const avgLoss = losses / period
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

function calcEMA(prices: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const ema: number[] = [prices[0]]
  for (let i = 1; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[i - 1] * (1 - k))
  }
  return ema
}

function calcMACD(prices: number[]): TechnicalData['macd'] {
  if (prices.length < 35) {
    return { macd: 0, signal: 0, histogram: 0, crossover: 'none' }
  }
  const ema12 = calcEMA(prices, 12)
  const ema26 = calcEMA(prices, 26)
  const macdLine = ema12.map((v, i) => v - ema26[i])
  const signalLine = calcEMA(macdLine, 9)
  const macd = macdLine[macdLine.length - 1]
  const signal = signalLine[signalLine.length - 1]
  const histNow = macd - signal
  const histPrev =
    macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2]
  const crossover: TechnicalData['macd']['crossover'] =
    histPrev <= 0 && histNow > 0
      ? 'bullish'
      : histPrev >= 0 && histNow < 0
        ? 'bearish'
        : 'none'
  return { macd, signal, histogram: histNow, crossover }
}

function calcBBands(prices: number[], period = 20): TechnicalData['bbands'] {
  const slice = prices.slice(-period)
  if (slice.length < period) {
    return { upper: 0, middle: 0, lower: 0, position: 'middle' }
  }
  const middle = slice.reduce((a, b) => a + b, 0) / period
  const variance = slice.reduce((acc, p) => acc + (p - middle) ** 2, 0) / period
  const stdDev = Math.sqrt(variance)
  return { upper: middle + 2 * stdDev, middle, lower: middle - 2 * stdDev, position: 'middle' }
}

// ---------------------------------------------------------------------------
// BB position helper — exported for use in openai.ts at analysis time
// ---------------------------------------------------------------------------

export function deriveBBPosition(
  spyPrice: number,
  bbands: TechnicalData['bbands'],
): TechnicalData['bbands']['position'] {
  const { upper, middle, lower } = bbands
  const upperZone = upper - (upper - middle) * 0.15
  const lowerZone = lower + (middle - lower) * 0.15
  if (spyPrice > upper) return 'above_upper'
  if (spyPrice >= upperZone) return 'near_upper'
  if (spyPrice <= lower) return 'below_lower'
  if (spyPrice <= lowerZone) return 'near_lower'
  return 'middle'
}

// ---------------------------------------------------------------------------
// Single calculation tick
// ---------------------------------------------------------------------------

function tick(): void {
  const prices = marketState.spy.priceHistory.map((pt) => pt.p)
  if (prices.length < 35) {
    publishTechnicalData({
      dataStatus: 'waiting',
      barsAvailable: prices.length,
      rsi14: 50,
      macd: { macd: 0, signal: 0, histogram: 0, crossover: 'none' },
      bbands: { upper: 0, middle: 0, lower: 0, position: 'middle' },
      capturedAt: new Date().toISOString(),
      ivCone: null,
    })
    return
  }

  const rsi14 = calcRSI(prices)
  const macd = calcMACD(prices)
  const bbands = calcBBands(prices)

  // Pre-compute BB position using current live price
  const currentPrice = marketState.spy.last
  if (currentPrice != null) {
    bbands.position = deriveBBPosition(currentPrice, bbands)
  }

  // IV Cone snapshot — piggybacking on 5-min tick (uses same priceHistory)
  const ivCone = buildIVConeSnapshot()
  if (ivCone) {
    console.log(
      `[IVCone] IVx=${ivCone.ivx ?? 'n/a'}% HV30=${ivCone.hv30 ?? 'n/a'}% ` +
      `vs_HV30=${ivCone.ivVsHv30 ?? 'n/a'}x [${ivCone.coneLabel ?? 'n/a'}]`,
    )
  }

  const data: TechnicalData = {
    rsi14,
    macd,
    bbands,
    capturedAt: new Date().toISOString(),
    ivCone: ivCone ?? null,
    dataStatus: 'ok',
    barsAvailable: prices.length,
  }

  publishTechnicalData(data)

  console.log(
    `[TechIndicators] RSI=${rsi14.toFixed(2)} ` +
      `MACD_hist=${macd.histogram.toFixed(4)} ` +
      `BB_mid=${bbands.middle.toFixed(2)}`,
  )
}

// ---------------------------------------------------------------------------
// Public start function
// ---------------------------------------------------------------------------

export function startTechnicalIndicatorsPoller(): void {
  console.log('[TechIndicators] Starting local poller (RSI/MACD/BBands from priceHistory, 2min)')

  // Try immediately; if not enough bars yet (e.g. Tradier restore still pending),
  // retry every 60s until we have ≥35 bars, then hand off to the 5-min interval.
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  function tryTick(): void {
    const count = marketState.spy.priceHistory.length
    if (count < 35) {
      console.log(`[TechIndicators] Waiting for price history (${count}/35 bars)`)
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null
          tryTick()
        }, 60_000)
      }
      return
    }
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    tick()
  }

  tryTick()
  setInterval(tick, 120_000)
}

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
import { calcRSI, calcMACD, calcBBands } from '../lib/technicalCalcs.js'

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
  // calcMACD retorna { value, signal, histogram, crossover } — adapta para TechnicalData['macd']
  const macdResult = calcMACD(prices)
  const macd: TechnicalData['macd'] = macdResult
    ? { macd: macdResult.value, signal: macdResult.signal, histogram: macdResult.histogram, crossover: macdResult.crossover }
    : { macd: 0, signal: 0, histogram: 0, crossover: 'none' }

  // resultado cru de technicalCalcs.ts (sem position, pode ser null)
  const bbResult = calcBBands(prices)
  const bbFlat = !bbResult || bbResult.upper === bbResult.lower

  // objeto TechnicalData['bbands'] exigido por publishTechnicalData (nunca null, tem position)
  const bbands: TechnicalData['bbands'] = bbResult
    ? { upper: bbResult.upper, middle: bbResult.middle, lower: bbResult.lower, position: 'middle' }
    : { upper: 0, middle: 0, lower: 0, position: 'middle' }

  // Pre-compute BB position using current live price
  const currentPrice = marketState.spy.last
  if (currentPrice != null) {
    bbands.position = deriveBBPosition(currentPrice, bbands)
  }

  // bbPercentB e bbBandwidth vêm do bbResult (não do bbands que não tem esses campos)
  const bbPercentB =
    bbFlat || currentPrice == null ? null
    : (currentPrice - bbands.lower) / (bbands.upper - bbands.lower)
  const bbBandwidth = bbFlat ? null : (bbands.upper - bbands.lower) / bbands.middle * 100

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
    bbPercentB,
    bbBandwidth,
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

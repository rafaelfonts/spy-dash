// backend/src/lib/equityDailyTechnicals.ts
import type { DailyBar, ADXResult } from '../types/market.js'

// ── SMA ──────────────────────────────────────────────────────────────────────
export function calcSMA(bars: DailyBar[], period: number): number {
  const slice = bars.slice(-period)
  if (slice.length < period) return bars[bars.length - 1]?.close ?? 0
  return slice.reduce((s, b) => s + b.close, 0) / period
}

// ── ATR (14) ─────────────────────────────────────────────────────────────────
export function calcATR(bars: DailyBar[], period = 14): number {
  if (bars.length < 2) return 0
  const trs: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high
    const l = bars[i].low
    const pc = bars[i - 1].close
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)))
  }
  const slice = trs.slice(-period)
  return slice.reduce((s, v) => s + v, 0) / slice.length
}

// ── ADX (14) ─────────────────────────────────────────────────────────────────
export function calcADX(bars: DailyBar[], period = 14): ADXResult {
  if (bars.length < period * 2 + 1) return { adx: 0, plusDI: 0, minusDI: 0 }

  const trArr: number[] = []
  const plusDMArr: number[] = []
  const minusDMArr: number[] = []

  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high
    const l = bars[i].low
    const ph = bars[i - 1].high
    const pl = bars[i - 1].low
    const pc = bars[i - 1].close

    trArr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)))

    const upMove = h - ph
    const downMove = pl - l
    plusDMArr.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDMArr.push(downMove > upMove && downMove > 0 ? downMove : 0)
  }

  // Wilder smoothing
  function wilderSmooth(arr: number[], p: number): number[] {
    const result: number[] = []
    let smooth = arr.slice(0, p).reduce((s, v) => s + v, 0)
    result.push(smooth)
    for (let i = p; i < arr.length; i++) {
      smooth = smooth - smooth / p + arr[i]
      result.push(smooth)
    }
    return result
  }

  const smoothTR = wilderSmooth(trArr, period)
  const smoothPlusDM = wilderSmooth(plusDMArr, period)
  const smoothMinusDM = wilderSmooth(minusDMArr, period)

  const dxArr: number[] = []
  for (let i = 0; i < smoothTR.length; i++) {
    if (smoothTR[i] === 0) continue
    const plusDI = (smoothPlusDM[i] / smoothTR[i]) * 100
    const minusDI = (smoothMinusDM[i] / smoothTR[i]) * 100
    const sum = plusDI + minusDI
    dxArr.push(sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100)
  }

  const adxSmooth = wilderSmooth(dxArr, period)
  const lastSmooth = adxSmooth[adxSmooth.length - 1]

  const lastTR = smoothTR[smoothTR.length - 1]
  const lastPlusDI = lastTR === 0 ? 0 : (smoothPlusDM[smoothPlusDM.length - 1] / lastTR) * 100
  const lastMinusDI = lastTR === 0 ? 0 : (smoothMinusDM[smoothMinusDM.length - 1] / lastTR) * 100

  return {
    adx: Math.round(lastSmooth * 10) / 10,
    plusDI: Math.round(lastPlusDI * 10) / 10,
    minusDI: Math.round(lastMinusDI * 10) / 10,
  }
}

// ── AVWAP ─────────────────────────────────────────────────────────────────────
// anchor: 'week' = since last Monday, 'month' = since 1st of month
export function calcAVWAP(bars: DailyBar[], anchor: 'week' | 'month'): number {
  if (bars.length === 0) return 0
  const today = new Date()
  let anchorDate: Date

  if (anchor === 'week') {
    anchorDate = new Date(today)
    const day = anchorDate.getDay() // 0=Sun, 1=Mon...
    const diff = day === 0 ? -6 : 1 - day
    anchorDate.setDate(anchorDate.getDate() + diff)
  } else {
    anchorDate = new Date(today.getFullYear(), today.getMonth(), 1)
  }

  const anchorStr = anchorDate.toISOString().slice(0, 10)
  const slice = bars.filter((b) => b.date >= anchorStr)
  if (slice.length === 0) return bars[bars.length - 1].close

  let pvSum = 0
  let volSum = 0
  for (const b of slice) {
    const typical = (b.high + b.low + b.close) / 3
    pvSum += typical * b.volume
    volSum += b.volume
  }
  return volSum === 0 ? bars[bars.length - 1].close : pvSum / volSum
}

// ── Z-Score (20D) ─────────────────────────────────────────────────────────────
export function calcZScore(bars: DailyBar[], period = 20): number {
  const slice = bars.slice(-period)
  if (slice.length < period) return 0
  const closes = slice.map((b) => b.close)
  const mean = closes.reduce((s, v) => s + v, 0) / period
  const variance = closes.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period
  const std = Math.sqrt(variance)
  if (std === 0) return 0
  return (closes[closes.length - 1] - mean) / std
}

// ── RVOL D1 ───────────────────────────────────────────────────────────────────
// Uses daily volume: today's volume vs. avg of last 20 trading days
export function calcRVOLD1(bars: DailyBar[]): number {
  if (bars.length < 2) return 1
  const history = bars.slice(-21, -1) // last 20 completed days
  if (history.length === 0) return 1
  const avgVol = history.reduce((s, b) => s + b.volume, 0) / history.length
  if (avgVol === 0) return 1
  const todayVol = bars[bars.length - 1].volume
  return Math.round((todayVol / avgVol) * 10) / 10
}

// ── MTF Alignment ─────────────────────────────────────────────────────────────
export function calcMTFAlignment(
  close: number,
  sma20: number,
  sma50: number,
  avwapWeekly: number,
  adx: ADXResult,
): 'bullish' | 'bearish' | 'neutral' {
  const aboveSMA20 = close > sma20
  const aboveSMA50 = close > sma50
  const aboveAVWAP = close > avwapWeekly
  const trendingUp = adx.plusDI > adx.minusDI && adx.adx > 20
  const bullCount = [aboveSMA20, aboveSMA50, aboveAVWAP, trendingUp].filter(Boolean).length
  if (bullCount >= 3) return 'bullish'
  if (bullCount <= 1) return 'bearish'
  return 'neutral'
}

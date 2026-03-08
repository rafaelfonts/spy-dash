import { emitter } from './marketState'
import type { IVConeSnapshot } from './ivConeService'

export interface TechnicalData {
  rsi14: number
  macd: {
    macd: number
    signal: number
    histogram: number
    crossover: 'bullish' | 'bearish' | 'none'
  }
  bbands: {
    upper: number
    middle: number
    lower: number
    position: 'above_upper' | 'near_upper' | 'middle' | 'near_lower' | 'below_lower'
  }
  capturedAt: string     // ISO 8601
  ivCone?: IVConeSnapshot | null
  dataStatus: 'ok' | 'waiting'   // 'waiting' when priceHistory < 35 bars
  barsAvailable: number           // actual count of priceHistory bars
}

let snapshot: TechnicalData | null = null

export function getTechnicalSnapshot(): TechnicalData | null {
  return snapshot
}

export function publishTechnicalData(data: TechnicalData): void {
  snapshot = data
  emitter.emit('technical-indicators', data)
}

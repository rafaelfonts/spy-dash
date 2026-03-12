import { emitter } from './marketState'
import type { EiaOilSnapshot } from '../types/market'

let snapshot: EiaOilSnapshot | null = null
let lastUpdatedAt = 0

export function getEiaOilSnapshot(): EiaOilSnapshot | null {
  return snapshot
}

export function getEiaOilAge(): number {
  return lastUpdatedAt
}

export function publishEiaOil(payload: EiaOilSnapshot): void {
  snapshot = payload
  lastUpdatedAt = Date.now()
  emitter.emit('eia_oil', payload)
}


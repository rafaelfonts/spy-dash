import { emitter } from './marketState'
import type { FinraDarkPoolSnapshot } from '../types/market'

let snapshot: FinraDarkPoolSnapshot | null = null
let lastUpdatedAt = 0

export function getFinraDarkPoolSnapshot(): FinraDarkPoolSnapshot | null {
  return snapshot
}

export function getFinraDarkPoolAge(): number {
  return lastUpdatedAt
}

export function publishFinraDarkPool(payload: FinraDarkPoolSnapshot): void {
  snapshot = payload
  lastUpdatedAt = Date.now()
  emitter.emit('finra_darkpool', payload)
}


import { emitter } from './marketState'
import type { CftcCotSnapshot } from '../types/market'

let snapshot: CftcCotSnapshot | null = null
let lastUpdatedAt = 0

export function getCftcCotSnapshot(): CftcCotSnapshot | null {
  return snapshot
}

export function getCftcCotAge(): number {
  return lastUpdatedAt
}

export function publishCftcCot(payload: CftcCotSnapshot): void {
  snapshot = payload
  lastUpdatedAt = Date.now()
  emitter.emit('cftc_cot', payload)
}


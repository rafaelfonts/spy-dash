import { emitter } from './marketState'
import type { TreasuryTgaSnapshot } from '../types/market'

let snapshot: TreasuryTgaSnapshot | null = null
let lastUpdatedAt = 0

export function getTreasuryTgaSnapshot(): TreasuryTgaSnapshot | null {
  return snapshot
}

export function getTreasuryTgaAge(): number {
  return lastUpdatedAt
}

export function publishTreasuryTga(payload: TreasuryTgaSnapshot): void {
  snapshot = payload
  lastUpdatedAt = Date.now()
  emitter.emit('treasury_tga', payload)
}


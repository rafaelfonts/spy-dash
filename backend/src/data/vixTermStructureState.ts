import { emitter } from './marketState'
import type { VIXTermStructureResult } from './vixTermStructure'

export type VIXTermStructurePayload = VIXTermStructureResult

let snapshot: VIXTermStructurePayload | null = null

export function getVIXTermStructureSnapshot(): VIXTermStructurePayload | null {
  return snapshot
}

export function publishVIXTermStructure(payload: VIXTermStructurePayload): void {
  snapshot = payload
  emitter.emit('vix-term-structure', payload)
}

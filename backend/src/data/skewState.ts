/**
 * skewState — in-memory snapshot for Put Skew / Risk Reversal data.
 *
 * Updated by skewPoller; consumed by the AI analysis prompt and broadcast via SSE.
 */

import type { SkewByDTE } from './skewService'
import { emitter } from './marketState'

let snapshot: SkewByDTE | null = null

export function getSkewSnapshot(): SkewByDTE | null {
  return snapshot
}

export function publishSkew(payload: SkewByDTE): void {
  snapshot = payload
  emitter.emit('skew', payload)
}

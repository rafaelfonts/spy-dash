/**
 * skewState — in-memory snapshot for Put Skew / Risk Reversal data.
 *
 * Updated by skewPoller; consumed by the AI analysis prompt.
 * Not broadcast via SSE — only used server-side in openai.ts.
 */

import type { SkewByDTE } from './skewService'

let snapshot: SkewByDTE | null = null

export function getSkewSnapshot(): SkewByDTE | null {
  return snapshot
}

export function publishSkew(payload: SkewByDTE): void {
  snapshot = payload
}

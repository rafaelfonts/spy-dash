/**
 * expectedMoveState — in-memory snapshot for Expected Move (1σ) per expiration.
 *
 * Updated by expectedMovePoller; consumed by the AI analysis prompt.
 */

import type { ExpectedMoveEntry } from './expectedMoveService'

export interface ExpectedMoveSnapshot {
  byExpiry: Record<string, { dte: number; expectedMove: number; atmStrike: number }>
  capturedAt: number
}

let snapshot: ExpectedMoveSnapshot | null = null

export function getExpectedMoveSnapshot(): ExpectedMoveSnapshot | null {
  return snapshot
}

/**
 * Updates the snapshot with new Expected Move entries.
 * Called by expectedMovePoller after each successful fetch.
 */
export function publishExpectedMove(entries: ExpectedMoveEntry[]): void {
  const byExpiry: Record<string, { dte: number; expectedMove: number; atmStrike: number }> = {}
  for (const e of entries) {
    byExpiry[e.expirationDate] = {
      dte: e.dte,
      expectedMove: e.expectedMove,
      atmStrike: e.atmStrike,
    }
  }
  snapshot = {
    byExpiry,
    capturedAt: Date.now(),
  }
}

/**
 * bova11State — in-memory state for BOVA11 price data.
 *
 * Mirrors the marketState.spy pattern for the Brazilian market.
 * Updated by bova11Poller every 30s during market hours.
 */

export interface Bova11StateData {
  last: number | null
  bid: number | null
  ask: number | null
  changePct: number | null   // decimal (e.g. -0.012 = -1.2%)
  volume: number | null
  updatedAt: number          // Date.now() of last successful update
}

let state: Bova11StateData = {
  last: null,
  bid: null,
  ask: null,
  changePct: null,
  volume: null,
  updatedAt: 0,
}

export function updateBova11(data: Partial<Bova11StateData>): void {
  state = { ...state, ...data, updatedAt: Date.now() }
}

export function getBova11Snapshot(): Bova11StateData {
  return state
}

/** Returns true if BOVA11 data is fresh (updated within the last 2 minutes). */
export function isBova11DataFresh(): boolean {
  return state.updatedAt > 0 && Date.now() - state.updatedAt < 2 * 60_000
}

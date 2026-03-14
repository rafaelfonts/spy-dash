// backend/src/data/equityScreenerState.ts
import type { EquityCandidate, EquityScreenerPayload, ScreenerFilters } from './equityTypes.js';

export const DEFAULT_FILTERS: ScreenerFilters = {
  priceMin: 2,
  priceMax: 20,
  volumeMin: 300_000,
  rvolMin: 2.0,
  changeMin: 3.0,
};

let _candidates: EquityCandidate[] = [];
let _capturedAt = 0;
let _marketOpen = false;

export function setEquityCandidates(candidates: EquityCandidate[], marketOpen: boolean): void {
  _candidates = candidates;
  _capturedAt = Date.now();
  _marketOpen = marketOpen;
}

export function getEquityScreenerSnapshot(): EquityScreenerPayload {
  return {
    candidates: _candidates,
    filters: DEFAULT_FILTERS,
    marketOpen: _marketOpen,
    capturedAt: _capturedAt,
  };
}

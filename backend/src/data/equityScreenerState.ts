// backend/src/data/equityScreenerState.ts
import type { EquityCandidate, EquityScreenerPayload, ScreenerFilters } from './equityTypes.js';

export const DEFAULT_FILTERS: ScreenerFilters = {
  priceMin: 5,
  priceMax: null,   // sem teto — suporte a ações fracionadas
  volumeMin: 500_000,
  rvolMin: 1.5,
  changeMin: 2.0,
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

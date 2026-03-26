// backend/src/types/optionScreener.ts

import type { MaxPainResult } from '../lib/maxPainCalculator'

export type DeltaProfile = 'conservative' | 'moderate' | 'aggressive'
export type ScreenerPreset = 'flight_to_safety' | 'blue_chips' | 'broad_etfs'

export interface OptionCandidate {
  symbol: string
  price: number
  ivRank: number
  bidAskSpread: number        // ATM option bid-ask spread in $
  spreadPct: number           // (ask - bid) / midpoint, 0–1
  openInterest: number        // ATM OI
  optionVolume: number        // ATM daily volume
  underlyingVolume: number
  liquidityScore: number      // 0–100
  nearestExpiration: string   // YYYY-MM-DD
  lastUpdated: number
}

export interface OptionEvents {
  nextEarnings: string | null          // ISO date YYYY-MM-DD
  exDividendDate: string | null        // ISO date YYYY-MM-DD
  earningsWithinDTE: boolean           // earnings within selected DTE window
  exDivWithin5Days: boolean
  upcomingMacroEvents: string[]        // e.g. ["FOMC Apr 9"]
}

export interface IVSkew {
  callIV: number    // avg IV of OTM calls near ATM
  putIV: number     // avg IV of OTM puts near ATM
  skew: number      // putIV - callIV (positive = put premium)
}

export interface OptionDeepDive {
  symbol: string
  price: number
  ivRank: number
  ivPercentile: number | null
  maxPain: MaxPainResult | null
  putCallRatio: number | null
  gexRegime: 'positive' | 'negative' | null
  ivSkew: IVSkew | null
  events: OptionEvents
}

export interface OptionStrategy {
  type: 'cash_secured_put' | 'covered_call' | 'bull_put_spread' | 'bear_call_spread' | 'iron_condor' | 'long_call' | 'long_put'
  symbol: string
  strikes: number[]           // 1 for single-leg, 2 for spread
  expiration: string          // YYYY-MM-DD
  dte: number
  credit: number | null       // $ per share (×100 = per contract); null if debit strategy
  debit: number | null        // $ per share; null if credit strategy
  delta: number               // delta of primary strike (always positive, e.g. 0.28)
  popEstimate: number         // 0–1, ~= 1 - |delta|
  maxProfit: number           // $ per contract
  maxLoss: number | null      // $ per contract; null = collateral (CSP/CC)
  breakevens: number[]        // underlying prices at expiry
  rationale: string           // free text from AI
}

export interface OptionScreenerScanResult {
  candidates: OptionCandidate[]
  scannedAt: number
  totalScanned: number
  passedFilters: number
  cacheHit: boolean
  /** Set when the backend auto-adjusted the preset (e.g. no preset + market closed → broad_etfs) */
  autoPreset?: ScreenerPreset
}

export interface ScanRequest {
  preset?: ScreenerPreset
  deltaProfile?: DeltaProfile
}

export interface AnalyzeRequest {
  symbol: string
  deltaProfile: DeltaProfile
}

// Ticker universe
export const SCREENER_UNIVERSE: Record<string, string[]> = {
  defensive_etfs: ['GLD', 'TLT', 'IEF', 'SHY', 'XLU', 'XLP', 'XLV', 'AGG', 'BND', 'LQD', 'USMV', 'SPLV'],
  broad_etfs:     ['SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'VOO', 'EFA', 'EEM', 'MDY'],
  mega_caps:      ['AAPL', 'MSFT', 'AMZN', 'NVDA', 'GOOGL', 'META', 'BRK-B', 'JPM', 'JNJ', 'PG', 'V', 'WMT'],
  commodities:    ['GDX', 'SLV', 'USO', 'XLE'],
}

export const ALL_TICKERS: string[] = Object.values(SCREENER_UNIVERSE).flat()

export const PRESET_TICKERS: Record<ScreenerPreset, string[]> = {
  flight_to_safety: ['GLD', 'TLT', 'IEF', 'SHY', 'XLU', 'XLV', 'AGG', 'BND', 'LQD', 'USMV'],
  blue_chips:       ['AAPL', 'MSFT', 'AMZN', 'JPM', 'JNJ', 'PG', 'BRK-B', 'NVDA', 'GOOGL', 'V'],
  broad_etfs:       ['SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'EFA', 'EEM', 'MDY'],
}

export const PRESET_IVR_THRESHOLD: Record<ScreenerPreset, number> = {
  flight_to_safety: 35,
  blue_chips: 40,
  broad_etfs: 30,
}

export const DELTA_RANGES: Record<DeltaProfile, { min: number; max: number }> = {
  conservative: { min: 0.15, max: 0.25 },
  moderate:     { min: 0.25, max: 0.40 },
  aggressive:   { min: 0.40, max: 0.50 },
}

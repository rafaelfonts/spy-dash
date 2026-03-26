import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'

// News Feed types (mirrored from backend)
export interface MacroDataItem {
  seriesId: string
  name: string
  value: number | null
  previousValue: number | null
  date: string
  unit: string
}

export interface FearGreedData {
  score: number | null
  label: string | null
  previousClose: number | null
  lastUpdated: number
}

export interface MacroEvent {
  event: string
  time: string | null
  country: string
  impact: 'high' | 'medium' | 'low'
  actual: number | null
  estimate: number | null
  prev: number | null
  unit: string | null
}

export interface NewsHeadline {
  title: string
  description: string | null
  url: string
  source: string
  publishedAt: string
  image: string | null
}

// Pre-market / post-close briefing (mirrored from backend types/market.ts)
export interface PreMarketBriefing {
  type: 'pre-market' | 'post-close'
  generatedAt: string
  markdown: string
  expiresAt: string
}

// Last scheduled trade signal (10:30 / 15:00 ET) — from backend scheduledSignalService
export interface TradeSignalPayload {
  trade_signal: 'trade' | 'wait' | 'avoid'
  regime_score: number
  no_trade_reasons: string[]
  bias: 'bullish' | 'bearish' | 'neutral'
  key_levels: { support: number[]; resistance: number[]; gex_flip?: number }
  timestamp: number
  summary?: string
}

// Analysis structured output (mirrored from backend types/market.ts)
export interface AnalysisStructuredOutput {
  bias: 'bullish' | 'bearish' | 'neutral'
  confidence: number
  timeframe: string
  key_levels: {
    support: number[]
    resistance: number[]
    gex_flip?: number
  }
  suggested_strategy: {
    name: string
    legs: Array<{ type: 'call' | 'put'; action: 'buy' | 'sell'; strike: number; dte: number }>
    max_risk: number
    max_reward: number
    breakeven: number
  } | null
  catalysts: string[]
  risk_factors: string[]
  recommended_dte: number | null
  pop_estimate: number | null
  supporting_gex_dte: string | null
  invalidation_level: number | null
  expected_credit: number | null
  theta_per_day: number | null
  trade_signal: 'trade' | 'wait' | 'avoid'
  no_trade_reasons: string[]
  regime_score: number
  data_quality_warning: string | null
  vanna_regime: 'tailwind' | 'neutral' | 'headwind'
  charm_pressure: 'significant' | 'moderate' | 'neutral'
  price_distribution: {
    p10: number; p25: number; p50: number; p75: number; p90: number
    expected_range_1sigma: string
  } | null
  gex_vs_yesterday: 'stronger_positive' | 'weaker_positive' | 'unchanged' | 'weaker_negative' | 'stronger_negative' | null
}

// IV Cone type (mirrored from backend ivConeService.IVConeSnapshot)
export interface IVConeData {
  hv10:  number | null
  hv20:  number | null
  hv30:  number | null
  hv60:  number | null
  ivx:   number | null
  ivVsHv10:  number | null
  ivVsHv20:  number | null
  ivVsHv30:  number | null
  ivVsHv60:  number | null
  coneLabel: 'rich' | 'fair' | 'cheap' | null
  capturedAt: string
}

// Technical Indicators type (mirrored from backend technicalIndicatorsState)
export interface TechnicalIndicatorsData {
  rsi14: number
  macd: {
    macd: number
    signal: number
    histogram: number
    crossover: 'bullish' | 'bearish' | 'none'
  }
  bbands: {
    upper: number
    middle: number
    lower: number
    position: 'above_upper' | 'near_upper' | 'middle' | 'near_lower' | 'below_lower'
  }
  bbPercentB?: number | null
  bbBandwidth?: number | null
  capturedAt: string
  ivCone?: IVConeData | null
  dataStatus?: 'ok' | 'waiting'
  barsAvailable?: number
}

// VIX Term Structure type (mirrored from backend vixTermStructure)
export interface VIXTermStructureData {
  spot: number
  curve: Array<{ dte: number; iv: number }>
  structure: 'contango' | 'backwardation' | 'flat' | 'humped'
  steepness: number
  midTermIV?: number | null
  curvature?: number | null
  vix1dProxy?: number | null
  vix1dRatio?: number | null
  capturedAt: string
  lastUpdated: number
}

export interface PutCallRatioEntry {
  tier: '0DTE' | 'Semanal' | 'Mensal'
  expiration: string
  ratio: number
  putVolume: number
  callVolume: number
  sentimentLabel: 'bearish' | 'neutral' | 'bullish'
}

export interface PutCallRatioMulti {
  entries: PutCallRatioEntry[]
  lastUpdated: number
}

// GEX types (mirrored from backend gexCalculator)
export interface StrikeGEX {
  strike: number
  callGEX: number
  putGEX: number
  netGEX: number
  callOI: number
  putOI: number
}

export interface MaxPainData {
  maxPainStrike: number
  distanceFromSpot: number
  distancePct: number
  pinRisk: 'high' | 'moderate' | 'low'
}

export interface GEXProfile {
  byStrike: StrikeGEX[]
  totalGEX: number
  flipPoint: number | null
  zeroGammaLevel: number | null
  maxGammaStrike: number
  minGammaStrike: number
  callWall: number
  putWall: number
  regime: 'positive' | 'negative'
  calculatedAt: string
  totalVannaExposure?: number  // VEX $M (dealers' delta sensitivity to IV)
  totalCharmExposure?: number  // CEX $M/day (dealers' delta decay per day)
  volatilityTrigger?: number   // VT: GEX-weighted avg of 3 strikes nearest flipPoint
  maxPain?: MaxPainData | null  // strike where MM payout is minimized
}

// Dynamic GEX entry (mirrored from backend gexService.GEXExpirationEntry)
export interface GEXExpirationEntry {
  expiration: string        // YYYY-MM-DD
  dte: number               // days to expiry (0 = today)
  isMonthlyOPEX: boolean    // 3rd Friday of the month
  isWeeklyOPEX: boolean     // any Friday
  label: string             // e.g. "MAR-14 (7D) OPEX" or "0DTE"
  gex: GEXProfile           // GEX data for this expiration
  gammaAnomaly: number      // |netGamma| normalised 0–1 across all selected expirations
}

// Option chain types (mirrored from backend OptionLeg/OptionExpiry)
export interface OptionChainMeta {
  capturedAt: string
  capturedAtPrice: number
  currentPrice: number | null
  priceDelta: string
  cacheHit: boolean
}

export interface OptionLeg {
  symbol: string
  strike: number
  bid: number | null
  ask: number | null
  volume: number | null
  openInterest: number | null
  iv: number | null
  delta: number | null
  gamma: number | null
  theta: number | null
  vega: number | null
  greeksSource: 'api' | 'calculated' | null
}

export interface OptionExpiry {
  dte: number
  expirationDate: string
  calls: OptionLeg[]
  puts: OptionLeg[]
}

// NoTrade Score (mirrored from backend regimeScorer.NoTradeResult)
export interface NoTradeData {
  noTradeScore: number
  activeVetos: string[]
  noTradeLevel: 'clear' | 'caution' | 'avoid'
}

// Delta-Adjusted Notional (mirrored from backend danCalculator.DANResult)
export interface DANData {
  callDAN: number
  putDAN: number
  netDAN: number
  danBias: 'call_dominated' | 'put_dominated' | 'neutral'
  callDominancePct: number
}

export interface RVOLData {
  todayVolume: number
  avg20dVolume: number
  rvol: number
  rvolBias: 'accumulation' | 'distribution' | 'neutral'
  capturedAt: string
}

// Equity Screener types
export interface EquityCandidate {
  symbol: string
  price: number
  change: number
  volume: number
  rvol: number
  hasCatalyst: boolean
  lastUpdated: number
  equityScore: number   // 0–100 composite score
  isTopSetup: boolean   // true for top 3 by equityScore
}

export interface WatchlistEntry {
  id: string
  symbol: string
  alert_price: number | null
  alert_direction: 'above' | 'below' | null
}

export interface EquityTrade {
  id: string
  symbol: string
  entry_date: string
  exit_date: string | null
  entry_price: number
  exit_price: number | null
  quantity: number
  pnl: number | null
  status: 'open' | 'closed'
  notes: string | null
}

export interface AnalysisStructuredEquity {
  symbol: string
  setup: string
  entry_range: string
  target: string
  stop: string
  risk_reward: string
  confidence: 'ALTA' | 'MÉDIA' | 'BAIXA'
  warning: string | null
  equity_regime_score: number
  rsi_zone: 'oversold' | 'neutral' | 'overbought'
  trend: 'uptrend' | 'downtrend' | 'sideways'
  catalyst_confirmed: boolean
  timeframe: '1d' | '2d' | '3-5d'
  invalidation_level: number | null
  key_levels: { support: number[]; resistance: number[] }
  trade_signal: 'trade' | 'wait' | 'avoid'
  no_trade_reasons: string[]
}

export interface EquityScreenerPayload {
  candidates: EquityCandidate[]
  marketOpen: boolean
  capturedAt: number
}

// --- Option Screener types ---
export interface OptionCandidateFE {
  symbol: string
  price: number
  ivRank: number
  bidAskSpread: number
  spreadPct: number
  openInterest: number
  optionVolume: number
  underlyingVolume: number
  liquidityScore: number
  nearestExpiration: string
  lastUpdated: number
}

export type DeltaProfileFE = 'conservative' | 'moderate' | 'aggressive'
export type ScreenerPresetFE = 'flight_to_safety' | 'blue_chips' | 'broad_etfs'
export type ScreenerStatus = 'idle' | 'scanning' | 'results' | 'analyzing' | 'streaming' | 'error'

export interface OptionEventsFE {
  nextEarnings: string | null
  exDividendDate: string | null
  earningsWithinDTE: boolean
  exDivWithin5Days: boolean
  upcomingMacroEvents: string[]
}

export interface IVSkewFE {
  callIV: number
  putIV: number
  skew: number
}

export interface MaxPainFE {
  maxPainStrike: number
  distanceFromSpot: number
  distancePct: number
  pinRisk: 'high' | 'moderate' | 'low'
}

export interface OptionDeepDiveFE {
  symbol: string
  price: number
  ivRank: number
  ivPercentile: number | null
  maxPain: MaxPainFE | null
  putCallRatio: number | null
  gexRegime: 'positive' | 'negative' | null
  ivSkew: IVSkewFE | null
  events: OptionEventsFE
}

export interface OptionStrategyFE {
  type: string
  symbol: string
  strikes: number[]
  expiration: string
  dte: number
  credit: number | null
  debit: number | null
  delta: number
  popEstimate: number
  maxProfit: number
  maxLoss: number | null
  breakevens: number[]
  rationale: string
}

export interface OptionScanMetaFE {
  scannedAt: number
  totalScanned: number
  passedFilters: number
  autoPreset?: ScreenerPresetFE
}

export interface OptionScreenerState {
  status: ScreenerStatus
  candidates: OptionCandidateFE[]
  selectedSymbol: string | null
  deepDive: OptionDeepDiveFE | null
  strategy: OptionStrategyFE | null
  strategyTokens: string
  scanMeta: OptionScanMetaFE | null
  error: string | null
  activePreset: ScreenerPresetFE | null
  deltaProfile: DeltaProfileFE
}

// Live regime preview — computed every SSE tick, available before first AI analysis
export interface RegimePreviewData {
  score: number
  vannaRegime: 'tailwind' | 'neutral' | 'headwind'
  charmPressure: 'significant' | 'moderate' | 'neutral'
  gexVsYesterday: 'stronger_positive' | 'weaker_positive' | 'unchanged' | 'weaker_negative' | 'stronger_negative' | null
  priceDistribution: {
    p10: number; p25: number; p50: number; p75: number; p90: number
    expected_range_1sigma: string
  } | null
}

// Vol Skew types (mirrored from backend skewService.ts)
export interface SkewEntry {
  expiration: string
  dte: number
  riskReversal25: number     // IV(put25d) − IV(call25d), %pts
  putSkewSlope: number       // IV(put25d) − IV(put10d), %pts
  ivAtm: number              // ATM IV, %
  ivAtmSkewRatio: number     // iv_put_25d / iv_atm
  skewLabel: 'steep' | 'normal' | 'flat' | 'inverted'
  capturedAt: string
}

export interface SkewByDTE {
  dte0:  SkewEntry | null
  dte7:  SkewEntry | null
  dte21: SkewEntry | null
  dte45: SkewEntry | null
}

export interface StaleFlags {
  macro?: boolean
  bls?: boolean
  macroEvents?: boolean
  headlines?: boolean
  fearGreed?: boolean
}

export interface NewsFeedState {
  macro: MacroDataItem[]
  bls: MacroDataItem[]
  macroEvents: MacroEvent[]
  headlines: NewsHeadline[]
  fearGreed: FearGreedData | null
  lastUpdated: number
  staleFlags: StaleFlags
}

export interface SPYData {
  last: number | null
  bid: number | null
  ask: number | null
  change: number | null
  changePct: number | null
  volume: number | null
  dayHigh: number | null
  dayLow: number | null
  lastUpdated: number
}

export interface VIXData {
  last: number | null
  change: number | null
  changePct: number | null
  level: 'low' | 'moderate' | 'high' | null
  lastUpdated: number
}

export interface IVRankData {
  value: number | null
  percentile: number | null
  ivx: number | null           // Tastytrade composite IV index (absolute level, e.g. 24.8%)
  label: 'low' | 'medium' | 'high' | null
  lastUpdated: number
}

export interface AlertToast {
  id: string
  level: number
  type: 'support' | 'resistance' | 'gex_flip'
  alertType: 'approaching' | 'testing'
  price: number
  timestamp: number
}

export type WSState = 'CONNECTING' | 'OPEN' | 'RECONNECTING' | 'CLOSED'

export interface ConnectionState {
  wsState: WSState
  reconnectAttempts: number
  connected: boolean
}

interface MarketStore {
  spy: SPYData
  vix: VIXData
  ivRank: IVRankData
  connection: ConnectionState
  newsFeed: NewsFeedState
  optionChain: OptionExpiry[]
  optionChainMeta: OptionChainMeta | null
  gexProfile: GEXProfile | null
  gexDynamic: GEXExpirationEntry[] | null
  lastAnalysisOutput: AnalysisStructuredOutput | null
  putCallRatio: PutCallRatioMulti | null
  vixTermStructure: VIXTermStructureData | null
  technicalIndicators: TechnicalIndicatorsData | null
  preMarketBriefing: PreMarketBriefing | null
  lastScheduledSignal: TradeSignalPayload | null
  noTrade: NoTradeData | null
  dan: DANData | null
  rvol: RVOLData | null
  skewByDTE: SkewByDTE | null
  regimePreview: RegimePreviewData | null
  marketOpen: boolean | null  // null = SSE snapshot ainda não recebido

  updateSPY: (data: Partial<SPYData>) => void
  updateVIX: (data: Partial<VIXData>) => void
  updateIVRank: (data: Partial<IVRankData>) => void
  updateConnection: (data: Partial<ConnectionState>) => void
  updateNewsFeed: (data: Partial<NewsFeedState>) => void
  applyNewsfeedBatch: (batch: Record<string, any>) => void
  setOptionChain: (chain: OptionExpiry[]) => void
  setOptionChainMeta: (meta: OptionChainMeta) => void
  setGEXProfile: (gex: GEXProfile | null) => void
  setGEXDynamic: (data: GEXExpirationEntry[] | null) => void
  setLastAnalysisOutput: (output: AnalysisStructuredOutput | null) => void
  setPutCallRatio: (data: PutCallRatioMulti) => void
  setVIXTermStructure: (data: VIXTermStructureData | null) => void
  setTechnicalIndicators: (data: TechnicalIndicatorsData | null) => void
  setPreMarketBriefing: (data: PreMarketBriefing | null) => void
  setLastScheduledSignal: (data: TradeSignalPayload | null) => void
  setNoTrade: (data: NoTradeData | null) => void
  setDAN: (data: DANData | null) => void
  setRVOL: (data: RVOLData | null) => void
  setSkewByDTE: (data: SkewByDTE | null) => void
  setRegimePreview: (data: RegimePreviewData | null) => void
  setMarketOpen: (open: boolean) => void

  // Equity Screener state
  equityCandidates: EquityCandidate[]
  equityMarketOpen: boolean
  equityWatchlist: WatchlistEntry[]
  equityTrades: EquityTrade[]
  equityAnalysis: AnalysisStructuredEquity | null
  equityAnalysisLoading: boolean
  analyzingSymbol: string | null
  equityRegimeVetoed: boolean
  equityRegimeVetoReasons: string[]
  setEquityCandidates: (candidates: EquityCandidate[], marketOpen: boolean) => void
  setEquityRegimeVeto: (vetoed: boolean, reasons: string[]) => void
  setEquityWatchlist: (w: WatchlistEntry[]) => void
  setEquityTrades: (t: EquityTrade[]) => void
  setEquityAnalysis: (a: AnalysisStructuredEquity | null) => void
  setEquityAnalysisLoading: (v: boolean) => void
  setAnalyzingSymbol: (symbol: string | null) => void

  alerts: AlertToast[]
  addAlert: (alert: AlertToast) => void
  dismissAlert: (id: string) => void
  isDataReady: () => boolean

  // Option Screener state
  optionScreener: OptionScreenerState
  setOptionScreenerStatus: (status: ScreenerStatus) => void
  setOptionScreenerCandidates: (candidates: OptionCandidateFE[], meta: OptionScanMetaFE) => void
  setOptionScreenerSelected: (symbol: string | null) => void
  setOptionScreenerDeepDive: (deepDive: OptionDeepDiveFE | null) => void
  setOptionScreenerStrategy: (strategy: OptionStrategyFE | null) => void
  appendOptionScreenerToken: (token: string) => void
  resetOptionScreenerAnalysis: () => void
  setOptionScreenerError: (error: string | null) => void
  setOptionScreenerPreset: (preset: ScreenerPresetFE | null) => void
  setOptionScreenerDeltaProfile: (profile: DeltaProfileFE) => void
}

const initialSPY: SPYData = {
  last: null,
  bid: null,
  ask: null,
  change: null,
  changePct: null,
  volume: null,
  dayHigh: null,
  dayLow: null,
  lastUpdated: 0,
}

const initialVIX: VIXData = {
  last: null,
  change: null,
  changePct: null,
  level: null,
  lastUpdated: 0,
}

const initialIVRank: IVRankData = {
  value: null,
  percentile: null,
  ivx: null,
  label: null,
  lastUpdated: 0,
}

export const useMarketStore = create<MarketStore>()(
  subscribeWithSelector((set, get) => ({
    spy: { ...initialSPY },
    vix: { ...initialVIX },
    ivRank: { ...initialIVRank },
    connection: {
      wsState: 'CONNECTING',
      reconnectAttempts: 0,
      connected: false,
    },
    newsFeed: {
      macro: [],
      bls: [],
      macroEvents: [],
      headlines: [],
      fearGreed: null,
      lastUpdated: 0,
      staleFlags: {},
    },
    optionChain: [],
    optionChainMeta: null,
    gexProfile: null,
    gexDynamic: null,
    lastAnalysisOutput: null,
    putCallRatio: null,
    vixTermStructure: null,
    technicalIndicators: null,
    preMarketBriefing: null,
    lastScheduledSignal: null,
    noTrade: null,
    dan: null,
    rvol: null,
    skewByDTE: null,
    regimePreview: null,
    marketOpen: null,
    alerts: [],

    updateSPY: (data) =>
      set((state) => ({ spy: { ...state.spy, ...data, lastUpdated: Date.now() } })),

    updateVIX: (data) =>
      set((state) => ({ vix: { ...state.vix, ...data, lastUpdated: Date.now() } })),

    updateIVRank: (data) =>
      set((state) => ({
        ivRank: { ...state.ivRank, ...data, lastUpdated: Date.now() },
      })),

    updateConnection: (data) =>
      set((state) => ({ connection: { ...state.connection, ...data } })),

    updateNewsFeed: (data) =>
      set((state) => ({ newsFeed: { ...state.newsFeed, ...data } })),

    applyNewsfeedBatch: (batch) =>
      set((state) => ({
        newsFeed: {
          ...state.newsFeed,
          lastUpdated: Date.now(),
          ...(batch.macro           && { macro: batch.macro }),
          ...(batch.bls             && { bls: batch.bls }),
          ...(batch['macro-events'] && { macroEvents: batch['macro-events'] }),
          ...(batch.headlines       && { headlines: batch.headlines }),
          ...(batch.sentiment       && { fearGreed: batch.sentiment }),
        },
      })),

    addAlert: (alert) =>
      set((state) => ({ alerts: [alert, ...state.alerts].slice(0, 5) })),

    dismissAlert: (id) =>
      set((state) => ({ alerts: state.alerts.filter((a) => a.id !== id) })),

    setOptionChain: (chain) => set({ optionChain: chain }),
    setOptionChainMeta: (meta) => set({ optionChainMeta: meta }),
    setGEXProfile: (gex) => set({ gexProfile: gex }),
    setGEXDynamic: (data: GEXExpirationEntry[] | null) => set({ gexDynamic: data }),
    setLastAnalysisOutput: (output) => set({ lastAnalysisOutput: output }),
    setPutCallRatio: (data) => set({ putCallRatio: data }),
    setVIXTermStructure: (data) => set({ vixTermStructure: data }),
    setTechnicalIndicators: (data) => set({ technicalIndicators: data }),
    setPreMarketBriefing: (data) => set({ preMarketBriefing: data }),
    setLastScheduledSignal: (data) => set({ lastScheduledSignal: data }),
    setNoTrade: (data) => set({ noTrade: data }),
    setDAN: (data) => set({ dan: data }),
    setRVOL: (data) => set({ rvol: data }),
    setSkewByDTE: (data) => set({ skewByDTE: data }),
    setRegimePreview: (data) => set({ regimePreview: data }),
    setMarketOpen: (open) => set({ marketOpen: open }),

    // Equity Screener state
    equityCandidates: [] as EquityCandidate[],
    equityMarketOpen: false,
    equityWatchlist: [] as WatchlistEntry[],
    equityTrades: [] as EquityTrade[],
    equityAnalysis: null as AnalysisStructuredEquity | null,
    equityAnalysisLoading: false,
    analyzingSymbol: null as string | null,
    equityRegimeVetoed: false,
    equityRegimeVetoReasons: [] as string[],
    setEquityCandidates: (candidates, marketOpen) =>
      set({ equityCandidates: candidates, equityMarketOpen: marketOpen }),
    setEquityRegimeVeto: (vetoed, reasons) =>
      set({ equityRegimeVetoed: vetoed, equityRegimeVetoReasons: reasons }),
    setEquityWatchlist: (w) => set({ equityWatchlist: w }),
    setEquityTrades: (t) => set({ equityTrades: t }),
    setEquityAnalysis: (a) => set({ equityAnalysis: a }),
    setEquityAnalysisLoading: (v) => set({ equityAnalysisLoading: v }),
    setAnalyzingSymbol: (symbol) => set({ analyzingSymbol: symbol }),

    // Option Screener state
    optionScreener: {
      status: 'idle',
      candidates: [],
      selectedSymbol: null,
      deepDive: null,
      strategy: null,
      strategyTokens: '',
      scanMeta: null,
      error: null,
      activePreset: null,
      deltaProfile: 'moderate',
    },
    setOptionScreenerStatus: (status) =>
      set((s) => ({ optionScreener: { ...s.optionScreener, status } })),
    setOptionScreenerCandidates: (candidates, meta) =>
      set((s) => ({
        optionScreener: {
          ...s.optionScreener,
          candidates,
          scanMeta: meta,
          status: 'results',
          error: null,
        },
      })),
    setOptionScreenerSelected: (symbol) =>
      set((s) => ({ optionScreener: { ...s.optionScreener, selectedSymbol: symbol } })),
    setOptionScreenerDeepDive: (deepDive) =>
      set((s) => ({ optionScreener: { ...s.optionScreener, deepDive } })),
    setOptionScreenerStrategy: (strategy) =>
      set((s) => ({ optionScreener: { ...s.optionScreener, strategy, status: 'results' } })),
    appendOptionScreenerToken: (token) =>
      set((s) => ({
        optionScreener: {
          ...s.optionScreener,
          strategyTokens: s.optionScreener.strategyTokens + token,
          status: 'streaming',
        },
      })),
    resetOptionScreenerAnalysis: () =>
      set((s) => ({
        optionScreener: {
          ...s.optionScreener,
          deepDive: null,
          strategy: null,
          strategyTokens: '',
          status: s.optionScreener.candidates.length > 0 ? 'results' : 'idle',
        },
      })),
    setOptionScreenerError: (error) =>
      set((s) => ({ optionScreener: { ...s.optionScreener, error, status: 'error' } })),
    setOptionScreenerPreset: (preset) =>
      set((s) => ({ optionScreener: { ...s.optionScreener, activePreset: preset } })),
    setOptionScreenerDeltaProfile: (profile) =>
      set((s) => ({ optionScreener: { ...s.optionScreener, deltaProfile: profile } })),

    isDataReady: () => {
      return get().spy.last !== null
    },
  })),
)

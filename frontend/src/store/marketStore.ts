import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'

// News Feed types (mirrored from backend)
export interface EarningsItem {
  symbol: string
  earningsDate: string | null
  daysToEarnings: number | null
}

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
}

// VIX Term Structure type (mirrored from backend vixTermStructure)
export interface VIXTermStructureData {
  spot: number
  curve: Array<{ dte: number; iv: number }>
  structure: 'contango' | 'backwardation' | 'flat'
  steepness: number
  capturedAt: string
  lastUpdated: number
}

// Put/Call Ratio type (mirrored from backend putCallRatio)
export interface PutCallRatioData {
  ratio: number
  putVolume: number
  callVolume: number
  label: 'bearish' | 'neutral' | 'bullish'
  expiration: string
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

export interface StaleFlags {
  macro?: boolean
  bls?: boolean
  macroEvents?: boolean
  headlines?: boolean
  fearGreed?: boolean
}

export interface NewsFeedState {
  earnings: EarningsItem[]
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
  priceHistory: number[]
  lastUpdated: number
}

export interface VIXData {
  last: number | null
  change: number | null
  changePct: number | null
  level: 'low' | 'moderate' | 'high' | null
  priceHistory: number[]
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
  lastAnalysisOutput: AnalysisStructuredOutput | null
  putCallRatio: PutCallRatioData | null
  vixTermStructure: VIXTermStructureData | null

  updateSPY: (data: Partial<SPYData>) => void
  updateVIX: (data: Partial<VIXData>) => void
  updateIVRank: (data: Partial<IVRankData>) => void
  updateConnection: (data: Partial<ConnectionState>) => void
  updateNewsFeed: (data: Partial<NewsFeedState>) => void
  applyNewsfeedBatch: (batch: Record<string, any>) => void
  setOptionChain: (chain: OptionExpiry[]) => void
  setOptionChainMeta: (meta: OptionChainMeta) => void
  setGEXProfile: (gex: GEXProfile | null) => void
  setLastAnalysisOutput: (output: AnalysisStructuredOutput | null) => void
  setPutCallRatio: (data: PutCallRatioData | null) => void
  setVIXTermStructure: (data: VIXTermStructureData | null) => void
  alerts: AlertToast[]
  addAlert: (alert: AlertToast) => void
  dismissAlert: (id: string) => void
  isDataReady: () => boolean
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
  priceHistory: [],
  lastUpdated: 0,
}

const initialVIX: VIXData = {
  last: null,
  change: null,
  changePct: null,
  level: null,
  priceHistory: [],
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
      earnings: [],
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
    lastAnalysisOutput: null,
    putCallRatio: null,
    vixTermStructure: null,
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
          ...(batch.earnings        && { earnings: batch.earnings }),
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
    setLastAnalysisOutput: (output) => set({ lastAnalysisOutput: output }),
    setPutCallRatio: (data) => set({ putCallRatio: data }),
    setVIXTermStructure: (data) => set({ vixTermStructure: data }),

    isDataReady: () => {
      return get().spy.last !== null
    },
  })),
)

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
  label: 'low' | 'medium' | 'high' | null
  lastUpdated: number
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

  updateSPY: (data: Partial<SPYData>) => void
  updateVIX: (data: Partial<VIXData>) => void
  updateIVRank: (data: Partial<IVRankData>) => void
  updateConnection: (data: Partial<ConnectionState>) => void
  updateNewsFeed: (data: Partial<NewsFeedState>) => void
  applyNewsfeedBatch: (batch: Record<string, any>) => void
  setOptionChain: (chain: OptionExpiry[]) => void
  setOptionChainMeta: (meta: OptionChainMeta) => void
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

    setOptionChain: (chain) => set({ optionChain: chain }),
    setOptionChainMeta: (meta) => set({ optionChainMeta: meta }),

    isDataReady: () => {
      return get().spy.last !== null
    },
  })),
)

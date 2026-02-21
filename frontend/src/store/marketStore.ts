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

export interface NewsFeedState {
  earnings: EarningsItem[]
  macro: MacroDataItem[]
  bls: MacroDataItem[]
  macroEvents: MacroEvent[]
  headlines: NewsHeadline[]
  fearGreed: FearGreedData | null
  lastUpdated: number
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

  updateSPY: (data: Partial<SPYData>) => void
  updateVIX: (data: Partial<VIXData>) => void
  updateIVRank: (data: Partial<IVRankData>) => void
  updateConnection: (data: Partial<ConnectionState>) => void
  updateNewsFeed: (data: Partial<NewsFeedState>) => void
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
    },

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

    isDataReady: () => {
      return get().spy.last !== null
    },
  })),
)

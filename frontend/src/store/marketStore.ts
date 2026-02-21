import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'

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

  updateSPY: (data: Partial<SPYData>) => void
  updateVIX: (data: Partial<VIXData>) => void
  updateIVRank: (data: Partial<IVRankData>) => void
  updateConnection: (data: Partial<ConnectionState>) => void
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

    isDataReady: () => {
      return get().spy.last !== null
    },
  })),
)

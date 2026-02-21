import { EventEmitter } from 'events'
import type {
  MarketState,
  SPYData,
  VIXData,
  IVRankData,
  ConnectionState,
  EarningsItem,
  MacroDataItem,
  FearGreedData,
  MacroEvent,
  NewsHeadline,
} from '../types/market'

const MAX_HISTORY = 60

function vixLevel(price: number): 'low' | 'moderate' | 'high' {
  if (price < 15) return 'low'
  if (price <= 25) return 'moderate'
  return 'high'
}

function ivRankLabel(rank: number): 'low' | 'medium' | 'high' {
  if (rank < 30) return 'low'
  if (rank <= 70) return 'medium'
  return 'high'
}

export const marketState: MarketState = {
  spy: {
    last: null,
    bid: null,
    ask: null,
    open: null,
    prevClose: null,
    change: null,
    changePct: null,
    dayHigh: null,
    dayLow: null,
    volume: null,
    priceHistory: [],
    lastUpdated: 0,
  },
  vix: {
    last: null,
    change: null,
    changePct: null,
    level: null,
    priceHistory: [],
    lastUpdated: 0,
  },
  ivRank: {
    value: null,
    percentile: null,
    label: null,
    lastUpdated: 0,
  },
  connection: {
    wsState: 'CONNECTING',
    reconnectAttempts: 0,
    lastConnected: null,
  },
}

export const emitter = new EventEmitter()
emitter.setMaxListeners(200)

// In-memory snapshot of news feed data — sent to newly connected SSE clients
export const newsSnapshot: {
  earnings: EarningsItem[]
  macro: MacroDataItem[]
  bls: MacroDataItem[]
  fearGreed: FearGreedData | null
  macroEvents: MacroEvent[]
  headlines: NewsHeadline[]
} = { earnings: [], macro: [], bls: [], fearGreed: null, macroEvents: [], headlines: [] }

export function updateSPY(data: Partial<SPYData>): void {
  Object.assign(marketState.spy, data, { lastUpdated: Date.now() })

  const last = marketState.spy.last
  if (last !== null) {
    marketState.spy.priceHistory.push(last)
    if (marketState.spy.priceHistory.length > MAX_HISTORY) {
      marketState.spy.priceHistory.shift()
    }

    // Compute changePct from change and last
    const change = marketState.spy.change
    if (change !== null && last - change !== 0) {
      marketState.spy.changePct = (change / (last - change)) * 100
    }
  }

  emitter.emit('quote', {
    symbol: 'SPY',
    bid: marketState.spy.bid,
    ask: marketState.spy.ask,
    last: marketState.spy.last,
    change: marketState.spy.change,
    changePct: marketState.spy.changePct,
    volume: marketState.spy.volume,
    dayHigh: marketState.spy.dayHigh,
    dayLow: marketState.spy.dayLow,
    priceHistory: [...marketState.spy.priceHistory],
    timestamp: marketState.spy.lastUpdated,
  })
}

export function updateVIX(data: Partial<VIXData>): void {
  Object.assign(marketState.vix, data, { lastUpdated: Date.now() })

  const last = marketState.vix.last
  if (last !== null) {
    marketState.vix.level = vixLevel(last)
    marketState.vix.priceHistory.push(last)
    if (marketState.vix.priceHistory.length > MAX_HISTORY) {
      marketState.vix.priceHistory.shift()
    }

    const change = marketState.vix.change
    if (change !== null && last - change !== 0) {
      marketState.vix.changePct = (change / (last - change)) * 100
    }
  }

  emitter.emit('vix', {
    symbol: '$VIX.X',
    last: marketState.vix.last,
    change: marketState.vix.change,
    changePct: marketState.vix.changePct,
    level: marketState.vix.level,
    priceHistory: [...marketState.vix.priceHistory],
    timestamp: marketState.vix.lastUpdated,
  })
}

export function updateIVRank(data: Partial<IVRankData>): void {
  Object.assign(marketState.ivRank, data, { lastUpdated: Date.now() })

  const value = marketState.ivRank.value
  if (value !== null) {
    marketState.ivRank.label = ivRankLabel(value)
  }

  emitter.emit('ivrank', {
    ivRank: marketState.ivRank.value,
    ivPercentile: marketState.ivRank.percentile,
    label: marketState.ivRank.label,
    timestamp: marketState.ivRank.lastUpdated,
  })
}

export function updateConnection(data: Partial<ConnectionState>): void {
  Object.assign(marketState.connection, data)

  emitter.emit('status', {
    connected: marketState.connection.wsState === 'OPEN',
    wsState: marketState.connection.wsState,
    reconnectAttempts: marketState.connection.reconnectAttempts,
  })
}

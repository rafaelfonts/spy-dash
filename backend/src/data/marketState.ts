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
  PricePoint,
} from '../types/market'
import { persistPriceTick } from './priceHistory'

const MAX_HISTORY = 390  // ~6.5h de sessão (1 bar/min via Tradier restore)

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
    ivx: null,
    hv30: null,
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
  // Timestamps (ms epoch) of the last successful poll for each category
  macroTs: number
  blsTs: number
  macroEventsTs: number
  earningsTs: number
} = {
  earnings: [],
  macro: [],
  bls: [],
  fearGreed: null,
  macroEvents: [],
  headlines: [],
  macroTs: 0,
  blsTs: 0,
  macroEventsTs: 0,
  earningsTs: 0,
}

export function updateSPY(data: Partial<SPYData>): void {
  Object.assign(marketState.spy, data, { lastUpdated: Date.now() })

  // Only push to priceHistory when this update explicitly carries a new last price
  // (i.e. a Trade event). Bid/ask-only Quote updates must not duplicate the same
  // price into history on every tick — especially critical on weekends when the feed
  // is alive but no new trades occur.
  if ('last' in data && data.last != null) {
    const last = data.last
    const pt: PricePoint = { t: Date.now(), p: last }
    marketState.spy.priceHistory.push(pt)
    if (marketState.spy.priceHistory.length > MAX_HISTORY) {
      marketState.spy.priceHistory.shift()
    }

    // Compute changePct from change and last
    const change = marketState.spy.change
    if (change !== null && last - change !== 0) {
      marketState.spy.changePct = (change / (last - change)) * 100
    }

    persistPriceTick('SPY', {
      price: last,
      bid: marketState.spy.bid,
      ask: marketState.spy.ask,
      volume: marketState.spy.volume,
    })
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

  // Same guard as updateSPY: only record a new history point when a real
  // Trade price arrives, not on every ancillary update.
  if ('last' in data && data.last != null) {
    const last = data.last
    marketState.vix.level = vixLevel(last)
    const pt: PricePoint = { t: Date.now(), p: last }
    marketState.vix.priceHistory.push(pt)
    if (marketState.vix.priceHistory.length > MAX_HISTORY) {
      marketState.vix.priceHistory.shift()
    }

    const change = marketState.vix.change
    if (change !== null && last - change !== 0) {
      marketState.vix.changePct = (change / (last - change)) * 100
    }

    persistPriceTick('VIX', {
      price: last,
      bid: null,
      ask: null,
      volume: null,
    })
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
    ivx: marketState.ivRank.ivx,
    hv30: marketState.ivRank.hv30,
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

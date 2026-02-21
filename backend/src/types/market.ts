export interface SPYData {
  last: number | null
  bid: number | null
  ask: number | null
  open: number | null
  prevClose: number | null
  change: number | null
  changePct: number | null
  dayHigh: number | null
  dayLow: number | null
  volume: number | null
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

export interface ConnectionState {
  wsState: 'CONNECTING' | 'OPEN' | 'RECONNECTING' | 'CLOSED'
  reconnectAttempts: number
  lastConnected: number | null
}

export interface MarketState {
  spy: SPYData
  vix: VIXData
  ivRank: IVRankData
  connection: ConnectionState
}

export interface SSEClient {
  id: string
  write: (event: string, data: unknown) => void
}

// News Feed types

export interface EarningsItem {
  symbol: string
  earningsDate: string | null   // 'YYYY-MM-DD'
  daysToEarnings: number | null
}

export interface MacroDataItem {
  seriesId: string
  name: string
  value: number | null
  previousValue: number | null
  date: string                  // 'YYYY-MM-DD' of latest observation
  unit: string
}

export interface FearGreedData {
  score: number | null          // 0–100
  label: string | null
  previousClose: number | null
  lastUpdated: number
}

export interface MacroEvent {
  event: string
  time: string | null             // 'YYYY-MM-DD HH:MM:SS' UTC from Finnhub
  country: string
  impact: 'high' | 'medium' | 'low'
  actual: number | null           // null if not yet released
  estimate: number | null
  prev: number | null
  unit: string | null
}

export interface NewsHeadline {
  title: string
  description: string | null
  url: string
  source: string
  publishedAt: string             // ISO 8601
  image: string | null
}

export interface NewsFeedEvent {
  type: 'earnings' | 'macro' | 'bls' | 'sentiment' | 'macro-events' | 'headlines'
  items?: EarningsItem[] | MacroDataItem[] | MacroEvent[] | NewsHeadline[]
  fearGreed?: FearGreedData
  ts: number
}

export interface QuoteEvent {
  symbol: string
  bid: number | null
  ask: number | null
  last: number | null
  change: number | null
  changePct: number | null
  volume: number | null
  dayHigh: number | null
  dayLow: number | null
  priceHistory: number[]
  timestamp: number
}

export interface VIXEvent {
  symbol: string
  last: number | null
  change: number | null
  changePct: number | null
  level: 'low' | 'moderate' | 'high' | null
  priceHistory: number[]
  timestamp: number
}

export interface IVRankEvent {
  ivRank: number | null
  ivPercentile: number | null
  label: 'low' | 'medium' | 'high' | null
  timestamp: number
}

export interface StatusEvent {
  connected: boolean
  wsState: string
  reconnectAttempts: number
}

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

export interface PricePoint {
  t: number   // epoch ms timestamp
  p: number   // price
}

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
  priceHistory: PricePoint[]
  lastUpdated: number
}

export interface VIXData {
  last: number | null
  change: number | null
  changePct: number | null
  level: 'low' | 'moderate' | 'high' | null
  priceHistory: PricePoint[]
  lastUpdated: number
}

export interface IVRankData {
  value: number | null
  percentile: number | null
  ivx: number | null           // Tastytrade composite IV index (absolute level, e.g. 24.8%)
  hv30: number | null          // Historical Volatility 30-day (e.g. 18.5%)
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
  userId: string
  connectedAt: number
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
  _stale?: true  // present only when data comes from cache fallback (API unavailable or schema mismatch)
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
  priceHistory: PricePoint[]
  timestamp: number
}

export interface VIXEvent {
  symbol: string
  last: number | null
  change: number | null
  changePct: number | null
  level: 'low' | 'moderate' | 'high' | null
  priceHistory: PricePoint[]
  timestamp: number
}

export interface IVRankEvent {
  ivRank: number | null
  ivPercentile: number | null
  ivx: number | null
  hv30: number | null
  label: 'low' | 'medium' | 'high' | null
  timestamp: number
}

export interface StatusEvent {
  connected: boolean
  wsState: string
  reconnectAttempts: number
}

// =============================================================================
// Zod schemas — referência viva do formato esperado de cada API externa
// =============================================================================
import { z } from 'zod'

// CNN Fear & Greed — https://production.dataviz.cnn.io/index/fearandgreed/graphdata
export const FearGreedApiSchema = z.object({
  fear_and_greed: z.object({
    score: z.number().min(0).max(100),
    rating: z.string(),
    previous_close: z.number().optional(),
    timestamp: z.string().optional(),
  }),
})
export type FearGreedApiResponse = z.infer<typeof FearGreedApiSchema>

// GNews — https://gnews.io/api/v4/search
export const GNewsResponseSchema = z.object({
  articles: z
    .array(
      z.object({
        title: z.string().optional(),
        description: z.string().nullable().optional(),
        url: z.string().optional(),
        image: z.string().nullable().optional(),
        publishedAt: z.string().optional(),
        source: z.object({ name: z.string().optional() }).optional(),
      }),
    )
    .optional(),
})
export type GNewsApiResponse = z.infer<typeof GNewsResponseSchema>

// Finnhub Economic Calendar — https://finnhub.io/api/v1/calendar/economic
export const FinnhubCalendarSchema = z.object({
  economicCalendar: z
    .array(
      z.object({
        event: z.string().optional(),
        time: z.string().optional(),
        country: z.string().optional(),
        impact: z.string().optional(),
        actual: z.number().nullable().optional(),
        estimate: z.number().nullable().optional(),
        prev: z.number().nullable().optional(),
        unit: z.string().nullable().optional(),
      }),
    )
    .optional(),
})
export type FinnhubCalendarApiResponse = z.infer<typeof FinnhubCalendarSchema>

// FRED Series Observations — https://api.stlouisfed.org/fred/series/observations
export const FredObservationSchema = z.object({
  date: z.string(),
  value: z.string(),
})
export const FredResponseSchema = z.object({
  observations: z.array(FredObservationSchema),
})
export type FredApiResponse = z.infer<typeof FredResponseSchema>

// BLS Timeseries — https://api.bls.gov/publicAPI/v2/timeseries/data/
export const BlsObservationSchema = z.object({
  year: z.string(),
  period: z.string(),
  value: z.string(),
  footnotes: z.array(z.unknown()),
})
export const BlsResponseSchema = z.object({
  status: z.string(),
  Results: z
    .object({
      series: z.array(
        z.object({
          seriesID: z.string(),
          data: z.array(BlsObservationSchema),
        }),
      ),
    })
    .optional(),
  message: z.array(z.string()).optional(),
})
export type BlsApiResponse = z.infer<typeof BlsResponseSchema>

export interface AnalysisStructuredOutput {
  bias: 'bullish' | 'bearish' | 'neutral'
  confidence: number           // 0.0 to 1.0
  timeframe: string            // '0DTE' | 'intraday' | 'swing'
  key_levels: {
    support: number[]          // up to 3, sorted desc
    resistance: number[]       // up to 3, sorted asc
    gex_flip?: number
  }
  suggested_strategy: {
    name: string
    legs: Array<{
      type: 'call' | 'put'
      action: 'buy' | 'sell'
      strike: number
      dte: number
    }>
    max_risk: number
    max_reward: number
    breakeven: number
  } | null
  catalysts: string[]
  risk_factors: string[]
}

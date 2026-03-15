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

/** High-impact macro event in the option's DTE window (for risk-review payload). */
export interface BinaryRiskEvent {
  date: string                    // YYYY-MM-DD
  event: string
  impact: 'HIGH'
}

export type NewsSentiment = 'bullish' | 'bearish' | 'neutral'

export interface NewsHeadline {
  title: string
  description: string | null
  url: string
  source: string
  publishedAt: string             // ISO 8601
  image: string | null
  /** Filled by gpt-4o-mini preprocessing pipeline (newsAggregator). */
  sentiment?: NewsSentiment
  /** One-line summary (max ~15 words) from gpt-4o-mini. */
  summary?: string
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
// Macro / Fluxo institucional extra — CFTC COT, Treasury, EIA, Dark Pool
// =============================================================================

export interface CftcCotRecord {
  /** Data da posição (terça-feira da semana de referência) em YYYY-MM-DD. */
  asOfDate: string
  /** Mercado subjacente, ex: 'E-MINI S&P 500', 'VIX FUTURES'. */
  marketName: string
  /** Categoria agregada, ex: 'Leveraged Funds', 'Asset Manager/Institutional'. */
  traderCategory: string
  /** Posições líquidas em contratos (long − short). */
  netContracts: number | null
  /** Percentil histórico da posição líquida (0–100) quando disponível. */
  netPercentile?: number | null
}

export interface CftcCotSnapshot {
  fetchedAt: string            // ISO 8601
  weekOf: string               // YYYY-MM-DD (semana de referência)
  /** Registros relevantes para SPX / VIX já filtrados. */
  records: CftcCotRecord[]
}

/** Treasury General Account — saldo de caixa e variação diária. */
export interface TreasuryTgaSnapshot {
  asOfDate: string             // YYYY-MM-DD
  openingBalance: number | null
  closingBalance: number | null
  /** closingBalance − openingBalance (variação do dia). */
  delta: number | null
  fetchedAt: string            // ISO 8601
}

/** Estoques de petróleo/gasolina da EIA — visão compacta para briefing macro. */
export interface EiaOilSnapshot {
  asOfDate: string             // YYYY-MM-DD da última semana disponível
  crudeInventories: number | null
  gasolineInventories: number | null
  /** Variação semanal de estoques de petróleo, em milhões de barris, se disponível. */
  crudeChange: number | null
  fetchedAt: string            // ISO 8601
}

/** Volume agregado em dark pools (FINRA ATS) para SPY. */
export interface FinraDarkPoolSnapshot {
  weekOf: string               // YYYY-MM-DD (segunda-feira da semana de referência)
  totalVolume: number | null   // volume total negociado em ATS (shares)
  offExchangePct: number | null // % do volume total de SPY que ocorreu off-exchange
  venueCount: number | null
  fetchedAt: string            // ISO 8601
}

// =============================================================================
// SEC EDGAR — 8-K / 13F (apenas backend/IA, não exposto via SSE)
// =============================================================================

export interface SecFilingBase {
  cik: string                  // CIK zero-padded (10 dígitos)
  symbol?: string              // ticker, quando disponível
  formType: string             // ex: '8-K', '13F-HR'
  filedAt: string              // ISO 8601
  accession: string            // accession number da filing
  title?: string
}

export interface Sec8KEvent extends SecFilingBase {
  itemNumbers?: string[]       // itens 8-K relevantes, ex: ['2.02', '7.01']
  isEarningsRelated?: boolean
  isGuidanceRelated?: boolean
}

export interface Sec13FPositionSummary {
  managerName: string
  cik: string
  reportDate: string           // YYYY-MM-DD
  spyExposureUsd: number | null
  spyShares: number | null
  changeVsPrev?: 'increase' | 'decrease' | 'new' | 'closed' | 'flat'
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

export interface PreMarketBriefing {
  type: 'pre-market' | 'post-close'
  generatedAt: string   // ISO string
  markdown: string
  expiresAt: string     // ISO string — 10:30 ET (pré) ou 06:00 ET próximo dia (pós)
}

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
  recommended_dte: number | null        // DTE recomendado para a estratégia principal
  pop_estimate: number | null           // Probability of Profit 0–1 (via delta)
  supporting_gex_dte: string | null     // bucket DTE do GEX que embasa a recomendação (ex: "21D")
  invalidation_level: number | null     // preço de invalidação do trade
  expected_credit: number | null        // crédito esperado $ por contrato
  theta_per_day: number | null          // theta/dia estimado
  /** Sinal executável: trade = condições alinhadas; wait = 1 veto; avoid = 2+ vetos ou ambiente adverso */
  trade_signal: 'trade' | 'wait' | 'avoid'
  /** Razões quantitativas quando trade_signal !== 'trade' */
  no_trade_reasons: string[]
  /** Score 0-10 dos critérios favoráveis; <4 = avoid, 4-6 = wait, 7-10 = trade (pré-computado pelo backend) */
  regime_score: number
  /** Preenchido quando ≥2 fontes com Confiança BAIXA */
  data_quality_warning: string | null
  /** Regime de Vanna Exposure dos dealers em relação ao VIX */
  vanna_regime: 'tailwind' | 'neutral' | 'headwind'
  /** Pressão de Charm Exposure (decaimento delta por tempo) */
  charm_pressure: 'significant' | 'moderate' | 'neutral'
  /** Distribuição de preços baseada no Expected Move ~21D */
  price_distribution: {
    p10: number; p25: number; p50: number; p75: number; p90: number
    expected_range_1sigma: string
  } | null
  /** Comparação do GEX total de hoje vs ontem */
  gex_vs_yesterday: 'stronger_positive' | 'weaker_positive' | 'unchanged' | 'weaker_negative' | 'stronger_negative' | null
}

// =============================================================================
// Multi-Expiration Put/Call Ratio
// =============================================================================

export interface PutCallRatioEntry {
  tier: '0DTE' | 'Semanal' | 'Mensal'
  expiration: string // YYYY-MM-DD
  ratio: number
  putVolume: number
  callVolume: number
  sentimentLabel: 'bearish' | 'neutral' | 'bullish'
}

export interface PutCallRatioMulti {
  entries: PutCallRatioEntry[]
  lastUpdated: number
}

// ---------- Equity Analysis ----------

export interface EquityTechnicals {
  rsi: number | null
  rsiZone: 'oversold' | 'neutral' | 'overbought'
  macd: { value: number; signal: number; histogram: number } | null
  macdCross: 'bullish' | 'bearish' | 'none'
  bb: { upper: number; middle: number; lower: number } | null
  bbPercentB: number | null
  bbBandwidth: number | null
  vwap: number | null
  trend: 'uptrend' | 'downtrend' | 'sideways'
}

export interface EquityRegimeComponents {
  rsi: number        // 0–2
  macd: number       // 0–2
  bb: number         // 0–2
  catalyst: number   // 0–2
  spyAlignment: number // 0–2
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
  // Quantitative additions
  equity_regime_score: number             // 0–10, integer
  rsi_zone: 'oversold' | 'neutral' | 'overbought'
  trend: 'uptrend' | 'downtrend' | 'sideways'
  catalyst_confirmed: boolean
  timeframe: '1d' | '2d' | '3-5d'
  invalidation_level: number | null
  key_levels: { support: number[]; resistance: number[] }
  trade_signal: 'trade' | 'wait' | 'avoid'
  no_trade_reasons: string[]
}

export interface EquityUniverse {
  tickers: string[]
  generatedAt: string   // ISO timestamp
  seedCount: number
  aiCount: number
}

export interface EquityCandidate {
  symbol: string
  price: number
  change: number        // % variação no dia
  volume: number
  rvol: number          // quote.volume / quote.average_volume
  hasCatalyst: boolean  // notícia Finnhub no dia
  lastUpdated: number   // epoch ms
  equityScore: number   // 0–100 composite score
  isTopSetup: boolean   // true for top 3 by equityScore
  alignment?: 'bullish' | 'bearish' | 'neutral'
  adx?: number
  zScore?: number
}

export interface ScreenerFilters {
  priceMin: number        // padrão: 5
  priceMax: number | null // padrão: null (sem teto — suporte a ações fracionadas)
  volumeMin: number       // padrão: 500_000
  rvolMin: number         // padrão: 1.5
  changeMin: number       // padrão: 2.0
}

export interface EquityScreenerPayload {
  candidates: EquityCandidate[]
  filters: ScreenerFilters
  marketOpen: boolean
  capturedAt: number    // epoch ms
  regimeVetoed?: boolean   // true quando SPY noTradeLevel = 'avoid'
  regimeVetoReasons?: string[]
  equityRegime?: import('../types/market.js').EquityRegimeState | null
}

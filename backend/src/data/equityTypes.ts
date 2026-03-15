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
}

export interface ScreenerFilters {
  priceMin: number      // padrão: 2
  priceMax: number      // padrão: 20
  volumeMin: number     // padrão: 300_000
  rvolMin: number       // padrão: 2.0
  changeMin: number     // padrão: 3.0
}

export interface EquityScreenerPayload {
  candidates: EquityCandidate[]
  filters: ScreenerFilters
  marketOpen: boolean
  capturedAt: number    // epoch ms
}

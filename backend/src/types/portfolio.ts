/**
 * Types for portfolio positions and lifecycle agent (Motor de Gestão de Ciclo de Vida).
 */

export type PositionStatus = 'OPEN' | 'CLOSED'

export interface PortfolioPositionRow {
  id: string
  symbol: string
  strategy_type: string
  open_date: string
  expiration_date: string
  short_strike: number
  long_strike: number
  short_option_symbol: string
  long_option_symbol: string
  credit_received: number
  status: PositionStatus
  comments?: string
  created_at?: string
}

export interface EnrichedPosition {
  id: string
  strategy: string
  dte_current: number
  profit_percentage: number
  profit_loss_dollars: number
  credit_received: number
  current_cost_to_close: number
  comments?: string
}

export interface PortfolioPayload {
  positions: EnrichedPosition[]
}

export interface GestorRiscoAlert {
  position_id?: string
  recommendation: 'FECHAR_LUCRO' | 'FECHAR_TEMPO' | 'ROLAR' | 'MANTER'
  message: string
}

export interface GestorRiscoResponse {
  alerts: GestorRiscoAlert[]
}

// ---------------------------------------------------------------------------
// Greeks & VaR — per-position and portfolio-level aggregates
// ---------------------------------------------------------------------------

export interface SpreadGreeks {
  positionId: string
  strategy: string
  netDelta: number      // signed (positive = long delta for put spread seller)
  netGamma: number      // negative for short spread
  netTheta: number      // $ per day (positive = collect decay)
  netVega: number       // $ per 1% IV change (negative for short spread)
  netVanna: number
  netCharm: number
  maxRisk: number       // (spread_width - credit_received) × 100 in $
  breakeven: number     // short_strike - credit_per_share for put spread
}

export interface PortfolioGreeks {
  totalDelta: number
  totalGamma: number
  totalTheta: number    // daily $ theta across all positions
  totalVega: number
  positions: SpreadGreeks[]
  varScenarios: {
    oneStdDown: number  // portfolio P&L if SPY = p25 (1σ down)
    twoStdDown: number  // portfolio P&L if SPY = p10 (2σ down, ~VaR 90%)
    oneStdUp: number    // portfolio P&L if SPY = p75
    twoStdUp: number    // portfolio P&L if SPY = p90
  }
  spy: number           // SPY spot used for the computation
  capturedAt: string
}

/** Payload for creating a new portfolio position (POST /api/portfolio/positions). */
export interface InsertPositionPayload {
  symbol: string
  strategy_type?: string
  open_date?: string
  expiration_date: string
  short_strike: number
  long_strike: number
  short_option_symbol: string
  long_option_symbol: string
  credit_received: number
  comments?: string
}

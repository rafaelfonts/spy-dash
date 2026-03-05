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
  created_at?: string
}

export interface EnrichedPosition {
  id: string
  strategy: string
  dte_current: number
  profit_percentage: number
  credit_received: number
  current_cost_to_close: number
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
}

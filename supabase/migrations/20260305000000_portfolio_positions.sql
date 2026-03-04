-- =============================================================================
-- Migration: portfolio_positions — Motor de Gestão de Ciclo de Vida (Put Spreads)
-- Date: 2026-03-05
-- =============================================================================

-- Enum for position status
CREATE TYPE position_status AS ENUM ('OPEN', 'CLOSED');

-- Table: portfolio_positions
CREATE TABLE portfolio_positions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol             TEXT NOT NULL,
  strategy_type      TEXT NOT NULL,
  open_date          TIMESTAMPTZ NOT NULL,
  expiration_date    DATE NOT NULL,
  short_strike       DOUBLE PRECISION NOT NULL,
  long_strike        DOUBLE PRECISION NOT NULL,
  short_option_symbol TEXT NOT NULL,
  long_option_symbol  TEXT NOT NULL,
  credit_received    DOUBLE PRECISION NOT NULL,
  status             position_status NOT NULL DEFAULT 'OPEN',
  created_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_portfolio_positions_status ON portfolio_positions(status);

-- RLS: backend only (service role). No policies for authenticated/anon.
ALTER TABLE portfolio_positions ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- Migration: signal_outcomes — Backtesting de Sinais Agendados
-- Date: 2026-03-11
-- =============================================================================
-- Stores one row per scheduled signal (10:30 ET, 15:00 ET) with market context
-- at signal time + outcome filled by fillOutcome() at 16:30 ET.
-- win_rate and regime calibration queries run against this table.
-- =============================================================================

CREATE TABLE signal_outcomes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Signal identification
  signal_date          DATE NOT NULL,          -- ET date YYYY-MM-DD
  slot                 TEXT NOT NULL,          -- '10:30' | '15:00'

  -- AI decision at signal time
  trade_signal         TEXT NOT NULL,          -- 'trade' | 'wait' | 'avoid'
  regime_score         INTEGER NOT NULL,       -- 0–10
  no_trade_score       INTEGER,                -- sum of active veto weights
  bias                 TEXT,                   -- 'bullish' | 'bearish' | 'neutral'
  suggested_strategy   JSONB,                  -- AnalysisStructuredOutput.suggested_strategy
  key_levels           JSONB,                  -- {support, resistance, gex_flip}
  no_trade_reasons     JSONB,                  -- string[]

  -- Market context at signal time
  spy_price_at_signal  DOUBLE PRECISION,       -- SPY last price
  vix_at_signal        DOUBLE PRECISION,       -- VIX last
  ivr_at_signal        DOUBLE PRECISION,       -- IV Rank 0–100
  gex_total_at_signal  DOUBLE PRECISION,       -- net GEX all-DTE in $M

  -- Outcome (filled at 16:30 ET by fillSignalOutcome())
  spy_close            DOUBLE PRECISION,       -- SPY EOD close
  spy_change_pct       DOUBLE PRECISION,       -- (close - signal_price) / signal_price × 100
  put_spread_pnl       DOUBLE PRECISION,       -- hypothetical P&L in $ per contract (null if no trade signal)
  outcome              TEXT,                   -- 'profit' | 'loss' | 'neutral' | 'pending'

  created_at           TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX idx_signal_outcomes_date       ON signal_outcomes(signal_date DESC);
CREATE INDEX idx_signal_outcomes_trade      ON signal_outcomes(trade_signal, outcome);
CREATE INDEX idx_signal_outcomes_regime     ON signal_outcomes(regime_score, outcome);

-- Unique constraint: one row per slot per day
CREATE UNIQUE INDEX idx_signal_outcomes_slot ON signal_outcomes(signal_date, slot);

-- RLS: backend-only via service role key (no user-level policies needed)
ALTER TABLE signal_outcomes ENABLE ROW LEVEL SECURITY;

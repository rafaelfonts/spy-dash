-- =============================================================================
-- Migration: regime_classifications — Deterministic Composite Regime History
-- Date: 2026-03-22
-- =============================================================================
-- Stores one row per poller tick (~1/min during market hours) with:
--   - composite_score (0–100): weighted blend of 6 volatility indicators
--   - regime_label: LOW_VOL / NORMAL / ELEVATED / HIGH_VOL
--   - all input fields for reproducibility and backtesting
--   - component scores (0–100 each) for component-level attribution
--   - optional pgvector feature array for historical similarity search
--
-- Storage estimate: ~390 rows/day × 252 trading days = ~98K rows/year ≈ 20MB
--   → trivial on Supabase free tier (500MB).
--
-- Key queries this enables:
--   - Win rate by regime: WHERE regime_label = 'LOW_VOL' AND captured_at BETWEEN ...
--   - Regime transitions: ORDER BY captured_at to detect label changes
--   - Similar historical periods: ORDER BY features <=> '[0.3,0.2,...]'::vector LIMIT 5
--
-- Note: pgvector must be enabled (migration 20260228000001_pgvector_search.sql).
-- =============================================================================

-- pgvector extension already enabled in 20260228000001_pgvector_search.sql
-- No need to re-create.

CREATE TABLE IF NOT EXISTS regime_classifications (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Timestamp — rounded to the nearest minute (natural dedup key)
  captured_at      TIMESTAMPTZ NOT NULL,

  -- Composite regime classification
  regime_label     TEXT NOT NULL
                     CHECK (regime_label IN ('LOW_VOL', 'NORMAL', 'ELEVATED', 'HIGH_VOL')),
  composite_score  REAL NOT NULL,   -- 0–100 (higher = more volatile/risky)
  method           TEXT NOT NULL DEFAULT 'rule-based'
                     CHECK (method IN ('rule-based', 'kmeans', 'hmm')),
  confidence       REAL,            -- 0–1

  -- Raw inputs (for full reproducibility of the composite score)
  vix              REAL,
  iv_rank          REAL,
  iv_percentile    REAL,
  iv_hv_spread     REAL,            -- IVx% − HV30% in percentage points
  vix_term_slope   REAL,            -- term structure steepness % (+ = contango)
  gex_sign         TEXT CHECK (gex_sign IN ('positive', 'negative', 'unknown')),
  put_call_ratio   REAL,

  -- Per-component sub-scores (0–100 each, before weighting)
  comp_vix         REAL,
  comp_term_slope  REAL,
  comp_iv_rank     REAL,
  comp_iv_percentile REAL,
  comp_gex         REAL,
  comp_pcr         REAL,

  -- pgvector feature array for historical similarity search (Phase 3+)
  -- 6 normalized dimensions: [vix, term_slope, iv_rank, iv_pct, gex, pcr] each 0–1
  features         vector(6),

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Primary time-series access pattern
CREATE INDEX IF NOT EXISTS idx_regime_captured_at
  ON regime_classifications (captured_at DESC);

-- Backtesting: filter by regime label within a date range
CREATE INDEX IF NOT EXISTS idx_regime_label_time
  ON regime_classifications (regime_label, captured_at DESC);

-- Composite score histogram / performance attribution
CREATE INDEX IF NOT EXISTS idx_regime_score
  ON regime_classifications (composite_score, captured_at DESC);

-- pgvector HNSW index for similarity search (find historically similar conditions)
-- m=8, ef_construction=32 (smaller than ai_analyses since vectors are 6-dim, not 1536)
CREATE INDEX IF NOT EXISTS idx_regime_features_hnsw
  ON regime_classifications
  USING hnsw (features vector_cosine_ops)
  WITH (m = 8, ef_construction = 32);

-- ---------------------------------------------------------------------------
-- RPC: find historically similar regime conditions
-- Usage: SELECT * FROM search_similar_regimes('[0.3,0.2,0.6,0.7,0.4,0.5]'::vector, 0.9, 10);
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION search_similar_regimes(
  query_features   vector(6),
  similarity_threshold FLOAT DEFAULT 0.85,
  match_count      INT     DEFAULT 10
)
RETURNS TABLE (
  id               UUID,
  captured_at      TIMESTAMPTZ,
  regime_label     TEXT,
  composite_score  REAL,
  confidence       REAL,
  vix              REAL,
  iv_rank          REAL,
  iv_hv_spread     REAL,
  vix_term_slope   REAL,
  gex_sign         TEXT,
  similarity       FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    rc.id,
    rc.captured_at,
    rc.regime_label,
    rc.composite_score,
    rc.confidence,
    rc.vix,
    rc.iv_rank,
    rc.iv_hv_spread,
    rc.vix_term_slope,
    rc.gex_sign,
    1 - (rc.features <=> query_features) AS similarity
  FROM regime_classifications rc
  WHERE
    rc.features IS NOT NULL
    AND 1 - (rc.features <=> query_features) >= similarity_threshold
  ORDER BY rc.features <=> query_features
  LIMIT match_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security (follow project pattern from 20260228000000_enable_rls.sql)
-- regime_classifications is backend-only — no user-scoped RLS needed.
-- Service role key bypasses RLS automatically.
-- ---------------------------------------------------------------------------

ALTER TABLE regime_classifications ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (used by backend)
CREATE POLICY "Service role full access"
  ON regime_classifications
  FOR ALL
  USING (true)
  WITH CHECK (true);

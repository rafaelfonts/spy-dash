-- =============================================================================
-- Migration: regime_classifications — Add K-means columns (Phase 3)
-- Date: 2026-03-22
-- =============================================================================
-- Adds K-means validation fields to regime_classifications table.
-- These columns are populated alongside composite_score every poller tick.
--
-- Key insight: when kmeans_label disagrees with the rule-based composite_label,
-- transition_detected = true — the highest-risk scenario for premium sellers.
-- =============================================================================

-- K-means regime label assigned to this tick's cluster (after VIX-ordering mapping)
ALTER TABLE regime_classifications
  ADD COLUMN IF NOT EXISTS kmeans_label TEXT
    CHECK (kmeans_label IN ('low', 'medium', 'high'));

-- True when K-means label disagrees with rule-based composite tier (in/out of transition)
ALTER TABLE regime_classifications
  ADD COLUMN IF NOT EXISTS transition_detected BOOLEAN DEFAULT false;

-- Number of points in the rolling buffer at classification time (data quality indicator)
ALTER TABLE regime_classifications
  ADD COLUMN IF NOT EXISTS kmeans_buffer_size INTEGER;

-- Whether K-means algorithm converged within maxIterations
ALTER TABLE regime_classifications
  ADD COLUMN IF NOT EXISTS kmeans_converged BOOLEAN;

-- ---------------------------------------------------------------------------
-- Index for backtesting: transition periods vs stable regimes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_regime_transition
  ON regime_classifications (transition_detected, captured_at DESC)
  WHERE transition_detected = true;

-- ---------------------------------------------------------------------------
-- Index for K-means label performance attribution
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_regime_kmeans_label
  ON regime_classifications (kmeans_label, captured_at DESC)
  WHERE kmeans_label IS NOT NULL;

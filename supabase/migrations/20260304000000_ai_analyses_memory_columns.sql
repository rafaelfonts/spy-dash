-- =============================================================================
-- Migration: Add memory-optimization columns to ai_analyses
-- Date: 2026-03-04
-- Phase 2 Enhancement: compact_summary, analysis_date, is_archived, analysis_session_id
-- =============================================================================

-- Requer ~61 MB para criação dos índices; default maintenance_work_mem pode ser 32 MB
SET LOCAL maintenance_work_mem = '64MB';

ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS analysis_date DATE DEFAULT CURRENT_DATE;
ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE;
ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS compact_summary TEXT;
ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS analysis_session_id UUID DEFAULT gen_random_uuid();

-- Indexes for performance (buildMemoryBlock, prune_old_analyses)
CREATE INDEX IF NOT EXISTS idx_ai_analyses_user_date ON ai_analyses(user_id, analysis_date DESC);
CREATE INDEX IF NOT EXISTS idx_ai_analyses_session ON ai_analyses(analysis_session_id);

-- Backfill analysis_date from created_at for existing rows
UPDATE ai_analyses
SET analysis_date = (created_at AT TIME ZONE 'UTC')::date;

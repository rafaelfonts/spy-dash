-- =============================================================================
-- Migration: Prune old analyses — retention policy
-- Date: 2026-03-04
-- Policy: Keep last 7 days full; 1 per day for 8-30 days; archive older; null full_text after 90 days
-- =============================================================================

CREATE OR REPLACE FUNCTION prune_old_analyses() RETURNS void AS $$
BEGIN
  -- Archive analyses older than 7 days that are not "representative of the day"
  -- (keep 1 per day per user for last 30 days — the one with highest confidence)
  UPDATE ai_analyses
  SET is_archived = TRUE
  WHERE
    analysis_date < CURRENT_DATE - INTERVAL '7 days'
    AND is_archived = FALSE
    AND id NOT IN (
      SELECT DISTINCT ON (analysis_date, user_id) id
      FROM ai_analyses
      WHERE analysis_date >= CURRENT_DATE - INTERVAL '30 days'
      ORDER BY analysis_date, user_id, (structured_output->>'confidence')::float DESC NULLS LAST
    );

  -- Free space: clear full_text for archived rows older than 90 days (keep metadata)
  UPDATE ai_analyses
  SET full_text = NULL
  WHERE
    is_archived = TRUE
    AND analysis_date < CURRENT_DATE - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

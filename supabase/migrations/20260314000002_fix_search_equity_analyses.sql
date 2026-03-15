-- supabase/migrations/20260314000002_fix_search_equity_analyses.sql
-- Recreate search_equity_analyses with:
--   1. LANGUAGE sql STABLE (consistent with search_historical_analyses pattern)
--   2. SET search_path = public, extensions, pg_temp (prevents schema injection)
--   3. extensions.vector(1536) qualified type (extension is in extensions schema)
-- Reference: 20260305000001_fix_security_lints.sql pattern for search_historical_analyses

SET search_path TO public, extensions;

CREATE OR REPLACE FUNCTION public.search_equity_analyses(
  query_embedding      extensions.vector(1536),
  p_user_id            UUID,
  p_symbol             TEXT,
  similarity_threshold FLOAT DEFAULT 0.5,
  match_count          INT   DEFAULT 5
)
RETURNS TABLE (
  id          UUID,
  summary     TEXT,
  similarity  FLOAT,
  created_at  TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT
    ea.id,
    ea.summary,
    1 - (ea.embedding <=> query_embedding) AS similarity,
    ea.created_at
  FROM equity_analyses ea
  WHERE ea.user_id = p_user_id
    AND ea.symbol  = p_symbol
    AND 1 - (ea.embedding <=> query_embedding) >= similarity_threshold
  ORDER BY ea.embedding <=> query_embedding
  LIMIT match_count;
$$;

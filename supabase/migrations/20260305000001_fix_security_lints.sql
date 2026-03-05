-- =============================================================================
-- Migration: Fix Supabase security lints
-- Date: 2026-03-05
--
-- Fixes:
-- 1. RLS Enabled No Policy — disable RLS on market_cache and portfolio_positions
-- 2. Function Search Path Mutable — set search_path on search_historical_analyses and prune_old_analyses
-- 3. Extension in Public — move vector extension to schema extensions
-- 4. Materialized View in API — revoke direct access, add SECURITY DEFINER RPC get_price_sparkline
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. RLS Enabled No Policy
-- Add policies and keep RLS enabled (Supabase recommends RLS on public tables).
-- market_cache: SELECT for authenticated. portfolio_positions: CRUD for authenticated (no user_id column).
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS public.market_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.portfolio_positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "market_cache_select_authenticated"
  ON public.market_cache FOR SELECT TO authenticated USING (true);

CREATE POLICY "portfolio_positions_select_authenticated"
  ON public.portfolio_positions FOR SELECT TO authenticated USING (true);
CREATE POLICY "portfolio_positions_insert_authenticated"
  ON public.portfolio_positions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "portfolio_positions_update_authenticated"
  ON public.portfolio_positions FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "portfolio_positions_delete_authenticated"
  ON public.portfolio_positions FOR DELETE TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- 2. Extension in Public — move vector to dedicated schema
-- Must run before recreating functions that use vector type.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS extensions;
ALTER EXTENSION vector SET SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- 3. Function Search Path Mutable
-- Recreate functions with SET search_path to prevent schema injection.
-- search_historical_analyses uses vector type → include extensions in path.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.search_historical_analyses(
  query_embedding      extensions.vector(1536),
  similarity_threshold float   DEFAULT 0.7,
  match_count          int     DEFAULT 5,
  p_user_id            text    DEFAULT NULL
)
RETURNS TABLE (
  id                uuid,
  user_id           text,
  summary           text,
  bias              text,
  market_snapshot   jsonb,
  structured_output jsonb,
  created_at        timestamptz,
  similarity        float
)
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT
    id,
    user_id,
    summary,
    bias,
    market_snapshot,
    structured_output,
    created_at,
    1 - (embedding <=> query_embedding) AS similarity
  FROM ai_analyses
  WHERE
    (p_user_id IS NULL OR user_id = p_user_id)
    AND 1 - (embedding <=> query_embedding) >= similarity_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION public.prune_old_analyses()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
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

  UPDATE ai_analyses
  SET full_text = NULL
  WHERE
    is_archived = TRUE
    AND analysis_date < CURRENT_DATE - INTERVAL '90 days';
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Materialized View in API
-- Revoke direct access; expose via SECURITY DEFINER RPC only.
-- ---------------------------------------------------------------------------

REVOKE ALL ON TABLE public.price_sparkline FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_price_sparkline(
  p_symbol  text,
  p_since   timestamptz,
  p_limit   int          DEFAULT 60,
  p_before  timestamptz   DEFAULT NULL
)
RETURNS TABLE (
  minute    timestamptz,
  price_avg numeric,
  price_low numeric,
  price_high numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    ps.minute,
    ps.price_avg,
    ps.price_low,
    ps.price_high
  FROM public.price_sparkline ps
  WHERE
    ps.symbol = upper(nullif(trim(p_symbol), ''))
    AND ps.minute >= p_since
    AND (p_before IS NULL OR ps.minute < p_before)
  ORDER BY ps.minute ASC
  LIMIT greatest(1, least(coalesce(p_limit, 60), 1440));
$$;

GRANT EXECUTE ON FUNCTION public.get_price_sparkline(text, timestamptz, int, timestamptz) TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFICATION (run manually after applying)
-- ---------------------------------------------------------------------------
-- SELECT tablename, rowsecurity FROM pg_tables WHERE tablename IN ('market_cache', 'portfolio_positions');
-- SELECT proname, prosecdef, proconfig FROM pg_proc WHERE proname IN ('search_historical_analyses', 'prune_old_analyses', 'get_price_sparkline');
-- SELECT extname, nspname FROM pg_extension e JOIN pg_namespace n ON e.extnamespace = n.oid WHERE extname = 'vector';
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name = 'price_sparkline' AND grantee IN ('anon', 'authenticated');
-- SELECT * FROM get_price_sparkline('SPY', now() - interval '1 hour', 60, NULL);

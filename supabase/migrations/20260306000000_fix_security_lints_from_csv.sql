-- =============================================================================
-- Migration: Fix security lints from Supabase CSV (Performance/Security Lints)
-- Date: 2026-03-06
--
-- Addresses:
-- - function_search_path_mutable (search_historical_analyses, prune_old_analyses)
-- - extension_in_public (vector → extensions schema)
-- - materialized_view_in_api (price_sparkline → RPC get_price_sparkline)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Extension in Public — move vector to dedicated schema
-- Must run before recreating functions that use vector type.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS extensions;
ALTER EXTENSION vector SET SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- 2. Function Search Path Mutable
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
-- 3. Materialized View in API (price_sparkline)
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
-- SELECT proname, proconfig FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'public' AND proname IN ('search_historical_analyses', 'prune_old_analyses', 'get_price_sparkline');
-- SELECT extname, n.nspname FROM pg_extension e JOIN pg_namespace n ON e.extnamespace = n.oid WHERE extname = 'vector';
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'price_sparkline' AND grantee IN ('anon', 'authenticated');
-- SELECT * FROM get_price_sparkline('SPY', now() - interval '1 hour', 10, NULL);

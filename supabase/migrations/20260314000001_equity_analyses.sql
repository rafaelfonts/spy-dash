-- supabase/migrations/20260314000001_equity_analyses.sql
SET search_path TO public, extensions;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS equity_analyses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol          TEXT NOT NULL,
  summary         TEXT,
  full_text       TEXT,
  embedding       extensions.vector(1536),
  market_snapshot JSONB,
  structured_output JSONB,
  analysis_date   DATE DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE equity_analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own equity analyses"
  ON equity_analyses FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS equity_analyses_embedding_hnsw
  ON equity_analyses
  USING hnsw (embedding extensions.vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

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

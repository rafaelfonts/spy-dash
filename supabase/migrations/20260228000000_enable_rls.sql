-- =============================================================================
-- Migration: Enable Row Level Security (RLS) on SPY Dash tables
-- Date: 2026-02-28
-- Tables: ai_analyses, price_ticks
-- Note: price_sparkline is a MATERIALIZED VIEW — RLS is not supported on
--       materialized views in PostgreSQL. Access control is enforced via the
--       backend service role key (bypasses RLS) only.
--
-- Security model:
--   - Backend uses SUPABASE_SERVICE_ROLE_KEY → bypasses RLS (trusted server)
--   - Future direct client access → restricted to own rows via auth.uid()
--   - price_ticks has no user_id → service role only (deny all clients)
--   - price_sparkline → materialized view, no RLS possible; service role only
-- =============================================================================


-- ---------------------------------------------------------------------------
-- TABLE: ai_analyses
-- Columns: id, user_id, summary, full_text, embedding, market_snapshot,
--          bias, structured_output, created_at
-- Isolation key: user_id = auth.uid()
-- ---------------------------------------------------------------------------

ALTER TABLE ai_analyses ENABLE ROW LEVEL SECURITY;

-- Prevent the implicit "no policy = no access" from breaking service role writes.
-- Service role key bypasses RLS entirely; these policies govern anon/authenticated.

-- SELECT: only own rows
CREATE POLICY "ai_analyses_select_own"
  ON ai_analyses
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid()::text);

-- INSERT: can only insert rows where user_id matches own uid
CREATE POLICY "ai_analyses_insert_own"
  ON ai_analyses
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid()::text);

-- UPDATE: can only update own rows, and cannot change user_id to another user
CREATE POLICY "ai_analyses_update_own"
  ON ai_analyses
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

-- DELETE: can only delete own rows
CREATE POLICY "ai_analyses_delete_own"
  ON ai_analyses
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid()::text);

-- Explicitly deny all access to anonymous (unauthenticated) users
-- (No policy for anon role = no access by default when RLS is enabled)


-- ---------------------------------------------------------------------------
-- TABLE: price_ticks
-- Columns: id, symbol, recorded_at, price, bid, ask, volume
-- No user_id — this is global market data written by the backend service role.
-- Direct client access is not required; deny all non-service-role access.
-- ---------------------------------------------------------------------------

ALTER TABLE price_ticks ENABLE ROW LEVEL SECURITY;

-- No policies for authenticated or anon roles.
-- Service role bypasses RLS and can still read/write freely.
-- Any attempt by a JWT-authenticated client to access this table is denied.


-- ---------------------------------------------------------------------------
-- MATERIALIZED VIEW: price_sparkline
-- Columns: symbol, minute, price_avg, price_low, price_high
-- RLS is NOT supported on materialized views in PostgreSQL (ERROR 42809).
-- Access is controlled exclusively via the backend SUPABASE_SERVICE_ROLE_KEY.
-- No action required here.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- VERIFICATION QUERIES (run manually after applying migration)
-- ---------------------------------------------------------------------------
-- Check RLS is enabled on tables (price_sparkline is a matview, excluded):
--   SELECT tablename, rowsecurity
--   FROM pg_tables
--   WHERE tablename IN ('ai_analyses', 'price_ticks');
--
-- Check all policies:
--   SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
--   FROM pg_policies
--   WHERE tablename IN ('ai_analyses', 'price_ticks')
--   ORDER BY tablename, cmd;
-- ---------------------------------------------------------------------------

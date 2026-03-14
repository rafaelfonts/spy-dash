-- supabase/migrations/20260315000000_equity_tables.sql

-- Tabela de operações de equity (swing trades)
CREATE TABLE IF NOT EXISTS equity_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  entry_date date NOT NULL,
  exit_date date,
  entry_price numeric(10,4) NOT NULL,
  exit_price numeric(10,4),
  quantity integer NOT NULL CHECK (quantity > 0),
  pnl numeric(10,4),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  notes text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE equity_trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own equity trades"
  ON equity_trades FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX idx_equity_trades_user_month
  ON equity_trades(user_id, entry_date);

-- Tabela de watchlist de equity
CREATE TABLE IF NOT EXISTS equity_watchlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  alert_price numeric(10,4),
  alert_direction text CHECK (alert_direction IN ('above', 'below')),
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, symbol)
);

ALTER TABLE equity_watchlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own equity watchlist"
  ON equity_watchlist FOR ALL
  USING (auth.uid() = user_id);

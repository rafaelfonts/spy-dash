-- Add optional comments field to portfolio_positions for recording trade thesis
ALTER TABLE portfolio_positions ADD COLUMN IF NOT EXISTS comments TEXT;

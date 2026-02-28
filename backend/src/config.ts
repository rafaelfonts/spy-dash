import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(__dirname, '../.env') })

function requireEnv(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required environment variable: ${key}`)
  return val
}

export const CONFIG = {
  TT_BASE: process.env.TT_BASE ?? 'https://api.tastytrade.com',
  TT_CLIENT_ID: requireEnv('TT_CLIENT_ID'),
  TT_CLIENT_SECRET: requireEnv('TT_CLIENT_SECRET'),
  TT_REFRESH_TOKEN: requireEnv('TT_REFRESH_TOKEN'),
  OPENAI_API_KEY: requireEnv('OPENAI_API_KEY'),
  FRED_API_KEY: process.env.FRED_API_KEY ?? '',
  FINNHUB_API_KEY: process.env.FINNHUB_API_KEY ?? '',
  GNEWS_API_KEY: process.env.GNEWS_API_KEY ?? '',
  BLS_API_KEY: process.env.BLS_API_KEY ?? '',
  PORT: parseInt(process.env.PORT ?? '3001', 10),
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  ANALYZE_COOLDOWN_MS: parseInt(process.env.ANALYZE_COOLDOWN_MS ?? '30000', 10),
  OPTION_CHAIN_THRESHOLD: parseFloat(process.env.OPTION_CHAIN_THRESHOLD ?? '0.003'),
  HEALTH_SECRET: process.env.HEALTH_SECRET ?? '',
  TRADIER_API_KEY: process.env.TRADIER_API_KEY ?? '',
  TRADIER_BASE_URL: process.env.TRADIER_BASE_URL ?? 'https://sandbox.tradier.com',
  ALPHA_VANTAGE_KEY: process.env.ALPHA_VANTAGE_KEY ?? '',
  REDIS_URL: process.env.REDIS_URL ?? '',
} as const

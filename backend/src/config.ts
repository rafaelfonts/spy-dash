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
  PORT: parseInt(process.env.PORT ?? '3001', 10),
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
} as const

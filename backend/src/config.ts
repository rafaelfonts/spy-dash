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
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
  FRED_API_KEY: process.env.FRED_API_KEY ?? '',
  FINNHUB_API_KEY: process.env.FINNHUB_API_KEY ?? '',
  GNEWS_API_KEY: process.env.GNEWS_API_KEY ?? '',
  TAVILY_API_KEY: process.env.TAVILY_API_KEY ?? '',
  BLS_API_KEY: process.env.BLS_API_KEY ?? '',
  // CFTC / Treasury / EIA / FINRA extras
  CFTC_PRE_BASE_URL: process.env.CFTC_PRE_BASE_URL ?? '',
  EIA_API_KEY: process.env.EIA_API_KEY ?? '',
  FINRA_API_KEY: process.env.FINRA_API_KEY ?? '',
  PORT: parseInt(process.env.PORT ?? '3001', 10),
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  ANALYZE_COOLDOWN_MS: parseInt(process.env.ANALYZE_COOLDOWN_MS ?? '30000', 10),
  OPTION_CHAIN_THRESHOLD: parseFloat(process.env.OPTION_CHAIN_THRESHOLD ?? '0.01'),
  HEALTH_SECRET: process.env.HEALTH_SECRET ?? '',
  TRADIER_API_KEY: process.env.TRADIER_API_KEY ?? '',
  TRADIER_BASE_URL: process.env.TRADIER_BASE_URL ?? 'https://sandbox.tradier.com',
  OPLAB_ACCESS_TOKEN: process.env.OPLAB_ACCESS_TOKEN ?? '',
  REDIS_URL: process.env.REDIS_URL ?? '',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? '',
  discord: {
    // LEGADO — manter como fallback durante migração; remover após P2–P4 validados
    webhookUrl: process.env.DISCORD_WEBHOOK_URL ?? '',

    // Novos canais
    webhookFeed: process.env.DISCORD_WEBHOOK_FEED ?? '',
    webhookBriefings: process.env.DISCORD_WEBHOOK_BRIEFINGS ?? '',
    webhookSinais: process.env.DISCORD_WEBHOOK_SINAIS ?? '',
    webhookCarteira: process.env.DISCORD_WEBHOOK_CARTEIRA ?? '',
    webhookAcoes: process.env.DISCORD_WEBHOOK_ACOES ?? '',
    webhookThread: process.env.DISCORD_WEBHOOK_THREAD ?? '',
    webhookRoteiro: process.env.DISCORD_WEBHOOK_ROTEIRO ?? '',
  },
  reddit: {
    clientId: process.env.REDDIT_CLIENT_ID ?? '',
    clientSecret: process.env.REDDIT_CLIENT_SECRET ?? '',
    userAgent: process.env.REDDIT_USER_AGENT ?? 'SPYDash/1.0',
    subreddits: process.env.REDDIT_SUBREDDITS
      ?.split(',').map((s) => s.trim())
      ?? [
        'wallstreetbets', 'options', 'stocks', 'investing', 'SecurityAnalysis',
        'StockMarket', 'SPACs', 'pennystocks', 'dividends', 'thetagang',
      ],
  },
} as const

// Validar chaves críticas no startup
if (CONFIG.ANTHROPIC_API_KEY && CONFIG.ANTHROPIC_API_KEY.length < 20) {
  console.warn('⚠️  ANTHROPIC_API_KEY parece inválida (muito curta). Claude será desabilitado.')
}

if (!CONFIG.OPENAI_API_KEY || CONFIG.OPENAI_API_KEY.length < 20) {
  throw new Error('OPENAI_API_KEY inválida ou ausente. Backend não pode iniciar.')
}

if (!CONFIG.TAVILY_API_KEY) {
  console.warn('⚠️  TAVILY_API_KEY não configurada. Tool search_live_news usará fallback.')
}

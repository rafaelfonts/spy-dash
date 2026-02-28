import Fastify from 'fastify'
import cors from '@fastify/cors'
import { CONFIG } from './config'
import { initTokenManager } from './auth/tokenManager'
import { startDXFeedStream } from './stream/dxfeedClient'
import { startVIXPoller } from './data/vixPoller'
import { startIVRankPoller } from './data/ivRankPoller'
import { startAdvancedMetricsPoller } from './data/advancedMetricsPoller'
import { startEarningsCalendar } from './data/earningsCalendar'
import { startFredPoller } from './data/fredPoller'
import { startFearGreedPoller } from './data/fearGreed'
import { startMacroCalendar } from './data/macroCalendar'
import { startNewsAggregator } from './data/newsAggregator'
import { startBlsPoller } from './data/blsPoller'
import { startVIXTermStructurePoller } from './data/vixTermStructurePoller'
import { startTechnicalIndicatorsPoller } from './data/technicalIndicatorsPoller'
import { registerSSE } from './api/sse'
import { registerOpenAI } from './api/openai'
import { registerHealth } from './api/health'
import { registerPriceHistory } from './api/priceHistory'
import { getOptionChain } from './data/optionChain'
import { requireAuth } from './middleware/authMiddleware'
import { restoreSnapshotsFromCache } from './lib/restoreCache'
import { restorePriceHistory, restoreFromTradier } from './data/priceHistory'
import { cleanupExpiredCache } from './lib/cacheStore'
import { getBreakerStatuses, resetBreaker, listBreakers } from './lib/circuitBreaker'

const fastify = Fastify({
  logger: {
    level: 'info',
  },
})

async function bootstrap(): Promise<void> {
  // CORS
  await fastify.register(cors, {
    origin: CONFIG.CORS_ORIGIN,
    methods: ['GET', 'POST', 'OPTIONS'],
  })

  // Parse JSON bodies
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      try {
        done(null, body ? JSON.parse(body as string) : {})
      } catch (err) {
        done(err as Error)
      }
    },
  )

  // Rota pública de health check
  await registerHealth(fastify)

  // Rotas protegidas por JWT Supabase
  await fastify.register(async (app) => {
    app.addHook('preHandler', requireAuth)
    await registerSSE(app)
    await registerOpenAI(app)
    await registerPriceHistory(app)
    app.get('/api/option-chain', async () => {
      return await getOptionChain()
    })

    // Admin: circuit breaker management (requires auth)
    app.get('/admin/breakers', async () => {
      return { circuitBreakers: getBreakerStatuses(), breakers: listBreakers() }
    })
    app.post('/admin/breakers/:name/reset', async (request, reply) => {
      const { name } = request.params as { name: string }
      const ok = resetBreaker(name)
      if (!ok) {
        reply.code(404)
        return { error: `Circuit breaker '${name}' not found` }
      }
      return { ok: true, name, status: 'CLOSED' }
    })
  })

  // Start server
  await fastify.listen({ port: CONFIG.PORT, host: '0.0.0.0' })
  console.log(`\n🚀 SPY Dash backend running on http://localhost:${CONFIG.PORT}`)
  console.log(`   Health: http://localhost:${CONFIG.PORT}/health`)
  console.log(`   Stream: http://localhost:${CONFIG.PORT}/stream/market\n`)

  // Restore cached market snapshots before pollers start (independent of Tastytrade token)
  await restoreSnapshotsFromCache()
  await restorePriceHistory()
  await restoreFromTradier()  // overwrites Supabase history with richer Tradier 1-min bars

  // Daily cleanup of expired cache entries
  setInterval(() => cleanupExpiredCache().catch(console.error), 24 * 60 * 60 * 1000)

  // Tradier-based pollers are independent of Tastytrade — start unconditionally
  startAdvancedMetricsPoller()
  startTechnicalIndicatorsPoller()  // no-op if ALPHA_VANTAGE_KEY not set

  // Initialize token and start streaming
  console.log('[Bootstrap] Initializing Tastytrade OAuth2...')
  try {
    await initTokenManager()
    console.log('[Bootstrap] Token acquired. Starting DXFeed stream...')
    startDXFeedStream()
    startVIXPoller()
    startVIXTermStructurePoller()
    startIVRankPoller()
    startEarningsCalendar()
    startFredPoller()
    startFearGreedPoller()
    startMacroCalendar()
    startNewsAggregator()
    startBlsPoller()
  } catch (err) {
    console.error('[Bootstrap] Failed to initialize token:', (err as Error).message)
    console.error('[Bootstrap] The server is running but market data will not stream.')
    console.error('[Bootstrap] Check your TT_REFRESH_TOKEN in .env')
  }
}

bootstrap().catch((err) => {
  console.error('Fatal error during bootstrap:', err)
  process.exit(1)
})

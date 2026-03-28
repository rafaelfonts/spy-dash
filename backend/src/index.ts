import Fastify from 'fastify'
import cors from '@fastify/cors'
import { CONFIG } from './config'
import { initTokenManager } from './auth/tokenManager'
import { startDXFeedStream } from './stream/dxfeedClient'
import { startVIXPoller } from './data/vixPoller'
import { startIVRankPoller } from './data/ivRankPoller'
import { startAdvancedMetricsPoller } from './data/advancedMetricsPoller'
import { startExpectedMovePoller } from './data/expectedMovePoller'
import { startEarningsCalendar } from './data/earningsCalendar'
import { startFredPoller } from './data/fredPoller'
import { startFearGreedPoller } from './data/fearGreed'
import { startMacroCalendar } from './data/macroCalendar'
import { startNewsAggregator } from './data/newsAggregator'
import { startBlsPoller } from './data/blsPoller'
import { startVIXTermStructurePoller } from './data/vixTermStructurePoller'
import { startSkewPoller } from './data/skewPoller'
import { startTechnicalIndicatorsPoller } from './data/technicalIndicatorsPoller'
import { startPreMarketScheduler, restoreBriefingFromCache } from './data/preMarketBriefing'
import { startVideoScriptScheduler, restoreVideoScriptFromCache, generateVideoScript } from './data/videoScriptService'
import { startScheduledSignalScheduler } from './data/scheduledSignalService'
import { startDailyScriptScheduler, restoreDailyScriptFromCache, generateDailyScript } from './data/dailyScriptService'
import { startPortfolioTrackerScheduler, refreshPortfolioSnapshot } from './data/portfolioTrackerService'
import { startCBOEPCRScheduler } from './data/cboePCRPoller'
import { startApeWisdomPoller } from './data/apeWisdomPoller'
import { startRedditSentimentPoller } from './data/redditSentimentPoller'
import { startRedditPostsPoller } from './data/redditPostsPoller'
import { startMacroDigestScheduler, restoreMacroDigestFromCache } from './data/macroDigestService'
import { startOutcomeFiller } from './data/signalLogger'
import { startRVOLPoller } from './data/rvolPoller'
import { startCftcCotPoller } from './data/cftcCotPoller'
import { startEquityScreenerPoller } from './data/equityScreenerPoller.js'
import { startEquityNotificationsScheduler } from './data/equityNotificationsScheduler.js'
import { startTreasuryPoller } from './data/treasuryPoller'
import { startEiaOilPoller } from './data/eiaOilPoller'
import { startFinraDarkPoolPoller } from './data/finraDarkPoolPoller'
import { startSKEWIndexPoller } from './data/skewIndexPoller'
import { registerSSE } from './api/sse'
import { registerOpenAI } from './api/openai'
import { registerRiskReview } from './api/riskReview'
import { registerHealth } from './api/health'
import { registerPriceHistory } from './api/priceHistory'
import { registerGex } from './api/gex'
import { registerVolumeProfile } from './api/volumeProfile'
import { registerAnalysisSearch } from './api/analysisSearch'
import { registerPortfolio } from './api/portfolio'
import { registerSignalMetrics } from './api/signalMetrics'
import { registerEquityAnalyzeRoute } from './api/equityAnalyze.js'
import { registerEquityTradesRoutes } from './api/equityTrades.js'
import { registerEquityWatchlistRoutes } from './api/equityWatchlist.js'
import { registerOptionScreener } from './api/optionScreener'
import { getOptionChain } from './data/optionChain'
import { requireAuth } from './middleware/authMiddleware'
import { restoreSnapshotsFromCache } from './lib/restoreCache'
import { restorePriceHistory, restoreFromTradier, restoreSPYQuoteFromTradier, restoreSPYQuoteFromCache, restoreIntradayFromRedis, startIntradayCachePersistence } from './data/priceHistory'
import { cleanupExpiredCache } from './lib/cacheStore'
import { getBreakerStatuses, resetBreaker, listBreakers } from './lib/circuitBreaker'
import { seedGexHistoryFromRedis } from './data/regimeScorer'

const fastify = Fastify({
  logger: {
    level: 'info',
  },
})

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    const result = await Promise.race([p, timeout])
    clearTimeout(timer!)
    return result as T
  } catch (err) {
    clearTimeout(timer!)
    console.warn(`[Bootstrap] ${label} failed — proceeding without: ${(err as Error).message}`)
    return null
  }
}

async function bootstrap(): Promise<void> {
  // CORS
  await fastify.register(cors, {
    origin: CONFIG.CORS_ORIGIN,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  })
  console.log(`[CORS] Origem permitida: ${CONFIG.CORS_ORIGIN}`)

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

  // Admin: force Kasper video script generation — protected by HEALTH_SECRET
  fastify.post('/admin/trigger-video-script', async (request, reply) => {
    const secret = CONFIG.HEALTH_SECRET
    const provided = (request.headers['x-admin-secret'] as string) ?? ''
    if (!secret || provided !== secret) {
      reply.code(401)
      return { error: 'Unauthorized' }
    }
    const { redis } = await import('./lib/cacheStore')
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    // cacheGet/cacheSet prefix keys with 'cache:' internally, so the actual Redis key is 'cache:cache:video_script:...'
    // The lock key is managed directly via redis.set (no cacheStore wrapper), so no double prefix
    await redis.del(`cache:cache:video_script:${today}`, `lock:video_script:${today}`)
    generateVideoScript().catch((err) =>
      console.error('[Admin] trigger-video-script error:', err),
    )
    reply.code(202)
    return { ok: true, message: `Geração iniciada para ${today} — verifique #roteiro em ~30s` }
  })

  // Admin: force daily script (roteiro) generation — protected by HEALTH_SECRET
  fastify.post('/admin/trigger-daily-script', async (request, reply) => {
    const secret = CONFIG.HEALTH_SECRET
    const provided = (request.headers['x-admin-secret'] as string) ?? ''
    if (!secret || provided !== secret) {
      reply.code(401)
      return { error: 'Unauthorized' }
    }
    const { redis } = await import('./lib/cacheStore')
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    await redis.del(`cache:daily_script:${today}`, `lock:daily_script:${today}`)
    generateDailyScript().catch((err) =>
      console.error('[Admin] trigger-daily-script error:', err),
    )
    reply.code(202)
    return { ok: true, message: `Geração iniciada para ${today} — verifique #briefings em ~30s` }
  })

  // Rotas protegidas por JWT Supabase
  await fastify.register(async (app) => {
    app.addHook('preHandler', requireAuth)
    await registerSSE(app)
    await registerOpenAI(app)
    await registerRiskReview(app)
    await registerPriceHistory(app)
    await registerGex(app)
    await registerVolumeProfile(app)
    await registerAnalysisSearch(app)
    await registerPortfolio(app)
    await registerSignalMetrics(app)
    await registerEquityAnalyzeRoute(app)
    await registerEquityTradesRoutes(app)
    await registerEquityWatchlistRoutes(app)
    await registerOptionScreener(app)
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

  // Start server immediately — health endpoint must be available without delay.
  // Data restores run in parallel in the background after listen() returns.
  await fastify.listen({ port: CONFIG.PORT, host: '0.0.0.0' })
  console.log(`\n🚀 SPY Dash backend running on http://localhost:${CONFIG.PORT}`)
  console.log(`   Health: http://localhost:${CONFIG.PORT}/health`)
  console.log(`   Stream: http://localhost:${CONFIG.PORT}/stream/market\n`)

  // Daily cleanup of expired cache entries
  setInterval(() => cleanupExpiredCache().catch(console.error), 24 * 60 * 60 * 1000)

  // Restore market state in parallel — non-blocking so the server stays responsive.
  // Each operation has its own timeout so a slow/unreachable service never hangs startup.
  console.log('[Bootstrap] Restoring market state (parallel, non-blocking)...')
  Promise.allSettled([
    withTimeout(initTokenManager(), 10_000, 'initTokenManager'),
    withTimeout(restoreSnapshotsFromCache(), 8_000, 'restoreSnapshotsFromCache'),
    // Intraday time-series: Redis first (instant, today-only), then Supabase, then Tradier
    // (overwrites with richer data). Sequential to avoid races on priceHistory.
    withTimeout(
      restoreIntradayFromRedis()
        .then(() => restorePriceHistory())
        .then(() => restoreFromTradier()),
      20_000,
      'restoreIntradayHistory',
    ),
    // Restore SPY quote: cache first (instant, 14h TTL), then Tradier (authoritative + refreshes cache).
    withTimeout(
      restoreSPYQuoteFromCache().then(() => restoreSPYQuoteFromTradier()),
      13_000,
      'restoreSPYQuote',
    ),
    // Restore today's pre-market/post-close briefing from Redis if available
    withTimeout(restoreBriefingFromCache(), 5_000, 'restoreBriefingFromCache'),
    // Restore today's Kasper video script from Redis if available
    withTimeout(restoreVideoScriptFromCache(), 5_000, 'restoreVideoScriptFromCache'),
    // Restore today's daily script (roteiro 16:20) from Redis if available
    withTimeout(restoreDailyScriptFromCache(), 5_000, 'restoreDailyScriptFromCache'),
    // Restore last macro digest from Redis if available (TTL 14h)
    withTimeout(restoreMacroDigestFromCache(), 5_000, 'restoreMacroDigestFromCache'),
    // Restore portfolio snapshot so GET /api/portfolio works on cold start
    withTimeout(refreshPortfolioSnapshot(), 10_000, 'refreshPortfolioSnapshot'),
  ]).then(() => {
    console.log('[Bootstrap] Market state restore complete — starting pollers and streams.')
    startIntradayCachePersistence()

    // Pré-popular histórico GEX 5 dias (Redis → memória) para regime scorer ter contexto imediato
    withTimeout(seedGexHistoryFromRedis(), 5_000, 'seedGexHistoryFromRedis').catch(console.error)

    // Tradier-based pollers are independent of Tastytrade — start unconditionally
    startAdvancedMetricsPoller()
    startExpectedMovePoller()
    startTechnicalIndicatorsPoller()

    // Start streaming (token was initialized above)
    try {
      startDXFeedStream()
      startVIXPoller()
      startVIXTermStructurePoller()
      startSkewPoller()
      startSKEWIndexPoller().catch(console.error)
      startIVRankPoller()
      startEarningsCalendar()
      startFredPoller()
      startFearGreedPoller()
      startMacroCalendar()
      startNewsAggregator()
      startBlsPoller()
      startCftcCotPoller()
      startTreasuryPoller()
      startEiaOilPoller()
      startFinraDarkPoolPoller()
    } catch (err) {
      console.error('[Bootstrap] Failed to start streaming services:', (err as Error).message)
    }

    startPreMarketScheduler()
    startVideoScriptScheduler()
    startScheduledSignalScheduler()
    startDailyScriptScheduler()
    startPortfolioTrackerScheduler()
    startCBOEPCRScheduler()
    startRedditSentimentPoller()
    startRedditPostsPoller()
    startMacroDigestScheduler()
    startOutcomeFiller()
    startRVOLPoller()
    startEquityScreenerPoller().catch((e) => console.warn('[startup] equityScreenerPoller failed:', e))
    startEquityNotificationsScheduler()
  }).catch(console.error)
}

bootstrap().catch((err) => {
  console.error('Fatal error during bootstrap:', err)
  process.exit(1)
})

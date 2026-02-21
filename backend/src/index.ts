import Fastify from 'fastify'
import cors from '@fastify/cors'
import { CONFIG } from './config'
import { initTokenManager } from './auth/tokenManager'
import { startDXFeedStream } from './stream/dxfeedClient'
import { startIVRankPoller } from './data/ivRankPoller'
import { registerSSE } from './api/sse'
import { registerOpenAI } from './api/openai'
import { registerHealth } from './api/health'
import { getOptionChain } from './data/optionChain'
import { requireAuth } from './middleware/authMiddleware'

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
    app.get('/api/option-chain', async () => {
      return { data: await getOptionChain() }
    })
  })

  // Start server
  await fastify.listen({ port: CONFIG.PORT, host: '0.0.0.0' })
  console.log(`\n🚀 SPY Dash backend running on http://localhost:${CONFIG.PORT}`)
  console.log(`   Health: http://localhost:${CONFIG.PORT}/health`)
  console.log(`   Stream: http://localhost:${CONFIG.PORT}/stream/market\n`)

  // Initialize token and start streaming
  console.log('[Bootstrap] Initializing Tastytrade OAuth2...')
  try {
    await initTokenManager()
    console.log('[Bootstrap] Token acquired. Starting DXFeed stream...')
    startDXFeedStream()
    startIVRankPoller()
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

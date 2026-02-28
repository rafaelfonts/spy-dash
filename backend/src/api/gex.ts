import type { FastifyInstance } from 'fastify'
import { getAdvancedMetricsSnapshot } from '../data/advancedMetricsState'
import { calculateDailyGex } from '../data/gexService'

export async function registerGex(app: FastifyInstance): Promise<void> {
  // Summary snapshot from in-memory state (updated every 60s by the poller)
  app.get('/api/gex', async (_req, reply) => {
    const snapshot = getAdvancedMetricsSnapshot()
    if (!snapshot?.gex) {
      return reply.code(503).send({ error: 'GEX not yet calculated' })
    }
    return reply.send(snapshot.gex)
  })

  // Full detail including complete byStrike[] array and ZGL — reads from Redis cache (5min TTL)
  app.get('/api/gex/detail', async (_req, reply) => {
    const result = await calculateDailyGex('SPY')
    if (!result) {
      return reply.code(503).send({ error: 'GEX not yet calculated' })
    }
    return reply.send({
      totalNetGamma: result.totalNetGamma,
      callWall: result.callWall,
      putWall: result.putWall,
      zeroGammaLevel: result.zeroGammaLevel,
      flipPoint: result.flipPoint,
      regime: result.regime,
      maxGexStrike: result.maxGexStrike,
      minGexStrike: result.minGexStrike,
      expiration: result.expiration,
      calculatedAt: result.calculatedAt,
      byStrike: result.profile.byStrike,
    })
  })
}

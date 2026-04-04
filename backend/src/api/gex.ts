import type { FastifyInstance } from 'fastify'
import { getAdvancedMetricsSnapshot } from '../data/advancedMetricsState'
import { calculateDailyGex } from '../data/gexService'
import { getBova11Snapshot } from '../data/bova11State'

const SUPPORTED_SYMBOLS = ['SPY', 'BOVA11'] as const
type SupportedSymbol = (typeof SUPPORTED_SYMBOLS)[number]

function isSupportedSymbol(s: unknown): s is SupportedSymbol {
  return typeof s === 'string' && (SUPPORTED_SYMBOLS as readonly string[]).includes(s)
}

export async function registerGex(app: FastifyInstance): Promise<void> {
  // Summary snapshot from in-memory state (updated every 60s by the poller)
  // Supports ?symbol=SPY (default) or ?symbol=BOVA11
  app.get<{ Querystring: { symbol?: string } }>('/api/gex', async (req, reply) => {
    const symbol = req.query.symbol ?? 'SPY'

    if (!isSupportedSymbol(symbol)) {
      return reply.code(400).send({ error: `Unsupported symbol: ${symbol}. Use SPY or BOVA11.` })
    }

    if (symbol === 'BOVA11') {
      // For BOVA11, calculate on-demand (no in-memory poller yet for dynamic GEX)
      const snap = getBova11Snapshot()
      if (!snap.last) {
        return reply.code(503).send({ error: 'BOVA11 price not yet available — poller may not have started or OPLAB_ACCESS_TOKEN is not set' })
      }
      const result = await calculateDailyGex('BOVA11')
      if (!result) {
        return reply.code(503).send({ error: 'BOVA11 GEX not yet calculated' })
      }
      return reply.send({
        symbol: 'BOVA11',
        total: result.totalNetGamma,
        callWall: result.callWall,
        putWall: result.putWall,
        zeroGamma: result.zeroGammaLevel,
        flipPoint: result.flipPoint,
        regime: result.regime,
        maxGexStrike: result.maxGexStrike,
        minGexStrike: result.minGexStrike,
        expiration: result.expiration,
        byStrike: result.profile.byStrike,
        vannaExposure: result.totalVannaExposure,
        charmExposure: result.totalCharmExposure,
        volatilityTrigger: result.volatilityTrigger,
        maxPain: result.maxPain,
        calculatedAt: result.calculatedAt,
      })
    }

    // SPY: return from in-memory advanced metrics snapshot
    const snapshot = getAdvancedMetricsSnapshot()
    if (!snapshot?.gex) {
      return reply.code(503).send({ error: 'GEX not yet calculated' })
    }
    return reply.send({ symbol: 'SPY', ...snapshot.gex })
  })

  // Full detail including complete byStrike[] array and ZGL — reads from Redis cache (5min TTL)
  app.get<{ Querystring: { symbol?: string } }>('/api/gex/detail', async (req, reply) => {
    const symbol = req.query.symbol ?? 'SPY'

    if (!isSupportedSymbol(symbol)) {
      return reply.code(400).send({ error: `Unsupported symbol: ${symbol}. Use SPY or BOVA11.` })
    }

    const result = await calculateDailyGex(symbol)
    if (!result) {
      return reply.code(503).send({ error: `GEX not yet calculated for ${symbol}` })
    }
    return reply.send({
      symbol,
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
      vannaByStrike: result.vannaByStrike,
      totalVannaExposure: result.totalVannaExposure,
      totalCharmExposure: result.totalCharmExposure,
      volatilityTrigger: result.volatilityTrigger,
      maxPain: result.maxPain,
    })
  })
}

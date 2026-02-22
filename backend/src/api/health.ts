import type { FastifyInstance } from 'fastify'
import { CONFIG } from '../config'
import { marketState } from '../data/marketState'
import { getBreakerStatuses } from '../lib/circuitBreaker'
import { getSSEStats } from './sse'

function getStatus(): 'ok' | 'degraded' {
  if (marketState.connection.wsState !== 'OPEN') return 'degraded'
  const breakers = getBreakerStatuses()
  if (Object.values(breakers).some((s) => s === 'OPEN')) return 'degraded'
  return 'ok'
}

export async function registerHealth(fastify: FastifyInstance): Promise<void> {
  // Público — apenas status binário, sem detalhes internos
  fastify.get('/health', async (_request, _reply) => {
    return { status: getStatus() }
  })

  // Protegido — detalhes completos, requer X-Health-Token
  fastify.get(
    '/health/details',
    {
      preHandler: async (_request, reply) => {
        const secret = CONFIG.HEALTH_SECRET
        if (!secret) {
          reply.code(503).send({ error: 'Health details endpoint not configured' })
          return
        }
        const token = _request.headers['x-health-token']
        if (token !== secret) {
          reply.code(401).send({ error: 'Unauthorized' })
        }
      },
    },
    async (_request, _reply) => {
      const now = Date.now()
      const spyAge = marketState.spy.lastUpdated
        ? Math.floor((now - marketState.spy.lastUpdated) / 1000)
        : null
      const vixAge = marketState.vix.lastUpdated
        ? Math.floor((now - marketState.vix.lastUpdated) / 1000)
        : null
      const ivRankAge = marketState.ivRank.lastUpdated
        ? Math.floor((now - marketState.ivRank.lastUpdated) / 1000)
        : null

      return {
        status: getStatus(),
        dataAge: { spy: spyAge, vix: vixAge, ivRank: ivRankAge },
        circuitBreakers: getBreakerStatuses(),
        sseClients: getSSEStats().count,
        uptime: Math.floor(process.uptime()),
      }
    },
  )
}

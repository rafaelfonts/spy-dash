import type { FastifyInstance } from 'fastify'
import { marketState } from '../data/marketState'

export async function registerHealth(fastify: FastifyInstance): Promise<void> {
  fastify.get('/health', async (_request, _reply) => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      market: {
        wsState: marketState.connection.wsState,
        reconnectAttempts: marketState.connection.reconnectAttempts,
        lastConnected: marketState.connection.lastConnected,
        spyLast: marketState.spy.last,
        vixLast: marketState.vix.last,
        ivRankValue: marketState.ivRank.value,
        spyDataAge: marketState.spy.lastUpdated
          ? Date.now() - marketState.spy.lastUpdated
          : null,
      },
    }
  })
}

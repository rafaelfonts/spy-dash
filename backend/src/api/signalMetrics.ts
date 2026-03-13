/**
 * signalMetrics — GET /api/signal-metrics
 *
 * Returns aggregated performance statistics from signal_outcomes.
 * Protected by JWT auth (registered inside the protected fastify scope in index.ts).
 *
 * Query params:
 *   days  (optional, default 30) — lookback window in calendar days
 */

import type { FastifyInstance } from 'fastify'
import { computeSignalMetrics, calibrateRegimeWeights } from '../data/signalLogger'

export async function registerSignalMetrics(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { days?: string } }>('/api/signal-metrics', async (request, reply) => {
    const days = Math.min(Math.max(parseInt(request.query.days ?? '30', 10) || 30, 7), 365)

    const metrics = await computeSignalMetrics(days)

    if (!metrics) {
      reply.code(204)
      return null
    }

    return metrics
  })

  app.get('/api/signal-metrics/calibration', async (_request, reply) => {
    const result = await calibrateRegimeWeights()
    if (!result) {
      reply.code(204)
      return null
    }
    return result
  })
}

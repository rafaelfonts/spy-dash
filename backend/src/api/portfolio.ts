import type { FastifyInstance } from 'fastify'
import {
  getPortfolioSnapshot,
  refreshPortfolioSnapshot,
} from '../data/portfolioTrackerService'
import { buildPortfolioPayload, callGestorRisco } from '../data/portfolioLifecycleAgent'

export async function registerPortfolio(app: FastifyInstance): Promise<void> {
  app.get('/api/portfolio', async (_req, reply) => {
    const snapshot = getPortfolioSnapshot()
    if (!snapshot) {
      return reply.send({ positions: [], capturedAt: null })
    }
    return reply.send({
      positions: snapshot.positions,
      capturedAt: new Date(snapshot.capturedAt).toISOString(),
    })
  })

  app.post('/api/portfolio/refresh', async (_req, reply) => {
    const snapshot = await refreshPortfolioSnapshot()
    if (!snapshot) {
      return reply.send({ positions: [], capturedAt: null })
    }
    return reply.send({
      positions: snapshot.positions,
      capturedAt: new Date(snapshot.capturedAt).toISOString(),
    })
  })

  app.post('/api/portfolio/analyze', async (_req, reply) => {
    let snapshot = getPortfolioSnapshot()
    if (!snapshot?.positions.length) {
      snapshot = await refreshPortfolioSnapshot()
    }
    if (!snapshot?.positions.length) {
      return reply.code(400).send({
        error: 'Nenhuma posição OPEN para analisar. Cadastre posições em portfolio_positions ou clique em Atualizar.',
      })
    }
    const payload = buildPortfolioPayload(snapshot.positions)
    try {
      const response = await callGestorRisco(payload)
      return reply.send({ alerts: response.alerts })
    } catch (err) {
      return reply.code(503).send({
        error: 'Falha ao analisar carteira (Claude).',
        detail: (err as Error).message,
      })
    }
  })
}

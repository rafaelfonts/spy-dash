import type { FastifyInstance } from 'fastify'
import {
  deletePortfolioPosition,
  getPortfolioSnapshot,
  insertPortfolioPosition,
  refreshPortfolioSnapshot,
  removePositionFromSnapshot,
} from '../data/portfolioTrackerService'
import { buildPortfolioPayload, callGestorRisco } from '../data/portfolioLifecycleAgent'
import type { InsertPositionPayload } from '../types/portfolio'

function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
}

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

  app.post<{ Body: InsertPositionPayload & Record<string, unknown> }>('/api/portfolio/positions', async (req, reply) => {
    const body = req.body ?? {}
    const strategyType = typeof body.strategy_type === 'string' ? body.strategy_type : 'PUT_SPREAD'

    // Iron Condor: 4 legs, insert 2 positions (put spread + call spread)
    if (strategyType === 'IRON_CONDOR') {
      const symbol = typeof body.symbol === 'string' ? body.symbol.trim() : ''
      const expiration_date = typeof body.expiration_date === 'string' ? body.expiration_date.trim() : ''
      const put_short_strike = Number(body.put_short_strike)
      const put_long_strike = Number(body.put_long_strike)
      const put_short_option_symbol = typeof body.put_short_option_symbol === 'string' ? body.put_short_option_symbol.trim() : ''
      const put_long_option_symbol = typeof body.put_long_option_symbol === 'string' ? body.put_long_option_symbol.trim() : ''
      const call_short_strike = Number(body.call_short_strike)
      const call_long_strike = Number(body.call_long_strike)
      const call_short_option_symbol = typeof body.call_short_option_symbol === 'string' ? body.call_short_option_symbol.trim() : ''
      const call_long_option_symbol = typeof body.call_long_option_symbol === 'string' ? body.call_long_option_symbol.trim() : ''
      const credit_received = Number(body.credit_received)

      if (!symbol) return reply.code(400).send({ error: 'Campo obrigatório: symbol' })
      if (!expiration_date || !isValidDate(expiration_date)) {
        return reply.code(400).send({ error: 'Campo obrigatório: expiration_date (YYYY-MM-DD)' })
      }
      if (!Number.isFinite(put_short_strike) || put_short_strike <= 0 || !Number.isFinite(put_long_strike) || put_long_strike <= 0) {
        return reply.code(400).send({ error: 'Put: strikes devem ser números positivos' })
      }
      if (put_short_strike <= put_long_strike) {
        return reply.code(400).send({ error: 'Put spread: short (venda) deve ser strike mais alto que long (compra)' })
      }
      if (!Number.isFinite(call_short_strike) || call_short_strike <= 0 || !Number.isFinite(call_long_strike) || call_long_strike <= 0) {
        return reply.code(400).send({ error: 'Call: strikes devem ser números positivos' })
      }
      if (call_short_strike >= call_long_strike) {
        return reply.code(400).send({ error: 'Call spread: short (venda) deve ser strike mais baixo que long (compra)' })
      }
      if (!put_short_option_symbol || !put_long_option_symbol || !call_short_option_symbol || !call_long_option_symbol) {
        return reply.code(400).send({ error: 'Todos os quatro símbolos de opção são obrigatórios' })
      }
      if (!Number.isFinite(credit_received) || credit_received <= 0) {
        return reply.code(400).send({ error: 'credit_received deve ser um número positivo (prêmio × 100)' })
      }

      const open_date = typeof body.open_date === 'string' ? body.open_date : undefined
      const comments = typeof body.comments === 'string' ? body.comments : undefined
      const halfCredit = Math.round((credit_received / 2) * 100) / 100

      const putPayload: InsertPositionPayload = {
        symbol,
        strategy_type: 'PUT_SPREAD',
        open_date,
        expiration_date,
        short_strike: put_short_strike,
        long_strike: put_long_strike,
        short_option_symbol: put_short_option_symbol,
        long_option_symbol: put_long_option_symbol,
        credit_received: halfCredit,
        comments,
      }
      const callPayload: InsertPositionPayload = {
        symbol,
        strategy_type: 'CALL_SPREAD',
        open_date,
        expiration_date,
        short_strike: call_short_strike,
        long_strike: call_long_strike,
        short_option_symbol: call_short_option_symbol,
        long_option_symbol: call_long_option_symbol,
        credit_received: halfCredit,
        comments,
      }

      const row1 = await insertPortfolioPosition(putPayload)
      if (!row1) {
        return reply.code(500).send({ error: 'Falha ao inserir perna put do Iron Condor' })
      }
      const row2 = await insertPortfolioPosition(callPayload)
      if (!row2) {
        return reply.code(500).send({ error: 'Falha ao inserir perna call do Iron Condor' })
      }
      return reply.code(201).send({ positions: [row1, row2] })
    }

    // Put Spread / Call Spread: 2 legs, one position
    const symbol = typeof body.symbol === 'string' ? body.symbol.trim() : ''
    const expiration_date = typeof body.expiration_date === 'string' ? body.expiration_date.trim() : ''
    const short_strike = Number(body.short_strike)
    const long_strike = Number(body.long_strike)
    const short_option_symbol = typeof body.short_option_symbol === 'string' ? body.short_option_symbol.trim() : ''
    const long_option_symbol = typeof body.long_option_symbol === 'string' ? body.long_option_symbol.trim() : ''
    const credit_received = Number(body.credit_received)

    if (!symbol) {
      return reply.code(400).send({ error: 'Campo obrigatório: symbol' })
    }
    if (!expiration_date || !isValidDate(expiration_date)) {
      return reply.code(400).send({ error: 'Campo obrigatório: expiration_date (YYYY-MM-DD)' })
    }
    if (!Number.isFinite(short_strike) || short_strike <= 0) {
      return reply.code(400).send({ error: 'short_strike deve ser um número positivo' })
    }
    if (!Number.isFinite(long_strike) || long_strike <= 0) {
      return reply.code(400).send({ error: 'long_strike deve ser um número positivo' })
    }
    if (!short_option_symbol) {
      return reply.code(400).send({ error: 'Campo obrigatório: short_option_symbol' })
    }
    if (!long_option_symbol) {
      return reply.code(400).send({ error: 'Campo obrigatório: long_option_symbol' })
    }
    if (!Number.isFinite(credit_received)) {
      return reply.code(400).send({ error: 'credit_received deve ser um número (prêmio × 100)' })
    }

    const payload: InsertPositionPayload = {
      symbol,
      strategy_type: strategyType === 'CALL_SPREAD' ? 'CALL_SPREAD' : 'PUT_SPREAD',
      open_date: typeof body.open_date === 'string' ? body.open_date : undefined,
      expiration_date,
      short_strike,
      long_strike,
      short_option_symbol,
      long_option_symbol,
      credit_received,
      comments: typeof body.comments === 'string' ? body.comments : undefined,
    }
    const position = await insertPortfolioPosition(payload)
    if (!position) {
      return reply.code(500).send({ error: 'Falha ao inserir posição no banco' })
    }
    return reply.code(201).send({ position })
  })

  app.delete<{ Params: { id: string } }>('/api/portfolio/positions/:id', async (req, reply) => {
    const { id } = req.params
    if (!id) {
      return reply.code(400).send({ error: 'ID da posição obrigatório' })
    }
    const deleted = await deletePortfolioPosition(id)
    if (!deleted) {
      return reply.code(404).send({ error: 'Posição não encontrada ou falha ao excluir' })
    }
    removePositionFromSnapshot(id)
    return reply.code(204).send()
  })
}

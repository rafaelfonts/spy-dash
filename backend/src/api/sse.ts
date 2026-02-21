import type { FastifyInstance } from 'fastify'
import type { IncomingMessage, ServerResponse } from 'http'
import { emitter, marketState } from '../data/marketState'
import type { SSEClient } from '../types/market'

const clients = new Set<SSEClient>()

function broadcast(event: string, data: unknown): void {
  for (const client of clients) {
    try {
      client.write(event, data)
    } catch {
      clients.delete(client)
    }
  }
}

// Forward market state events to all SSE clients
emitter.on('quote', (data) => broadcast('quote', data))
emitter.on('vix', (data) => broadcast('vix', data))
emitter.on('ivrank', (data) => broadcast('ivrank', data))
emitter.on('status', (data) => broadcast('status', data))

export async function registerSSE(fastify: FastifyInstance): Promise<void> {
  fastify.get('/stream/market', (request, reply) => {
    const res = reply.raw as ServerResponse

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const clientId = Math.random().toString(36).slice(2)

    const client: SSEClient = {
      id: clientId,
      write(event: string, data: unknown) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      },
    }

    clients.add(client)
    console.log(`[SSE] Client connected: ${clientId} (total: ${clients.size})`)

    // Send current market snapshot immediately
    if (marketState.spy.last !== null) {
      client.write('quote', {
        symbol: 'SPY',
        bid: marketState.spy.bid,
        ask: marketState.spy.ask,
        last: marketState.spy.last,
        change: marketState.spy.change,
        changePct: marketState.spy.changePct,
        volume: marketState.spy.volume,
        dayHigh: marketState.spy.dayHigh,
        dayLow: marketState.spy.dayLow,
        priceHistory: marketState.spy.priceHistory,
        timestamp: marketState.spy.lastUpdated,
      })
    }

    if (marketState.vix.last !== null) {
      client.write('vix', {
        symbol: '$VIX.X',
        last: marketState.vix.last,
        change: marketState.vix.change,
        changePct: marketState.vix.changePct,
        level: marketState.vix.level,
        priceHistory: marketState.vix.priceHistory,
        timestamp: marketState.vix.lastUpdated,
      })
    }

    if (marketState.ivRank.value !== null) {
      client.write('ivrank', {
        ivRank: marketState.ivRank.value,
        ivPercentile: marketState.ivRank.percentile,
        label: marketState.ivRank.label,
        timestamp: marketState.ivRank.lastUpdated,
      })
    }

    client.write('status', {
      connected: marketState.connection.wsState === 'OPEN',
      wsState: marketState.connection.wsState,
      reconnectAttempts: marketState.connection.reconnectAttempts,
    })

    // Keepalive comment every 15s to prevent proxy/browser timeout
    const keepaliveTimer = setInterval(() => {
      try {
        res.write(`: keepalive\n\n`)
      } catch {
        clients.delete(client)
        clearInterval(keepaliveTimer)
      }
    }, 15_000)

    request.raw.on('close', () => {
      clearInterval(keepaliveTimer)
      clients.delete(client)
      console.log(`[SSE] Client disconnected: ${clientId} (total: ${clients.size})`)
    })

    reply.hijack()
  })
}

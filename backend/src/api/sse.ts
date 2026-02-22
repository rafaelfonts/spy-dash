import type { FastifyInstance } from 'fastify'
import type { IncomingMessage, ServerResponse } from 'http'
import { emitter, marketState, newsSnapshot } from '../data/marketState'
import type { SSEClient } from '../types/market'
import { SSEBatcher } from '../lib/sseBatcher'

const HEARTBEAT_INTERVAL_MS = 15_000

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
const newsfeedBatcher = new SSEBatcher(500, (events) => {
  const merged = events.reduce((acc, e) => {
    acc[e.type] = e.payload;
    return acc;
  }, {} as Record<string, any>);

  for (const client of clients) {
    try {
      client.write('newsfeed-batch', { batch: merged });
    } catch {
      clients.delete(client);
    }
  }
});

emitter.on('newsfeed', (data) => {
  const payload = data.type === 'sentiment' ? data.fearGreed : data.items;
  newsfeedBatcher.emit({ type: data.type, payload });
})

export function getSSEStats(): { count: number; avgConnectionAgeMs: number } {
  if (clients.size === 0) return { count: 0, avgConnectionAgeMs: 0 }
  const now = Date.now()
  const total = [...clients].reduce((sum, c) => sum + (now - c.connectedAt), 0)
  return { count: clients.size, avgConnectionAgeMs: Math.round(total / clients.size) }
}

export async function registerSSE(fastify: FastifyInstance): Promise<void> {
  fastify.get('/stream/market', (request, reply) => {
    const res = reply.raw as ServerResponse

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    // Tell the browser to reconnect after 3s if the connection drops
    res.write('retry: 3000\n\n')

    const clientId = Math.random().toString(36).slice(2)

    const client: SSEClient = {
      id: clientId,
      connectedAt: Date.now(),
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

    // Send cached news feed snapshot to newly connected clients
    if (newsSnapshot.earnings.length > 0) {
      client.write('newsfeed', { type: 'earnings', items: newsSnapshot.earnings, ts: Date.now() })
    }
    if (newsSnapshot.macro.length > 0) {
      client.write('newsfeed', { type: 'macro', items: newsSnapshot.macro, ts: Date.now() })
    }
    if (newsSnapshot.bls.length > 0) {
      client.write('newsfeed', { type: 'bls', items: newsSnapshot.bls, ts: Date.now() })
    }
    if (newsSnapshot.fearGreed) {
      client.write('newsfeed', { type: 'sentiment', fearGreed: newsSnapshot.fearGreed, ts: Date.now() })
    }
    if (newsSnapshot.macroEvents.length > 0) {
      client.write('newsfeed', { type: 'macro-events', items: newsSnapshot.macroEvents, ts: Date.now() })
    }
    if (newsSnapshot.headlines.length > 0) {
      client.write('newsfeed', { type: 'headlines', items: newsSnapshot.headlines, ts: Date.now() })
    }

    // Heartbeat ping every 15s — keeps proxies from closing idle connections
    const heartbeatTimer = setInterval(() => {
      try {
        if (res.writable) {
          res.write(`event: ping\ndata: ${Date.now()}\n\n`)
        } else {
          clients.delete(client)
          clearInterval(heartbeatTimer)
        }
      } catch {
        clients.delete(client)
        clearInterval(heartbeatTimer)
      }
    }, HEARTBEAT_INTERVAL_MS)

    request.raw.on('close', () => {
      clearInterval(heartbeatTimer)
      clients.delete(client)
      console.log(`[SSE] Client disconnected: ${clientId} (total: ${clients.size})`)
    })

    reply.hijack()
  })
}

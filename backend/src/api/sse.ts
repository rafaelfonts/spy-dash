import type { FastifyInstance } from 'fastify'
import type { IncomingMessage, ServerResponse } from 'http'
import { CONFIG } from '../config'
import { emitter, marketState, newsSnapshot } from '../data/marketState'
import { getAdvancedMetricsSnapshot } from '../data/advancedMetricsState'
import { getVIXTermStructureSnapshot } from '../data/vixTermStructureState'
import { getTechnicalSnapshot } from '../data/technicalIndicatorsState'
import { getTodaysBriefing } from '../data/preMarketBriefing'
import type { SSEClient } from '../types/market'
import { SSEBatcher } from '../lib/sseBatcher'
import { checkAlerts } from '../data/alertEngine'

const HEARTBEAT_INTERVAL_MS = 15_000

const clients = new Set<SSEClient>()
const clientsByUser = new Map<string, SSEClient[]>()

function broadcast(event: string, data: unknown): void {
  for (const client of clients) {
    try {
      client.write(event, data)
    } catch {
      clients.delete(client)
    }
  }
}

export function broadcastToUser(userId: string, event: string, data: unknown): void {
  const userClients = clientsByUser.get(userId) ?? []
  for (const client of userClients) {
    try {
      client.write(event, data)
    } catch {
      // will be removed on disconnect
    }
  }
}

// Forward market state events to all SSE clients
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

emitter.on('advanced-metrics', (data) => broadcast('advanced-metrics', data))
emitter.on('vix-term-structure', (data) => broadcast('vix-term-structure', data))
emitter.on('technical-indicators', (data) => broadcast('technical-indicators', data))
emitter.on('briefing', (data) => broadcast('briefing', data))
emitter.on('quote', (data) => {
  if (data.last !== null) checkAlerts(data.last)
  broadcast('quote', {
    bid: data.bid,
    ask: data.ask,
    last: data.last,
    change: data.change,
    changePct: data.changePct,
    volume: data.volume,
    dayHigh: data.dayHigh,
    dayLow: data.dayLow,
    timestamp: data.timestamp,
  })
})
emitter.on('vix', (data) => {
  broadcast('vix', {
    last: data.last,
    change: data.change,
    changePct: data.changePct,
    level: data.level,
    timestamp: data.timestamp,
  })
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
    res.setHeader('Access-Control-Allow-Origin', CONFIG.CORS_ORIGIN)
    res.flushHeaders()

    // Tell the browser to reconnect after 3s if the connection drops
    res.write('retry: 3000\n\n')

    const clientId = Math.random().toString(36).slice(2)
    const userId = (request as any).user?.sub ?? 'anonymous'

    const client: SSEClient = {
      id: clientId,
      userId,
      connectedAt: Date.now(),
      write(event: string, data: unknown) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      },
    }

    clients.add(client)
    const existing = clientsByUser.get(userId) ?? []
    clientsByUser.set(userId, [...existing, client])
    console.log(`[SSE] Client connected: ${clientId} (total: ${clients.size})`)

    if (marketState.ivRank.value !== null) {
      client.write('ivrank', {
        ivRank: marketState.ivRank.value,
        ivPercentile: marketState.ivRank.percentile,
        ivx: marketState.ivRank.ivx,
        label: marketState.ivRank.label,
        timestamp: marketState.ivRank.lastUpdated,
      })
    }

    client.write('status', {
      connected: marketState.connection.wsState === 'OPEN',
      wsState: marketState.connection.wsState,
      reconnectAttempts: marketState.connection.reconnectAttempts,
    })

    // Send SPY/VIX snapshot to newly connected client
    if (marketState.spy.last !== null) {
      client.write('quote', {
        bid: marketState.spy.bid,
        ask: marketState.spy.ask,
        last: marketState.spy.last,
        change: marketState.spy.change,
        changePct: marketState.spy.changePct,
        volume: marketState.spy.volume,
        dayHigh: marketState.spy.dayHigh,
        dayLow: marketState.spy.dayLow,
        timestamp: marketState.spy.lastUpdated,
      })
    }
    if (marketState.vix.last !== null) {
      client.write('vix', {
        last: marketState.vix.last,
        change: marketState.vix.change,
        changePct: marketState.vix.changePct,
        level: marketState.vix.level,
        timestamp: marketState.vix.lastUpdated,
      })
    }

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

    // Send cached advanced metrics (GEX + VolumeProfile + P/C Ratio) snapshot
    const advancedSnapshot = getAdvancedMetricsSnapshot()
    if (advancedSnapshot) {
      client.write('advanced-metrics', advancedSnapshot)
    }

    // Send cached VIX term structure snapshot
    const tsSnapshot = getVIXTermStructureSnapshot()
    if (tsSnapshot) {
      client.write('vix-term-structure', tsSnapshot)
    }

    // Send cached technical indicators snapshot
    const techSnapshot = getTechnicalSnapshot()
    if (techSnapshot) {
      client.write('technical-indicators', techSnapshot)
    }

    // Send today's pre-market or post-close briefing if still valid
    const briefing = getTodaysBriefing()
    if (briefing && new Date() < new Date(briefing.expiresAt)) {
      client.write('briefing', briefing)
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
      const remaining = (clientsByUser.get(userId) ?? []).filter((c) => c.id !== clientId)
      if (remaining.length === 0) {
        clientsByUser.delete(userId)
      } else {
        clientsByUser.set(userId, remaining)
      }
      console.log(`[SSE] Client disconnected: ${clientId} (total: ${clients.size})`)
    })

    reply.hijack()
  })
}

import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { emitter, marketState } from '../data/marketState'
import { requireAuth } from '../middleware/authMiddleware'

// Compact tick payload — no priceHistory per tick (sent once in snapshot)
interface TickPayload {
  t: 'q' | 'v'    // type: quote | vix
  l: number | null  // last
  b: number | null  // bid
  a: number | null  // ask
  c: number | null  // change
  cp: number | null // changePct
  v: number | null  // volume
  dh: number | null // dayHigh
  dl: number | null // dayLow
  ts: number        // timestamp
}

export async function registerWSTicks(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/ws/ticks',
    { websocket: true, preHandler: [requireAuth] },
    (socket: WebSocket) => {
      // Send full snapshot on connect — priceHistory sent once, not on each tick
      const snapshot = {
        type: 'snapshot',
        spy: {
          ...marketState.spy,
          priceHistory: [...marketState.spy.priceHistory],
        },
        vix: {
          ...marketState.vix,
          priceHistory: [...marketState.vix.priceHistory],
        },
      }
      socket.send(JSON.stringify(snapshot))

      const onQuote = (data: {
        last: number | null
        bid: number | null
        ask: number | null
        change: number | null
        changePct: number | null
        volume: number | null
        dayHigh: number | null
        dayLow: number | null
        timestamp: number
      }) => {
        if (socket.readyState !== socket.OPEN) return
        const tick: TickPayload = {
          t: 'q',
          l: data.last,
          b: data.bid,
          a: data.ask,
          c: data.change,
          cp: data.changePct,
          v: data.volume,
          dh: data.dayHigh,
          dl: data.dayLow,
          ts: data.timestamp,
        }
        socket.send(JSON.stringify(tick))
      }

      const onVix = (data: {
        last: number | null
        change: number | null
        changePct: number | null
        timestamp: number
      }) => {
        if (socket.readyState !== socket.OPEN) return
        const tick: TickPayload = {
          t: 'v',
          l: data.last,
          b: null,
          a: null,
          c: data.change,
          cp: data.changePct,
          v: null,
          dh: null,
          dl: null,
          ts: data.timestamp,
        }
        socket.send(JSON.stringify(tick))
      }

      emitter.on('quote', onQuote)
      emitter.on('vix', onVix)

      socket.on('close', () => {
        emitter.off('quote', onQuote)
        emitter.off('vix', onVix)
      })
    },
  )
}

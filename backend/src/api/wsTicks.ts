import type { FastifyInstance } from 'fastify'
import type { SocketStream } from '@fastify/websocket'
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
    (connection: SocketStream) => {
      const socket = connection.socket
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

      // Tick batching — 100ms window per connection to handle high-frequency DXFeed bursts
      let tickBuffer: TickPayload[] = []
      let flushTimer: ReturnType<typeof setTimeout> | null = null

      function enqueueTick(tick: TickPayload): void {
        tickBuffer.push(tick)
        if (!flushTimer) {
          flushTimer = setTimeout(() => {
            if (socket.readyState === socket.OPEN && tickBuffer.length > 0) {
              socket.send(JSON.stringify(tickBuffer.length === 1 ? tickBuffer[0] : tickBuffer))
            }
            tickBuffer = []
            flushTimer = null
          }, 100)
        }
      }

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
        enqueueTick({
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
        })
      }

      const onVix = (data: {
        last: number | null
        change: number | null
        changePct: number | null
        timestamp: number
      }) => {
        if (socket.readyState !== socket.OPEN) return
        enqueueTick({
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
        })
      }

      emitter.on('quote', onQuote)
      emitter.on('vix', onVix)

      socket.on('close', () => {
        if (flushTimer) clearTimeout(flushTimer)
        emitter.off('quote', onQuote)
        emitter.off('vix', onVix)
      })
    },
  )
}

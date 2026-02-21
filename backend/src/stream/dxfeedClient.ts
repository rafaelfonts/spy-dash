import WebSocket from 'ws'
import { getStreamerCredentials } from '../auth/streamerToken'
import { updateSPY, updateVIX, updateConnection, marketState } from '../data/marketState'
import { Reconnector } from './reconnector'

type DXLinkState =
  | 'idle'
  | 'setup'
  | 'auth'
  | 'channel'
  | 'feed_setup'
  | 'subscribed'

// Field order matching acceptEventFields in FEED_SETUP
const QUOTE_FIELDS   = ['eventSymbol', 'bidPrice', 'askPrice', 'bidSize', 'askSize'] as const
const TRADE_FIELDS   = ['eventSymbol', 'price', 'dayVolume', 'change', 'dayTurnover'] as const
const SUMMARY_FIELDS = ['eventSymbol', 'dayHighPrice', 'dayLowPrice', 'prevDayClosePrice'] as const

// Watchdog: reconnect if no SPY data arrives for this long (1.5x server keepalive of 60s)
const STALE_THRESHOLD_MS = 90_000

let ws: WebSocket | null = null
let keepaliveTimer: NodeJS.Timeout | null = null
let watchdogTimer: NodeJS.Timeout | null = null
let state: DXLinkState = 'idle'
let running = false

const reconnector = new Reconnector({
  maxAttempts: 20,
  baseDelay: 1000,
  maxDelay: 30_000,
})

function clearKeepalive(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
  }
}

function clearWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
}

function resetWatchdog(): void {
  clearWatchdog()
  watchdogTimer = setInterval(() => {
    if (state === 'subscribed' && marketState.spy.lastUpdated > 0) {
      const age = Date.now() - marketState.spy.lastUpdated
      if (age > STALE_THRESHOLD_MS) {
        console.warn(`[DXFeed] Stale data detected (${age}ms), forcing reconnect`)
        ws?.terminate()
      }
    }
  }, 30_000)
}

function send(msg: object): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function parseCompactFeedData(data: unknown[]): void {
  let currentType: string | null = null

  for (const item of data) {
    if (typeof item === 'string') {
      currentType = item
    } else if (Array.isArray(item) && currentType) {
      processEventRecord(currentType, item as unknown[])
    }
  }
}

function processEventRecord(type: string, values: unknown[]): void {
  if (!values.length) return

  const symbol = values[0] as string

  if (type === 'Quote' && symbol === 'SPY') {
    // eventSymbol, bidPrice, askPrice, bidSize, askSize
    const bid = values[QUOTE_FIELDS.indexOf('bidPrice')] as number | null
    const ask = values[QUOTE_FIELDS.indexOf('askPrice')] as number | null
    if (isValidNumber(bid) || isValidNumber(ask)) {
      updateSPY({ bid: toNum(bid), ask: toNum(ask) })
    }
  } else if (type === 'Trade' && symbol === 'SPY') {
    // eventSymbol, price, dayVolume, change, dayTurnover
    const price  = values[TRADE_FIELDS.indexOf('price')]     as number | null
    const volume = values[TRADE_FIELDS.indexOf('dayVolume')] as number | null
    const change = values[TRADE_FIELDS.indexOf('change')]    as number | null
    if (isValidNumber(price)) {
      updateSPY({
        last:   toNum(price),
        volume: toNum(volume),
        change: toNum(change),
      })
    }
  } else if (type === 'Summary' && symbol === 'SPY') {
    // eventSymbol, dayHighPrice, dayLowPrice, prevDayClosePrice
    const high = values[SUMMARY_FIELDS.indexOf('dayHighPrice')]      as number | null
    const low  = values[SUMMARY_FIELDS.indexOf('dayLowPrice')]       as number | null
    const prev = values[SUMMARY_FIELDS.indexOf('prevDayClosePrice')] as number | null
    updateSPY({
      dayHigh:   toNum(high),
      dayLow:    toNum(low),
      prevClose: toNum(prev),
    })
  } else if (type === 'Trade' && symbol === '$VIX.X') {
    // VIX is an index — bid/ask are always NaN (not tradeable directly).
    // Use Trade price as the authoritative value.
    const price  = values[TRADE_FIELDS.indexOf('price')]  as number | null
    const change = values[TRADE_FIELDS.indexOf('change')] as number | null
    if (isValidNumber(price)) {
      updateVIX({
        last:   toNum(price),
        change: toNum(change),
      })
    }
  } else if (type === 'Summary' && symbol === '$VIX.X') {
    // When market is closed, VIX Trade price is NaN. Use prevDayClosePrice as fallback
    // so the VIX card shows the last closing value instead of blank.
    const prev = values[SUMMARY_FIELDS.indexOf('prevDayClosePrice')] as number | null
    if (isValidNumber(prev) && marketState.vix.last === null) {
      updateVIX({ last: toNum(prev) })
    }
  }
}

function isValidNumber(v: unknown): boolean {
  return typeof v === 'number' && isFinite(v)
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v
  return null
}

function handleMessage(raw: string): void {
  let msg: { type?: string; channel?: number; state?: string; data?: unknown[] }
  try {
    msg = JSON.parse(raw) as typeof msg
  } catch {
    return
  }

  const { type } = msg

  if (type === 'AUTH_STATE') {
    const authState = (msg as { state: string }).state
    console.log(`[DXFeed] AUTH_STATE: ${authState}`)

    if (authState === 'UNAUTHORIZED' && state === 'setup') {
      state = 'auth'
      getStreamerCredentials().then(({ token }) => {
        send({ type: 'AUTH', channel: 0, token })
      }).catch(console.error)
    } else if (authState === 'AUTHORIZED' && state === 'auth') {
      state = 'channel'
      send({
        type: 'CHANNEL_REQUEST',
        channel: 1,
        service: 'FEED',
        parameters: { contract: 'AUTO' },
      })
    }
  } else if (type === 'CHANNEL_OPENED' && msg.channel === 1) {
    console.log('[DXFeed] Channel 1 opened')
    state = 'feed_setup'
    send({
      type: 'FEED_SETUP',
      channel: 1,
      acceptAggregationPeriod: 0.1,
      acceptDataFormat: 'COMPACT',
      acceptEventFields: {
        Quote:   ['eventSymbol', 'bidPrice', 'askPrice', 'bidSize', 'askSize'],
        Trade:   ['eventSymbol', 'price', 'dayVolume', 'change', 'dayTurnover'],
        Summary: ['eventSymbol', 'dayHighPrice', 'dayLowPrice', 'prevDayClosePrice'],
      },
    })
    // subscribe() is sent after FEED_CONFIG confirms the feed is configured
  } else if (type === 'FEED_CONFIG' && msg.channel === 1) {
    // Server confirmed feed configuration — now safe to subscribe
    subscribe()
    state = 'subscribed'
    console.log('[DXFeed] Feed configured and subscribed')
    reconnector.reset()
    resetWatchdog()
    updateConnection({ wsState: 'OPEN', lastConnected: Date.now() })
  } else if (type === 'FEED_DATA' && msg.channel === 1) {
    if (Array.isArray(msg.data)) {
      parseCompactFeedData(msg.data)
    }
  } else if (type === 'KEEPALIVE') {
    // Echo keepalive back
    send({ type: 'KEEPALIVE', channel: 0 })
  } else if (type === 'ERROR') {
    console.error('[DXFeed] Server error:', JSON.stringify(msg))
  }
}

function subscribe(): void {
  send({
    type: 'FEED_SUBSCRIPTION',
    channel: 1,
    reset: true,
    add: [
      { type: 'Quote',   symbol: 'SPY' },
      { type: 'Trade',   symbol: 'SPY' },
      { type: 'Summary', symbol: 'SPY' },
      { type: 'Quote',   symbol: '$VIX.X' },
      { type: 'Trade',   symbol: '$VIX.X' },
      { type: 'Summary', symbol: '$VIX.X' },
    ],
  })
}

async function connect(): Promise<void> {
  updateConnection({
    wsState: 'CONNECTING',
    reconnectAttempts: reconnector.attemptCount,
  })

  let credentials: { token: string; dxlinkUrl: string }
  try {
    credentials = await getStreamerCredentials()
  } catch (err) {
    console.error('[DXFeed] Failed to get streamer credentials:', (err as Error).message)
    scheduleReconnect()
    return
  }

  console.log(`[DXFeed] Connecting to ${credentials.dxlinkUrl}`)
  state = 'setup'

  ws = new WebSocket(credentials.dxlinkUrl)

  ws.on('open', () => {
    console.log('[DXFeed] WebSocket connected, sending SETUP')
    send({
      type: 'SETUP',
      channel: 0,
      version: '0.1-js/1.0.0',
      minVersion: '0.1',
      keepaliveTimeout: 60,
      acceptKeepaliveTimeout: 60,
    })

    // Send keepalive every 25s
    clearKeepalive()
    keepaliveTimer = setInterval(() => {
      send({ type: 'KEEPALIVE', channel: 0 })
    }, 25_000)
  })

  ws.on('message', (data) => {
    handleMessage(data.toString())
  })

  ws.on('close', (code, reason) => {
    console.warn(`[DXFeed] WebSocket closed: ${code} ${reason}`)
    clearKeepalive()
    clearWatchdog()
    if (running) scheduleReconnect()
  })

  ws.on('error', (err) => {
    console.error('[DXFeed] WebSocket error:', err.message)
    clearKeepalive()
    clearWatchdog()
    ws?.terminate()
  })
}

function scheduleReconnect(): void {
  updateConnection({ wsState: 'RECONNECTING' })

  reconnector.wait().then(connect).catch((err) => {
    console.error('[DXFeed] Reconnect exhausted:', (err as Error).message)
    updateConnection({ wsState: 'CLOSED' })
  })
}

export function startDXFeedStream(): void {
  if (running) return
  running = true
  connect().catch(console.error)
}

export function stopDXFeedStream(): void {
  running = false
  clearKeepalive()
  clearWatchdog()
  ws?.close()
  ws = null
  state = 'idle'
}

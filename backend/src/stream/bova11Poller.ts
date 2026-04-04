/**
 * bova11Poller — polls OpLab API every 30s for BOVA11 price data.
 *
 * Market hours: B3 trades 09:00–18:00 BRT (12:00–21:00 UTC).
 * Outside market hours, polling is suspended to conserve API quota.
 *
 * Emits 'bova11_tick' on the shared emitter after each successful update.
 */

import { emitter } from '../data/marketState'
import { updateBova11, getBova11Snapshot } from '../data/bova11State'
import { fetchBova11Quote } from '../data/oplabClient'
import { CONFIG } from '../config'

const POLL_INTERVAL_MS = 30_000  // 30 seconds

/** Returns true if B3 is currently open (09:00–18:00 BRT = 12:00–21:00 UTC). */
function isBrazilMarketOpen(): boolean {
  const now = new Date()
  const utcHour = now.getUTCHours()
  const utcMinute = now.getUTCMinutes()
  const utcDay = now.getUTCDay()  // 0=Sun, 6=Sat

  // Skip weekends
  if (utcDay === 0 || utcDay === 6) return false

  const utcTotalMinutes = utcHour * 60 + utcMinute
  // B3 open: 12:00 UTC (09:00 BRT), close: 21:00 UTC (18:00 BRT)
  return utcTotalMinutes >= 12 * 60 && utcTotalMinutes < 21 * 60
}

async function pollBova11(): Promise<void> {
  if (!CONFIG.OPLAB_ACCESS_TOKEN) return

  if (!isBrazilMarketOpen()) {
    // Outside market hours: emit stale snapshot if available (non-null last price)
    const snap = getBova11Snapshot()
    if (snap.last !== null) {
      emitter.emit('bova11_tick', snap)
    }
    return
  }

  try {
    const quote = await fetchBova11Quote('BOVA11')
    updateBova11({
      last: quote.last,
      bid: quote.bid,
      ask: quote.ask,
      changePct: quote.changePct,
      volume: quote.volume,
    })
    emitter.emit('bova11_tick', getBova11Snapshot())
    console.log(`[Bova11Poller] BOVA11=$${quote.last} (${(quote.changePct * 100).toFixed(2)}%)`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[Bova11Poller] Failed to fetch BOVA11 quote:', msg)
  }
}

let pollerHandle: NodeJS.Timeout | null = null

export function startBova11Poller(): void {
  if (pollerHandle) return  // already running

  console.log('[Bova11Poller] Starting BOVA11 price poller (30s interval)')

  // Initial fetch immediately
  pollBova11().catch(() => undefined)

  pollerHandle = setInterval(() => {
    pollBova11().catch(() => undefined)
  }, POLL_INTERVAL_MS)
}

export function stopBova11Poller(): void {
  if (pollerHandle) {
    clearInterval(pollerHandle)
    pollerHandle = null
  }
}

/**
 * expectedMovePoller — updates Expected Move (1σ) for all expirations 0–60 DTE on a fixed interval.
 *
 * First tick after 10s so Tradier chains can be populated; then 60s during market
 * hours, 5 min outside. Failures are logged; previous snapshot is kept.
 */

import { getExpectedMoveAllExpirations } from './expectedMoveService'
import { publishExpectedMove } from './expectedMoveState'
import { isMarketOpen } from '../lib/time'

const SYMBOL = 'SPY'
const POLL_INTERVAL_MS = 60_000
const OFFHOURS_INTERVAL_MS = 5 * 60_000
const INITIAL_DELAY_MS = 10_000

async function tick(): Promise<void> {
  try {
    const entries = await getExpectedMoveAllExpirations(SYMBOL)
    if (entries.length > 0) publishExpectedMove(entries)
  } catch (err) {
    console.error('[ExpectedMove] Poll failed:', (err as Error).message)
  }
}

function scheduleNext(): void {
  const delay = isMarketOpen() ? POLL_INTERVAL_MS : OFFHOURS_INTERVAL_MS
  setTimeout(() => {
    tick().finally(scheduleNext)
  }, delay)
}

export function startExpectedMovePoller(): void {
  console.log('[ExpectedMove] Starting poller (first tick in 10s)...')
  setTimeout(() => {
    tick().finally(scheduleNext)
  }, INITIAL_DELAY_MS)
}

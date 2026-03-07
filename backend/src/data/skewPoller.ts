/**
 * skewPoller — drives Put Skew / Risk Reversal calculations on a 60s interval.
 *
 * Reads the in-memory option chain snapshot (populated by optionChainPoller),
 * computes SkewByDTE, and publishes to skewState for AI prompt injection.
 * Not broadcast via SSE — only consumed server-side by openai.ts.
 *
 * Pattern: identical to vixTermStructurePoller.ts (standalone, 15s initial delay).
 */

import { getOptionChainSnapshot, getOptionChainCapturedAt } from './optionChain'
import { calculateSkewByDTE } from './skewService'
import { publishSkew } from './skewState'
import { isMarketOpen } from '../lib/time'

const POLL_INTERVAL_MS     = 60_000       // 60s during market hours
const OFFHOURS_INTERVAL_MS = 5 * 60_000   // 5min outside market hours
const STALE_CHAIN_MS       = 6 * 60_000   // skip if chain is >6min old

// ---------------------------------------------------------------------------
// Single poll tick
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  const chain      = getOptionChainSnapshot()
  const capturedAt = getOptionChainCapturedAt()

  if (!chain || chain.length === 0) {
    console.warn('[SkewPoller] Option chain not yet available — skipping')
    return
  }

  if (capturedAt > 0 && Date.now() - capturedAt > STALE_CHAIN_MS) {
    console.warn('[SkewPoller] Option chain stale (>6min) — skipping')
    return
  }

  const skew = calculateSkewByDTE(chain)
  publishSkew(skew)

  const entries = Object.entries(skew).filter(([, v]) => v != null)
  if (entries.length === 0) {
    console.warn('[SkewPoller] No DTE buckets computed (insufficient option data)')
    return
  }

  const summary = entries
    .map(([k, v]) => `${k}: RR25=${(v as NonNullable<typeof v>).riskReversal25.toFixed(2)}% [${(v as NonNullable<typeof v>).skewLabel}]`)
    .join(' | ')
  console.log(`[SkewPoller] Published skew: ${summary}`)
}

// ---------------------------------------------------------------------------
// Adaptive scheduler
// ---------------------------------------------------------------------------

function scheduleNext(): void {
  const delay = isMarketOpen() ? POLL_INTERVAL_MS : OFFHOURS_INTERVAL_MS
  setTimeout(() => {
    tick()
      .catch((err) => console.error('[SkewPoller] Tick error:', (err as Error).message))
      .finally(scheduleNext)
  }, delay)
}

// ---------------------------------------------------------------------------
// Public start function
// ---------------------------------------------------------------------------

export function startSkewPoller(): void {
  console.log('[SkewPoller] Starting (first tick in 15s)...')
  // Delay allows option chain to be populated before first skew computation
  setTimeout(() => {
    tick()
      .catch((err) => console.error('[SkewPoller] Initial tick error:', (err as Error).message))
      .finally(scheduleNext)
  }, 15_000)
}

import { getOptionChainSnapshot, getOptionChainCapturedAt } from './optionChain'
import { marketState } from './marketState'
import { inferTermStructure } from './vixTermStructure'
import { publishVIXTermStructure } from './vixTermStructureState'

const POLL_INTERVAL_MS = 5 * 60_000   // 5 minutes — matches option chain refresh cadence
const STALE_THRESHOLD_MS = 6 * 60_000 // skip if option chain is >6min old

async function tick(): Promise<void> {
  const chain = getOptionChainSnapshot()
  const capturedAt = getOptionChainCapturedAt()
  const vixSpot = marketState.vix.last
  const spyPrice = marketState.spy.last

  if (!chain || chain.length === 0) {
    console.warn('[VIXTermStructure] Option chain not yet available — skipping')
    return
  }

  if (capturedAt > 0 && Date.now() - capturedAt > STALE_THRESHOLD_MS) {
    console.warn('[VIXTermStructure] Option chain is stale (>6min) — skipping')
    return
  }

  if (!vixSpot || !spyPrice) {
    console.warn('[VIXTermStructure] VIX spot or SPY price not available — skipping')
    return
  }

  const result = inferTermStructure(chain, vixSpot, spyPrice)
  if (!result) {
    console.warn('[VIXTermStructure] Could not infer term structure (insufficient IV data)')
    return
  }

  publishVIXTermStructure(result)
  console.log(
    `[VIXTermStructure] Published: structure=${result.structure} ` +
    `steepness=${result.steepness > 0 ? '+' : ''}${result.steepness}% ` +
    `curve=[${result.curve.map((p) => `${p.dte}d:${p.iv}%`).join(', ')}]`,
  )
}

function scheduleNext(): void {
  setTimeout(() => {
    tick()
      .catch((err) => console.error('[VIXTermStructure] Tick error:', (err as Error).message))
      .finally(scheduleNext)
  }, POLL_INTERVAL_MS)
}

export function startVIXTermStructurePoller(): void {
  console.log('[VIXTermStructure] Starting poller (5-min interval)...')
  // Delay first tick slightly to allow option chain to populate on startup
  setTimeout(() => {
    tick()
      .catch((err) => console.error('[VIXTermStructure] Initial tick error:', (err as Error).message))
      .finally(scheduleNext)
  }, 10_000) // wait 10s after start for option chain to be ready
}

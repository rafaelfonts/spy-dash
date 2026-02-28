/**
 * advancedMetricsPoller — drives GEX and Volume Profile calculations on a 60s interval.
 *
 * Design:
 *  - First tick fires immediately on startup (via Promise.resolve().then)
 *    so clients connecting early get real data quickly.
 *  - Subsequent ticks run every 60s.
 *  - GEX and VolumeProfile are computed in parallel (Promise.allSettled).
 *  - Errors in one service never abort the other — partial results are still
 *    published so the frontend always gets the best available snapshot.
 *  - Outside market hours the poller backs off to every 5 min to save API quota.
 */

import { calculateDailyGex } from './gexService'
import { buildVolumeProfile } from './volumeProfileService'
import { calculatePutCallRatio } from './putCallRatio'
import { publishAdvancedMetrics } from './advancedMetricsState'
import type { AdvancedMetricsPayload } from './advancedMetricsState'

const SYMBOL = 'SPY'
const POLL_INTERVAL_MS   = 60_000   // 60 s during market hours
const OFFHOURS_INTERVAL_MS = 5 * 60_000  // 5 min outside market hours

// ---------------------------------------------------------------------------
// Market hours helper (ET, DST-aware)
// ---------------------------------------------------------------------------

function isMarketOpen(): boolean {
  const now = new Date()
  const day = now.getUTCDay()
  if (day === 0 || day === 6) return false    // weekend

  const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset()
  const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset()
  const isDst = now.getTimezoneOffset() < Math.max(jan, jul)
  const etOffset = isDst ? -4 : -5

  const etMinutes = (now.getUTCHours() + etOffset) * 60 + now.getUTCMinutes()
  return etMinutes >= 570 && etMinutes < 960  // 09:30–16:00 ET
}

// ---------------------------------------------------------------------------
// Single poll tick
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  const [gexResult, profileResult, pcResult] = await Promise.allSettled([
    calculateDailyGex(SYMBOL),
    buildVolumeProfile(SYMBOL),
    calculatePutCallRatio(SYMBOL),
  ])

  if (gexResult.status === 'rejected') {
    console.error('[AdvancedMetrics] GEX calculation failed:', gexResult.reason)
  }
  if (profileResult.status === 'rejected') {
    console.error('[AdvancedMetrics] Volume Profile failed:', profileResult.reason)
  }
  if (pcResult.status === 'rejected') {
    console.error('[AdvancedMetrics] P/C Ratio failed:', pcResult.reason)
  }

  const gex = gexResult.status === 'fulfilled' ? gexResult.value : null
  const profile = profileResult.status === 'fulfilled' ? profileResult.value : null
  const pc = pcResult.status === 'fulfilled' ? pcResult.value : null

  // Only publish if at least one service returned data
  if (!gex && !profile && !pc) {
    console.warn('[AdvancedMetrics] All services returned null — skipping publish')
    return
  }

  const top20ByStrike = gex
    ? [...gex.profile.byStrike]
        .sort((a, b) => Math.abs(b.netGEX) - Math.abs(a.netGEX))
        .slice(0, 20)
        .map((s) => ({ strike: s.strike, netGEX: s.netGEX, callGEX: s.callGEX, putGEX: s.putGEX, callOI: s.callOI, putOI: s.putOI }))
    : []

  const payload: AdvancedMetricsPayload = {
    gex: gex
      ? {
          total: gex.totalNetGamma,
          callWall: gex.callWall,
          putWall: gex.putWall,
          zeroGamma: gex.zeroGammaLevel,
          flipPoint: gex.flipPoint,
          regime: gex.regime,
          maxGexStrike: gex.maxGexStrike,
          minGexStrike: gex.minGexStrike,
          expiration: gex.expiration,
          byStrike: top20ByStrike,
        }
      : null,
    profile: profile
      ? {
          poc: profile.poc,
          vah: profile.valueAreaHigh,
          val: profile.valueAreaLow,
          totalVolume: profile.totalVolume,
          barsProcessed: profile.barsProcessed,
        }
      : null,
    putCallRatio: pc
      ? {
          ratio: pc.ratio,
          putVolume: pc.putVolume,
          callVolume: pc.callVolume,
          label: pc.label,
          expiration: pc.expiration,
        }
      : null,
    timestamp: new Date().toISOString(),
  }

  publishAdvancedMetrics(payload)

  console.log(
    `[AdvancedMetrics] Published: ` +
    `GEX=${gex ? `$${gex.totalNetGamma}M ${gex.regime}` : 'unavailable'} ` +
    `POC=${profile ? profile.poc : 'unavailable'} ` +
    `P/C=${pc ? `${pc.ratio} (${pc.label})` : 'unavailable'}`,
  )
}

// ---------------------------------------------------------------------------
// Adaptive scheduler
// ---------------------------------------------------------------------------

function scheduleNext(): void {
  const delay = isMarketOpen() ? POLL_INTERVAL_MS : OFFHOURS_INTERVAL_MS
  setTimeout(() => {
    tick()
      .catch((err) => console.error('[AdvancedMetrics] Unexpected tick error:', err))
      .finally(scheduleNext)
  }, delay)
}

// ---------------------------------------------------------------------------
// Public start function — mirrors pattern of other pollers in the project
// ---------------------------------------------------------------------------

export function startAdvancedMetricsPoller(): void {
  console.log('[AdvancedMetrics] Starting poller...')

  // First tick fires asap so clients don't wait 60s for initial data
  Promise.resolve()
    .then(() => tick())
    .catch((err) => console.error('[AdvancedMetrics] Initial tick error:', err))
    .finally(scheduleNext)
}

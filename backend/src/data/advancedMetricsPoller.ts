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

import { calculateDailyGex, calculateDynamicGex } from './gexService'
import type { GEXDynamic } from './gexService'
import { buildVolumeProfile } from './volumeProfileService'
import { calculatePutCallRatio } from './putCallRatio'
import { publishAdvancedMetrics } from './advancedMetricsState'
import type { AdvancedMetricsPayload } from './advancedMetricsState'
import { isMarketOpen } from '../lib/time'
import { updateGexHistory, updateRegimeHistory, computeNoTradeScore, computeRegimeScore, getGexVsYesterday } from './regimeScorer'
import { saveGEXDailySnapshot } from './gexHistoryService'
import type { GEXDailySnapshot } from './gexHistoryService'
import { cacheGet } from '../lib/cacheStore'
import { fetchTodayVolumeSnapshot, saveVolumeSnapshot } from './volumeAnomalyService'
import type { VolumeSnapshot } from './volumeAnomalyService'
import { marketState } from './marketState'
import { getOptionChainSnapshot } from './optionChain'
import { calculateDAN } from '../lib/danCalculator'

const SYMBOL = 'SPY'
const POLL_INTERVAL_MS   = 60_000   // 60 s during market hours
const OFFHOURS_INTERVAL_MS = 5 * 60_000  // 5 min outside market hours

// ---------------------------------------------------------------------------
// Single poll tick
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  const [gexResult, profileResult, pcResult, gexDynamicResult] = await Promise.allSettled([
    calculateDailyGex(SYMBOL),
    buildVolumeProfile(SYMBOL),
    calculatePutCallRatio(SYMBOL),
    calculateDynamicGex(SYMBOL),
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
  if (gexDynamicResult.status === 'rejected') {
    console.error('[AdvancedMetrics] GEX dynamic failed:', gexDynamicResult.reason)
  }

  const gex = gexResult.status === 'fulfilled' ? gexResult.value : null
  const profile = profileResult.status === 'fulfilled' ? profileResult.value : null
  const pc = pcResult.status === 'fulfilled' ? pcResult.value : null
  const gexDynamic: GEXDynamic = gexDynamicResult.status === 'fulfilled' ? gexDynamicResult.value : []

  // Update GEX history for gex_vs_yesterday computation in regimeScorer
  // Use aggregated totalNetGamma across all dynamic entries (equivalent of old "all" bucket)
  const dynamicTotal = gexDynamic.length > 0
    ? gexDynamic.reduce((sum, e) => sum + e.gex.totalNetGamma, 0)
    : null
  const currentTotal = dynamicTotal ?? gex?.totalNetGamma ?? null
  if (currentTotal !== null) updateGexHistory(currentTotal)

  // Update intraday regime flip tracking (uses lowest-DTE entry regime)
  const lowestDTERegime = gexDynamic.length > 0 ? gexDynamic[0].gex.regime : gex?.regime ?? null
  if (lowestDTERegime) updateRegimeHistory(lowestDTERegime)

  // Only publish if at least one service returned data
  if (!gex && !profile && !pc) {
    console.warn('[AdvancedMetrics] All services returned null — skipping publish')
    return
  }

  // Serialize each DailyGexResult bucket for SSE (top-20 strikes by |netGEX|)
  function serializeGexBucket(bucket: typeof gex) {
    if (!bucket) return null
    const top20 = [...bucket.profile.byStrike]
      .sort((a, b) => Math.abs(b.netGEX) - Math.abs(a.netGEX))
      .slice(0, 20)
      .map((s) => ({ strike: s.strike, netGEX: s.netGEX, callGEX: s.callGEX, putGEX: s.putGEX, callOI: s.callOI, putOI: s.putOI }))
    return {
      total: bucket.totalNetGamma,
      callWall: bucket.callWall,
      putWall: bucket.putWall,
      zeroGamma: bucket.zeroGammaLevel,
      flipPoint: bucket.flipPoint,
      regime: bucket.regime,
      maxGexStrike: bucket.maxGexStrike,
      minGexStrike: bucket.minGexStrike,
      expiration: bucket.expiration,
      byStrike: top20,
      vannaExposure: bucket.totalVannaExposure,
      charmExposure: bucket.totalCharmExposure,
      volatilityTrigger: bucket.volatilityTrigger,
      maxPain: bucket.maxPain ?? null,
    }
  }

  // Serialize each GEXDynamic entry: trim byStrike to top-20 for SSE payload size
  const serializedGexDynamic: GEXDynamic = gexDynamic.map((entry) => ({
    ...entry,
    gex: {
      ...entry.gex,
      profile: {
        ...entry.gex.profile,
        byStrike: [...entry.gex.profile.byStrike]
          .sort((a, b) => Math.abs(b.netGEX) - Math.abs(a.netGEX))
          .slice(0, 20),
      },
    },
  }))

  // Delta-Adjusted Notional — flatten all legs from option chain snapshot
  const spotForDAN = marketState.spy.last ?? 0
  let dan: AdvancedMetricsPayload['dan'] = null
  if (spotForDAN > 0) {
    const chainSnap = getOptionChainSnapshot()
    if (chainSnap && chainSnap.length > 0) {
      const danInputs = chainSnap.flatMap((expiry) => [
        ...expiry.calls.map((leg) => ({
          strike: leg.strike,
          option_type: 'call' as const,
          open_interest: leg.openInterest ?? 0,
          delta: leg.delta ?? 0,
        })),
        ...expiry.puts.map((leg) => ({
          strike: leg.strike,
          option_type: 'put' as const,
          open_interest: leg.openInterest ?? 0,
          delta: leg.delta ?? 0,
        })),
      ])
      dan = calculateDAN(danInputs, spotForDAN)
    }
  }

  // Regime preview — computed every tick so the frontend can show the gauge before first AI analysis
  const regimeLive = computeRegimeScore(serializedGexDynamic.length > 0 ? serializedGexDynamic : null)
  const gexVsYesterday = currentTotal !== null ? getGexVsYesterday(currentTotal) : null

  const payload: AdvancedMetricsPayload = {
    gex: serializeGexBucket(gex),
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
    gexDynamic: serializedGexDynamic.length > 0 ? serializedGexDynamic : null,
    timestamp: new Date().toISOString(),
    noTrade: computeNoTradeScore(serializedGexDynamic.length > 0 ? serializedGexDynamic : null),
    dan,
    regimePreview: {
      score: regimeLive.score,
      vannaRegime: regimeLive.vannaRegime,
      charmPressure: regimeLive.charmPressure,
      gexVsYesterday,
      priceDistribution: regimeLive.priceDistribution,
    },
    marketOpen: isMarketOpen(),
  }

  publishAdvancedMetrics(payload)

  // Persist daily GEX snapshot to Redis (once per ET day, 7-day TTL)
  // Uses first entry (lowest DTE) as the reference for walls/flip — most liquid/impactful
  if (gexDynamic.length > 0) {
    const ref = gexDynamic[0].gex  // entry with smallest DTE (most liquid)
    const today = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2')
    const redisKey = `gex:history:SPY:${today}`
    const existing = await cacheGet<GEXDailySnapshot>(redisKey)
    if (!existing) {
      // Aggregate totals across all dynamic entries
      const aggNetGex = gexDynamic.reduce((sum, e) => sum + e.gex.totalNetGamma, 0)
      const aggVanna  = gexDynamic.reduce((sum, e) => sum + (e.gex.totalVannaExposure ?? 0), 0)
      const aggCharm  = gexDynamic.reduce((sum, e) => sum + (e.gex.totalCharmExposure ?? 0), 0)
      const snap: GEXDailySnapshot = {
        netGex:             aggNetGex / 1000,
        callWall:           ref.callWall,
        putWall:            ref.putWall,
        flipPoint:          ref.flipPoint ?? null,
        volatilityTrigger:  ref.volatilityTrigger ?? null,
        zeroGammaLevel:     ref.zeroGammaLevel ?? null,
        vannaExposure:      Math.round(aggVanna * 100) / 100,
        charmExposure:      Math.round(aggCharm * 100) / 100,
        capturedAt:         today,
      }
      await saveGEXDailySnapshot(snap)
    }
  }

  // Volume Anomaly Snapshot (0DTE) — save once per ET day, 7-day TTL
  const spyPrice = marketState.spy.last
  if (spyPrice) {
    const todayVolSnap = await fetchTodayVolumeSnapshot(SYMBOL, spyPrice)
    if (todayVolSnap) {
      const volKey = `vol:history:SPY:0dte:${todayVolSnap.date}`
      const existingVol = await cacheGet<VolumeSnapshot>(volKey)
      if (!existingVol) await saveVolumeSnapshot(todayVolSnap)
    }
  }

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

/**
 * volumeAnomalyService — Sizzle Index (vol hoje / vol médio 5d) para opções 0DTE SPY.
 *
 * Detecta fluxo institucional intraday que o GEX baseado em OI não captura.
 * Volume via Tradier API (OptionLeg.volume é sempre null no Tastytrade WS).
 *
 * Redis key: vol:history:SPY:0dte:YYYY-MM-DD (ET timezone, one snapshot per day)
 * TTL: 7 days
 */

import { getTradierClient } from '../lib/tradierClient'
import { resolveNearestExpiration } from './gexService'
import { cacheGet, cacheSet } from '../lib/cacheStore'

const VOL_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000
const VOL_HISTORY_KEY_PREFIX = 'vol:history:SPY:0dte:'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VolumeSnapshot {
  date: string          // YYYY-MM-DD ET
  putVolume: number     // total 0DTE puts volume
  callVolume: number    // total 0DTE calls volume
  atmPutVolume: number  // put with strike closest to SPY price
  atmCallVolume: number // call with strike closest to SPY price
}

export interface VolumeAnomalyData {
  sizzle0dte: number              // (putVol+callVol today) / avg5d total
  sizzleAtmStraddle: number       // (atmPut+atmCall today) / avg5d ATM straddle
  putCallVolumeRatio0dte: number  // putVol / callVol (Infinity if callVol=0)
  anomalyLabel: 'extreme_put' | 'high_put' | 'neutral' | 'high_call' | 'extreme_call'
  putBuyingPressure: 'heavy' | 'normal' | 'light'
  callBuyingPressure: 'heavy' | 'normal' | 'light'
  daysAvailable: number           // history days used for avg (not counting today)
  capturedAt: string              // ISO
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getETDateString(): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2')
}

function getETDateMinus(daysBack: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysBack)
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2')
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function classifyAnomaly(pcvr: number): VolumeAnomalyData['anomalyLabel'] {
  if (pcvr > 2.5) return 'extreme_put'
  if (pcvr > 1.5) return 'high_put'
  if (pcvr < 0.3) return 'extreme_call'
  if (pcvr < 0.5) return 'high_call'
  return 'neutral'
}

function pressure(today: number, avg: number): 'heavy' | 'normal' | 'light' {
  if (avg <= 0) return 'normal'
  if (today > avg * 1.5) return 'heavy'
  if (today < avg * 0.5) return 'light'
  return 'normal'
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Fetch today's 0DTE volume snapshot from Tradier.
 * Returns null if 0DTE is unavailable (weekend/holiday) or volume is zero.
 */
export async function fetchTodayVolumeSnapshot(
  symbol: string,
  spyPrice: number,
): Promise<VolumeSnapshot | null> {
  const today = getETDateString()

  const expiration = await resolveNearestExpiration(symbol)
  if (!expiration) {
    console.warn('[VolumeAnomaly] No expiration found for', symbol)
    return null
  }

  // Only process true 0DTE (today's expiration)
  if (expiration !== today) {
    console.log(`[VolumeAnomaly] 0DTE unavailable (nearest: ${expiration}) — skipping`)
    return null
  }

  const options = await getTradierClient().getOptionChain(symbol, expiration)
  if (!options || options.length === 0) {
    console.warn(`[VolumeAnomaly] Empty chain for ${symbol} ${expiration}`)
    return null
  }

  let putVolume = 0
  let callVolume = 0
  const atmStrike = Math.round(spyPrice)
  let bestPutStrikeDist = Infinity
  let bestCallStrikeDist = Infinity
  let atmPutVolume = 0
  let atmCallVolume = 0

  for (const opt of options) {
    const vol = opt.volume ?? 0
    if (opt.option_type === 'put') {
      putVolume += vol
      const dist = Math.abs(opt.strike - atmStrike)
      if (dist < bestPutStrikeDist) {
        bestPutStrikeDist = dist
        atmPutVolume = vol
      }
    } else {
      callVolume += vol
      const dist = Math.abs(opt.strike - atmStrike)
      if (dist < bestCallStrikeDist) {
        bestCallStrikeDist = dist
        atmCallVolume = vol
      }
    }
  }

  if (putVolume + callVolume === 0) {
    console.warn(`[VolumeAnomaly] ${symbol} ${expiration}: volume=0 — market closed or no data`)
    return null
  }

  return {
    date: today,
    putVolume,
    callVolume,
    atmPutVolume,
    atmCallVolume,
  }
}

/** Persist a volume snapshot to Redis (7-day TTL). */
export async function saveVolumeSnapshot(snap: VolumeSnapshot): Promise<void> {
  const key = `${VOL_HISTORY_KEY_PREFIX}${snap.date}`
  await cacheSet(key, snap, VOL_HISTORY_TTL_MS, 'volumeAnomaly')
  console.log(
    `[VolumeAnomaly] Snapshot salvo: ${key} | puts=${snap.putVolume.toLocaleString('en-US')} calls=${snap.callVolume.toLocaleString('en-US')}`,
  )
}

/**
 * Load up to `days` daily volume snapshots from Redis (D-0 through D-(days-1)).
 * Returns array in ascending chronological order (oldest first).
 * Skips missing days (weekends, holidays).
 */
export async function loadVolumeHistory(days = 5): Promise<VolumeSnapshot[]> {
  const results: VolumeSnapshot[] = []
  for (let i = days - 1; i >= 0; i--) {
    const date = getETDateMinus(i)
    const key = `${VOL_HISTORY_KEY_PREFIX}${date}`
    const snap = await cacheGet<VolumeSnapshot>(key)
    if (snap) results.push(snap)
  }
  return results
}

/**
 * Compute Sizzle Index and anomaly classification.
 * `today` = today's snapshot; `history` = prior days only (NOT including today).
 * Returns null if history has fewer than 2 days (insufficient baseline).
 */
export function computeVolumeAnomaly(
  today: VolumeSnapshot,
  history: VolumeSnapshot[],
): VolumeAnomalyData | null {
  if (history.length < 2) return null

  const avg5dTotal = mean(history.map((h) => h.putVolume + h.callVolume)) || 1
  const avg5dAtm   = mean(history.map((h) => h.atmPutVolume + h.atmCallVolume)) || 1
  const avg5dPut   = mean(history.map((h) => h.putVolume)) || 1
  const avg5dCall  = mean(history.map((h) => h.callVolume)) || 1

  const todayTotal = today.putVolume + today.callVolume
  const todayAtm   = today.atmPutVolume + today.atmCallVolume

  const sizzle0dte        = parseFloat((todayTotal / avg5dTotal).toFixed(2))
  const sizzleAtmStraddle = parseFloat((todayAtm   / avg5dAtm).toFixed(2))
  const putCallVolumeRatio0dte = parseFloat((today.putVolume / (today.callVolume || 1)).toFixed(3))

  return {
    sizzle0dte,
    sizzleAtmStraddle,
    putCallVolumeRatio0dte,
    anomalyLabel:        classifyAnomaly(putCallVolumeRatio0dte),
    putBuyingPressure:   pressure(today.putVolume,  avg5dPut),
    callBuyingPressure:  pressure(today.callVolume, avg5dCall),
    daysAvailable:       history.length,
    capturedAt:          new Date().toISOString(),
  }
}

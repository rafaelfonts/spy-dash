import { CONFIG } from '../config'
import { ensureAccessToken } from '../auth/tokenManager'
import { marketState, newsSnapshot } from './marketState'
import { calcDelta, calcGamma, calcTheta, calcVega } from '../lib/blackScholes'

export interface OptionExpiry {
  dte: number
  expirationDate: string
  calls: OptionLeg[]
  puts: OptionLeg[]
}

export interface OptionLeg {
  symbol: string
  strike: number
  bid: number | null
  ask: number | null
  volume: number | null
  openInterest: number | null
  iv: number | null
  delta: number | null
  gamma: number | null         // always positive
  theta: number | null         // daily $ decay (always negative)
  vega: number | null          // per 1% IV change
  greeksSource: 'api' | 'calculated' | null
}

export interface OptionChainMeta {
  capturedAt: string        // ISO 8601
  capturedAtPrice: number
  currentPrice: number | null
  priceDelta: string        // e.g. "0.11%"
  cacheHit: boolean
}

// Raw Tastytrade API types — includes all known Greek field names
interface TastyLeg {
  symbol: string
  bid?: number
  ask?: number
  delta?: number | string | null
  gamma?: number | string | null
  theta?: number | string | null
  vega?: number | string | null
  'implied-volatility'?: number | string | null
}

interface OptionChainCache {
  data: OptionExpiry[]
  capturedAt: number       // Date.now()
  capturedAtPrice: number  // marketState.spy.last at capture time
  ttlMs: number
}

let optionChainCache: OptionChainCache | null = null
const CACHE_TTL = 5 * 60_000 // 5 minutes
const PRICE_MOVE_THRESHOLD = CONFIG.OPTION_CHAIN_THRESHOLD // default: 0.003 (0.3%)

/** Returns the ms-epoch timestamp of the last successful option chain fetch, or 0 if never fetched. */
export function getOptionChainCapturedAt(): number {
  return optionChainCache?.capturedAt ?? 0
}

// ─── Market-hours helpers ─────────────────────────────────────────────────────

function isDst(date: Date): boolean {
  // Simplified DST detection: US observes DST from second Sunday of March
  // through first Sunday of November.
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset()
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset()
  return date.getTimezoneOffset() < Math.max(jan, jul)
}

function isMarketOpen(): boolean {
  const now = new Date()
  const day = now.getUTCDay() // 0 = Sun, 6 = Sat
  if (day === 0 || day === 6) return false
  const etOffset = isDst(now) ? -4 : -5
  const etMinutes = (now.getUTCHours() + etOffset) * 60 + now.getUTCMinutes()
  return etMinutes >= 570 && etMinutes < 960 // 09:30–16:00 ET
}

// ─── Cache staleness ──────────────────────────────────────────────────────────

function isCacheStale(): boolean {
  if (!optionChainCache) return true

  const ageMs = Date.now() - optionChainCache.capturedAt
  if (ageMs > optionChainCache.ttlMs) return true

  // Outside market hours: rely only on TTL, skip price-move check
  if (!isMarketOpen()) return false

  const currentPrice = marketState.spy.last
  if (!currentPrice || !optionChainCache.capturedAtPrice) return false

  const priceDelta = Math.abs(
    (currentPrice - optionChainCache.capturedAtPrice) / optionChainCache.capturedAtPrice
  )

  if (priceDelta > PRICE_MOVE_THRESHOLD) {
    console.info(
      `[OptionChain] Cache invalidado: SPY moveu ${(priceDelta * 100).toFixed(2)}%` +
      ` (${optionChainCache.capturedAtPrice} → ${currentPrice})`
    )
    return true
  }

  return false
}

// ─── Greeks helpers ───────────────────────────────────────────────────────────

/** Parse a Greek value that Tastytrade may return as number, string, "NaN", or null. */
function parseGreek(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  const n = typeof raw === 'string' ? parseFloat(raw) : raw
  return isFinite(n) ? n : null
}

/** Read Fed Funds Rate from FRED snapshot; fallback to 5.3% if unavailable. */
function getRiskFreeRate(): number {
  const dff = newsSnapshot.macro.find((m) => m.seriesId === 'DFF')
  if (dff?.value !== null && dff?.value !== undefined && isFinite(dff.value)) {
    return dff.value / 100
  }
  return 0.053
}

/**
 * Enrich a single option leg with Greeks.
 * Priority: API greeks → Black-Scholes fallback.
 */
function enrichLeg(
  rawLeg: TastyLeg,
  strike: number,
  dte: number,
  type: 'call' | 'put',
  S: number,
  r: number,
  sigmaFallback: number,
): OptionLeg {
  const iv = parseGreek(rawLeg['implied-volatility'])
  const apiDelta = parseGreek(rawLeg.delta)
  const apiGamma = parseGreek(rawLeg.gamma)
  const apiTheta = parseGreek(rawLeg.theta)
  const apiVega = parseGreek(rawLeg.vega)

  const hasApiGreeks =
    apiDelta !== null && apiGamma !== null && apiTheta !== null && apiVega !== null

  // Clamp 0DTE to half a trading day to avoid division by zero in BS formulas
  const T = dte <= 0 ? 0.5 / 365 : dte / 365
  const sigma = iv !== null && iv > 0 ? iv : sigmaFallback

  let delta: number | null
  let gamma: number | null
  let theta: number | null
  let vega: number | null
  let greeksSource: 'api' | 'calculated' | null

  if (hasApiGreeks) {
    delta = apiDelta
    gamma = apiGamma
    theta = apiTheta
    vega = apiVega
    greeksSource = 'api'
  } else if (S > 0 && strike > 0) {
    delta = calcDelta(S, strike, T, r, sigma, type)
    gamma = calcGamma(S, strike, T, r, sigma)
    theta = calcTheta(S, strike, T, r, sigma, type)
    vega = calcVega(S, strike, T, r, sigma)
    greeksSource = 'calculated'
  } else {
    delta = null
    gamma = null
    theta = null
    vega = null
    greeksSource = null
  }

  return {
    symbol: rawLeg.symbol,
    strike,
    bid: rawLeg.bid ?? null,
    ask: rawLeg.ask ?? null,
    volume: null,
    openInterest: null,
    iv,
    delta,
    gamma,
    theta,
    vega,
    greeksSource,
  }
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

async function fetchOptionChain(): Promise<OptionExpiry[]> {
  const token = await ensureAccessToken()
  const res = await fetch(`${CONFIG.TT_BASE}/option-chains/SPY/nested`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })

  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const json = (await res.json()) as {
    data?: {
      items?: Array<{
        'expiration-date': string
        'days-to-expiration': number
        strikes?: Array<{
          strike: number | string
          call?: TastyLeg
          put?: TastyLeg
        }>
      }>
    }
  }

  const items = json.data?.items ?? []
  const targetDTEs = [0, 1, 7, 21, 45]

  // Shared context for enrichment — captured once per fetch
  const S = marketState.spy.last ?? 0
  const r = getRiskFreeRate()
  const sigmaFallback =
    marketState.vix.last !== null && marketState.vix.last > 0
      ? marketState.vix.last / 100
      : 0.18

  const chain = items
    .filter((exp) => {
      const dte = exp['days-to-expiration']
      return targetDTEs.some((t) => Math.abs(dte - t) <= 3)
    })
    .map((exp) => {
      const dte = exp['days-to-expiration']
      let apiCount = 0
      let calcCount = 0

      const calls = (exp.strikes ?? [])
        .filter((s) => s.call)
        .map((s) => {
          const leg = enrichLeg(s.call!, Number(s.strike), dte, 'call', S, r, sigmaFallback)
          if (leg.greeksSource === 'api') apiCount++
          else if (leg.greeksSource === 'calculated') calcCount++
          return leg
        })

      const puts = (exp.strikes ?? [])
        .filter((s) => s.put)
        .map((s) => enrichLeg(s.put!, Number(s.strike), dte, 'put', S, r, sigmaFallback))

      console.log(
        `[OptionChain] DTE=${dte} greeks: api=${apiCount}/${calls.length} ` +
        `calculated=${calcCount} sigma=${(sigmaFallback * 100).toFixed(1)}% r=${(r * 100).toFixed(2)}%`
      )

      // ATM delta sanity check
      if (dte > 0 && S > 0) {
        const atmCalls = calls.filter(
          (c) => Math.abs(c.strike - S) < 1.5 && c.delta !== null
        )
        for (const c of atmCalls) {
          if (Math.abs(c.delta! - 0.50) > 0.10) {
            console.warn(
              `[OptionChain] ATM delta warning: strike=${c.strike} SPY=${S.toFixed(2)} ` +
              `delta=${c.delta?.toFixed(3)} source=${c.greeksSource} sigma=${(sigmaFallback * 100).toFixed(1)}%`
            )
          }
        }
      }

      return {
        dte,
        expirationDate: exp['expiration-date'],
        calls,
        puts,
      }
    })

  console.log(`[OptionChain] Fetched ${chain.length} expiries`)
  return chain
}

export async function getOptionChain(): Promise<{ data: OptionExpiry[]; meta: OptionChainMeta }> {
  const cacheHit = !isCacheStale()

  if (!cacheHit) {
    try {
      const fresh = await fetchOptionChain()
      optionChainCache = {
        data: fresh,
        capturedAt: Date.now(),
        capturedAtPrice: marketState.spy.last ?? 0,
        ttlMs: CACHE_TTL,
      }
    } catch (err) {
      console.error('[OptionChain] Error fetching chain:', (err as Error).message)
      // Fallback: keep stale cache rather than returning empty
    }
  }

  const cache = optionChainCache
  const currentPrice = marketState.spy.last
  const capturedAtPrice = cache?.capturedAtPrice ?? 0
  const priceDeltaRatio =
    currentPrice && capturedAtPrice
      ? Math.abs((currentPrice - capturedAtPrice) / capturedAtPrice)
      : 0

  return {
    data: cache?.data ?? [],
    meta: {
      capturedAt: cache
        ? new Date(cache.capturedAt).toISOString()
        : new Date().toISOString(),
      capturedAtPrice,
      currentPrice,
      priceDelta: `${(priceDeltaRatio * 100).toFixed(2)}%`,
      cacheHit,
    },
  }
}

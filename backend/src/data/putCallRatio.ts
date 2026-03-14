import { getTradierClient } from '../lib/tradierClient'
import { resolveNearestExpiration } from './gexService'
import { CONFIG } from '../config'
import { cacheGet, cacheSet } from '../lib/cacheStore'
import type { PutCallRatioEntry, PutCallRatioMulti } from '../types/market'

const CACHE_TTL_MS = 90_000  // 90s
const cacheKey = (symbol: string) => `put_call_ratio:${symbol}`

export interface PutCallRatioResult {
  ratio: number              // putVolume / callVolume (volume-based, lagging)
  putVolume: number
  callVolume: number
  label: 'bearish' | 'neutral' | 'bullish'
  /** OI-based ratio: putOI / callOI (structural — posições acumuladas, não apenas fluxo intraday) */
  oiRatio: number | null
  putOI: number
  callOI: number
  oiLabel: 'bearish' | 'neutral' | 'bullish'
  /**
   * Concordância entre volume E OI.
   * extreme_bearish: ambos bearish | extreme_bullish: ambos bullish
   * Caso contrário: usa o sinal mais forte individualmente.
   */
  combined: 'extreme_bearish' | 'bearish' | 'neutral' | 'bullish' | 'extreme_bullish'
  expiration: string         // YYYY-MM-DD used
  calculatedAt: string       // ISO 8601
}

function classifyRatio(ratio: number): 'bearish' | 'neutral' | 'bullish' {
  if (ratio > 1.2) return 'bearish'
  if (ratio < 0.7) return 'bullish'
  return 'neutral'
}

function classifyOIRatio(ratio: number): 'bearish' | 'neutral' | 'bullish' {
  if (ratio > 1.1) return 'bearish'
  if (ratio < 0.9) return 'bullish'
  return 'neutral'
}

function combinedLabel(
  vol: 'bearish' | 'neutral' | 'bullish',
  oi: 'bearish' | 'neutral' | 'bullish',
): PutCallRatioResult['combined'] {
  if (vol === 'bearish' && oi === 'bearish') return 'extreme_bearish'
  if (vol === 'bullish' && oi === 'bullish') return 'extreme_bullish'
  if (vol === 'bearish' || oi === 'bearish') return 'bearish'
  if (vol === 'bullish' || oi === 'bullish') return 'bullish'
  return 'neutral'
}

/** Returns the next weekday date string (YYYY-MM-DD) on or after today */
function nextWeekday(date: Date): string {
  const d = new Date(date)
  const day = d.getUTCDay()
  if (day === 0) d.setUTCDate(d.getUTCDate() + 1) // Sunday → Monday
  if (day === 6) d.setUTCDate(d.getUTCDate() + 2) // Saturday → Monday
  return d.toISOString().slice(0, 10)
}

/** Third Friday of the given month (UTC) */
function thirdFriday(year: number, month: number): string {
  // month is 0-based
  const d = new Date(Date.UTC(year, month, 1))
  // advance to first Friday
  const offset = (5 - d.getUTCDay() + 7) % 7
  d.setUTCDate(1 + offset + 14) // +14 = third Friday
  return d.toISOString().slice(0, 10)
}

/** Returns target expiration dates: [0DTE, Semanal, Mensal] deduplicated */
function resolveTargetExpirations(availableExpirations: string[]): {
  tier: PutCallRatioEntry['tier']
  expiration: string
}[] {
  const todayUTC = new Date()
  const todayStr = todayUTC.toISOString().slice(0, 10)
  const weekStr = new Date(todayUTC.getTime() + 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)

  // 0DTE: today if weekday, else next weekday
  const odteStr = nextWeekday(todayUTC)

  // Semanal: nearest available <= 7 days from today
  const weekly =
    availableExpirations.find((d) => d > todayStr && d <= weekStr) ??
    availableExpirations.find((d) => d > todayStr) ??
    null

  // Mensal: third friday of current month, or next month if already passed
  const year = todayUTC.getUTCFullYear()
  const month = todayUTC.getUTCMonth()
  let monthlyStr = thirdFriday(year, month)
  if (monthlyStr < todayStr) {
    monthlyStr = thirdFriday(year, month + 1)
  }
  // snap to nearest available expiration
  const monthly =
    availableExpirations.find((d) => d === monthlyStr) ??
    availableExpirations.find((d) => d >= monthlyStr) ??
    null

  const seen = new Set<string>()
  const result: { tier: PutCallRatioEntry['tier']; expiration: string }[] = []

  for (const [tier, exp] of [
    ['0DTE', odteStr],
    ['Semanal', weekly],
    ['Mensal', monthly],
  ] as const) {
    if (exp && availableExpirations.includes(exp) && !seen.has(exp)) {
      seen.add(exp)
      result.push({ tier: tier as PutCallRatioEntry['tier'], expiration: exp })
    }
  }

  return result
}

function toSentimentLabel(ratio: number): PutCallRatioEntry['sentimentLabel'] {
  if (ratio < 0.7) return 'bullish'
  if (ratio > 1.2) return 'bearish'
  return 'neutral'
}

export async function calculateMultiExpirationPCR(
  symbol: string,
): Promise<PutCallRatioMulti> {
  // Use CONFIG.TRADIER_API_KEY — same guard pattern as calculatePutCallRatio
  if (!CONFIG.TRADIER_API_KEY) {
    console.warn('[PutCallRatio] TRADIER_API_KEY not set — skipping multi-PCR')
    return { entries: [], lastUpdated: Date.now() }
  }

  const client = getTradierClient()

  // Fetch available expirations
  let expirations: string[] = []
  try {
    expirations = await client.getExpirations(symbol)
  } catch (err) {
    console.error('[PutCallRatio] Failed to fetch expirations:', err)
    return { entries: [], lastUpdated: Date.now() }
  }

  // Sort expirations ascending — Tradier order is not guaranteed
  expirations.sort()

  const targets = resolveTargetExpirations(expirations)
  if (targets.length === 0) {
    return { entries: [], lastUpdated: Date.now() }
  }

  // Fetch each expiration in parallel — failures don't block others
  const results = await Promise.allSettled(
    targets.map(async ({ tier, expiration }) => {
      const cacheKey = `put_call_ratio:${symbol}:${expiration}`
      const cached = await cacheGet<PutCallRatioEntry>(cacheKey)
      if (cached) return cached

      const chain = await client.getOptionChain(symbol, expiration)
      if (!chain || chain.length === 0) return null

      let putVolume = 0
      let callVolume = 0
      for (const leg of chain) {
        if (leg.option_type === 'put') putVolume += leg.volume ?? 0
        else callVolume += leg.volume ?? 0
      }

      if (putVolume + callVolume === 0) return null

      const ratio = callVolume === 0 ? 999 : putVolume / callVolume
      const entry: PutCallRatioEntry = {
        tier,
        expiration,
        ratio: Math.round(ratio * 100) / 100,
        putVolume,
        callVolume,
        sentimentLabel: toSentimentLabel(ratio),
      }

      await cacheSet(cacheKey, entry, 90 * 1000, 'put-call-ratio-multi')
      return entry
    }),
  )

  const entries: PutCallRatioEntry[] = results
    .filter(
      (r): r is PromiseFulfilledResult<PutCallRatioEntry | null> =>
        r.status === 'fulfilled' && r.value !== null,
    )
    .map((r) => r.value as PutCallRatioEntry)

  console.log(
    `[PutCallRatio] Multi-PCR: ${entries.map((e) => `${e.tier}=${e.ratio}`).join(', ')}`,
  )

  return { entries, lastUpdated: Date.now() }
}

export async function calculatePutCallRatio(symbol: string): Promise<PutCallRatioResult | null> {
  if (!CONFIG.TRADIER_API_KEY) {
    console.warn('[PutCallRatio] TRADIER_API_KEY not set — skipping P/C calculation')
    return null
  }

  const cached = await cacheGet<PutCallRatioResult>(cacheKey(symbol))
  if (cached) return cached

  const expiration = await resolveNearestExpiration(symbol)
  if (!expiration) {
    console.error('[PutCallRatio] No expiration found for', symbol)
    return null
  }

  const options = await getTradierClient().getOptionChain(symbol, expiration)
  if (!options || options.length === 0) {
    console.error(`[PutCallRatio] Empty option chain for ${symbol} ${expiration}`)
    return null
  }

  let putVolume = 0
  let callVolume = 0
  let putOI = 0
  let callOI = 0
  for (const opt of options) {
    if (opt.option_type === 'put') {
      putVolume += opt.volume ?? 0
      putOI += opt.open_interest ?? 0
    }
    if (opt.option_type === 'call') {
      callVolume += opt.volume ?? 0
      callOI += opt.open_interest ?? 0
    }
  }

  if (putVolume + callVolume === 0) {
    console.warn(
      `[PutCallRatio] ${symbol} ${expiration}: volume=0 em todos os contratos — ` +
      `mercado fechado ou Tradier sem dados de volume para esta expiração. Descartando resultado.`,
    )
    return null
  }

  const ratio = callVolume > 0 ? Math.round((putVolume / callVolume) * 1000) / 1000 : 0
  const label = classifyRatio(ratio)

  const oiRatio = callOI > 0 ? Math.round((putOI / callOI) * 1000) / 1000 : null
  const oiLabel = oiRatio != null ? classifyOIRatio(oiRatio) : 'neutral'
  const combined = combinedLabel(label, oiLabel)

  console.log(
    `[PutCallRatio] ${symbol} ${expiration}: vol=${ratio} (${label}) ` +
    `oi=${oiRatio ?? 'n/a'} (${oiLabel}) combined=${combined} ` +
    `puts=${putVolume.toLocaleString('en-US')} calls=${callVolume.toLocaleString('en-US')} ` +
    `putOI=${putOI.toLocaleString('en-US')} callOI=${callOI.toLocaleString('en-US')}`,
  )

  const result: PutCallRatioResult = {
    ratio,
    putVolume,
    callVolume,
    label,
    oiRatio,
    putOI,
    callOI,
    oiLabel,
    combined,
    expiration,
    calculatedAt: new Date().toISOString(),
  }
  await cacheSet(cacheKey(symbol), result, CACHE_TTL_MS, 'put-call-ratio')
  return result
}

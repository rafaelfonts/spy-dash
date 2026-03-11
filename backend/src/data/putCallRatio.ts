import { getTradierClient } from '../lib/tradierClient'
import { resolveNearestExpiration } from './gexService'
import { CONFIG } from '../config'
import { cacheGet, cacheSet } from '../lib/cacheStore'

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

import { getTradierClient } from '../lib/tradierClient'
import { resolveNearestExpiration } from './gexService'
import { CONFIG } from '../config'
import { cacheGet, cacheSet } from '../lib/cacheStore'

const CACHE_TTL_MS = 90_000  // 90s
const cacheKey = (symbol: string) => `put_call_ratio:${symbol}`

export interface PutCallRatioResult {
  ratio: number              // putVolume / callVolume (0 if callVolume === 0)
  putVolume: number
  callVolume: number
  label: 'bearish' | 'neutral' | 'bullish'
  expiration: string         // YYYY-MM-DD used
  calculatedAt: string       // ISO 8601
}

function classifyRatio(ratio: number): 'bearish' | 'neutral' | 'bullish' {
  if (ratio > 1.2) return 'bearish'
  if (ratio < 0.7) return 'bullish'
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
  for (const opt of options) {
    if (opt.option_type === 'put')  putVolume  += opt.volume ?? 0
    if (opt.option_type === 'call') callVolume += opt.volume ?? 0
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

  console.log(
    `[PutCallRatio] ${symbol} ${expiration}: ratio=${ratio} (${label}) ` +
    `puts=${putVolume.toLocaleString('en-US')} calls=${callVolume.toLocaleString('en-US')}`,
  )

  const result: PutCallRatioResult = {
    ratio,
    putVolume,
    callVolume,
    label,
    expiration,
    calculatedAt: new Date().toISOString(),
  }
  await cacheSet(cacheKey(symbol), result, CACHE_TTL_MS, 'put-call-ratio')
  return result
}

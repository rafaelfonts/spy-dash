// backend/src/lib/geopoliticalOverlay.ts
import { getTradierClient } from './tradierClient.js'
import { cacheGet, cacheSet } from './cacheStore.js'
import { getDailyContext } from '../data/equityDailyBarsCache.js'
import type { GeopoliticalOverlay } from '../types/market.js'

const TTL_MS = 30 * 60 * 1000  // 30min
const CACHE_KEY = 'geoRisk:overlay'

// Symbols used as geopolitical proxies
const GEO_SYMBOLS = ['GLD', 'UUP', 'ITA', 'SPY'] as const

function zScore20(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length
  const std = Math.sqrt(variance)
  if (std === 0) return 0
  return (values[values.length - 1] - mean) / std
}

export async function calcGeopoliticalOverlay(): Promise<GeopoliticalOverlay> {
  const cached = await cacheGet<GeopoliticalOverlay>(CACHE_KEY)
  if (cached) return cached

  const tradier = getTradierClient()
  const quotes = await tradier.getQuotes([...GEO_SYMBOLS]).catch(() => [])

  const getPrice = (sym: string) => quotes.find((q) => q.symbol === sym)?.last ?? null

  const gldPrice = getPrice('GLD')
  const spyPrice = getPrice('SPY')
  const uupPrice = getPrice('UUP')

  // Daily context for Z-score calculations
  const gldCtx = getDailyContext('GLD')
  const spyCtx = getDailyContext('SPY')
  const uupCtx = getDailyContext('UUP')
  const itaCtx = getDailyContext('ITA')

  // goldVsSpy: GLD/SPY ratio Z-score (20D)
  let goldVsSpy = 0
  if (gldCtx && spyCtx && gldCtx.bars.length >= 20 && spyCtx.bars.length >= 20) {
    const minLen = Math.min(gldCtx.bars.length, spyCtx.bars.length)
    const ratios = gldCtx.bars.slice(-minLen).map((b, i) => b.close / (spyCtx.bars.slice(-minLen)[i].close || 1))
    goldVsSpy = zScore20(ratios.slice(-20))
  } else if (gldPrice && spyPrice && spyPrice > 0) {
    goldVsSpy = gldPrice / spyPrice
  }

  // usdStrength: UUP Z-score of closes (20D)
  let usdStrength = 0
  if (uupCtx && uupCtx.bars.length >= 20) {
    usdStrength = zScore20(uupCtx.bars.slice(-20).map((b) => b.close))
  }

  // defenseVsCivilian: ITA Z-score of closes (20D)
  let defenseVsCivilian = 0
  if (itaCtx && itaCtx.bars.length >= 20) {
    defenseVsCivilian = zScore20(itaCtx.bars.slice(-20).map((b) => b.close))
  }

  // vixVvix: use SPY ATR/SMA as proxy (VVIX not in Tradier)
  const vixVvix = spyCtx && spyCtx.sma20 > 0
    ? Math.min(spyCtx.atr14 / spyCtx.sma20 * 100, 3)
    : 0

  // Composite geoRiskScore (0–100)
  const raw = goldVsSpy * 0.35 + usdStrength * 0.25 + defenseVsCivilian * 0.25 + vixVvix * 0.15
  const geoRiskScore = Math.round(Math.max(0, Math.min(100, raw * 50 + 50)))

  const overlay: GeopoliticalOverlay = {
    goldVsSpy,
    usdStrength,
    defenseVsCivilian,
    vixVvix,
    geoRiskScore,
    fetchedAt: Date.now(),
  }

  await cacheSet(CACHE_KEY, overlay, TTL_MS, 'geopoliticalOverlay')
  return overlay
}

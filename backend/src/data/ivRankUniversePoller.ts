import { CONFIG } from '../config'
import { ensureAccessToken } from '../auth/tokenManager'
import { cacheSet } from '../lib/cacheStore'
import { ALL_TICKERS } from '../types/optionScreener'
import type { IVRankData } from '../types/market'

const POLL_INTERVAL = 15 * 60 * 1000 // 15 minutes
const BATCH_SIZE = 10
const CACHE_TTL_MS = 14 * 60 * 60 * 1000 // 14h

const cacheKey = (symbol: string) => `ivrank:universe:${symbol}`

const _ivRankCache = new Map<string, IVRankData>()

function toFloat(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : parseFloat(v as string)
  return isFinite(n) ? n : null
}

function ivRankLabel(rank: number): 'low' | 'medium' | 'high' {
  if (rank < 30) return 'low'
  if (rank <= 70) return 'medium'
  return 'high'
}

export function getUniverseIVRank(symbol: string): IVRankData | null {
  return _ivRankCache.get(symbol) ?? null
}

async function pollBatch(batch: string[]): Promise<void> {
  try {
    const token = await ensureAccessToken()
    const res = await fetch(
      `${CONFIG.TT_BASE}/market-metrics?symbols=${batch.join(',')}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'SPYDash/1.0',
        },
      }
    )
    if (!res.ok) {
      const text = await res.text()
      console.warn(
        `[IVRankUniversePoller] HTTP ${res.status} para batch [${batch.join(',')}]: ${text.slice(0, 100)}`
      )
      return
    }
    const json = (await res.json()) as {
      data?: { items?: Array<Record<string, unknown>> }
    }
    const items = json.data?.items ?? []

    for (const item of items) {
      const symbol = typeof item['symbol'] === 'string' ? item['symbol'] : null
      if (!symbol) continue

      const ivRank =
        toFloat(item['implied-volatility-index-rank']) ??
        toFloat(item['tw-implied-volatility-index-rank'])
      if (ivRank === null) continue

      const ivPercentile = toFloat(item['implied-volatility-percentile'])
      const ivxRaw = toFloat(item['implied-volatility-index'])
      const hv30Raw = toFloat(item['hv-30-day'])

      const value = ivRank * 100
      const payload: IVRankData = {
        value,
        percentile: ivPercentile !== null ? ivPercentile * 100 : null,
        ivx: ivxRaw !== null ? ivxRaw * 100 : null,
        hv30: hv30Raw !== null ? hv30Raw * 100 : null,
        label: ivRankLabel(value),
        lastUpdated: Date.now(),
      }

      _ivRankCache.set(symbol, payload)
      await cacheSet(cacheKey(symbol), payload, CACHE_TTL_MS, 'tastytrade')
    }
  } catch (err) {
    console.warn(
      `[IVRankUniversePoller] Erro no batch [${batch.join(',')}]:`,
      (err as Error).message
    )
  }
}

export async function pollUniverseIVRank(): Promise<void> {
  const tickers = ALL_TICKERS
  const batches: string[][] = []
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    batches.push(tickers.slice(i, i + BATCH_SIZE))
  }

  for (const batch of batches) {
    await pollBatch(batch)
  }

  console.log(
    `[IVRankUniversePoller] Populado: ${_ivRankCache.size} tickers`
  )
}

export function startIVRankUniversePoller(): void {
  setTimeout(() => {
    pollUniverseIVRank().catch(console.error)
    setInterval(() => pollUniverseIVRank().catch(console.error), POLL_INTERVAL)
  }, 30_000)
}

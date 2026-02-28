import { CONFIG } from '../config'
import { ensureAccessToken } from '../auth/tokenManager'
import { updateIVRank } from './marketState'
import { cacheGet, cacheSet } from '../lib/cacheStore'

const POLL_INTERVAL = 60_000
const CACHE_KEY = 'ivrank_snapshot'
const CACHE_TTL_MS = 90_000  // 90s = 60s × 1.5

// API returns numeric fields as strings (e.g. "0.128494281") — parse explicitly.
function toFloat(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : parseFloat(v as string)
  return isFinite(n) ? n : null
}

async function pollIVRank(): Promise<void> {
  try {
    const cached = await cacheGet<{ value: number; percentile: number | null; ivx: number | null }>(CACHE_KEY)
    if (cached) {
      updateIVRank(cached)
      return
    }

    const token = await ensureAccessToken()

    const res = await fetch(`${CONFIG.TT_BASE}/market-metrics?symbols=SPY`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'SPYDash/1.0',
      },
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 100)}`)
    }

    const json = (await res.json()) as {
      data?: { items?: Array<Record<string, unknown>> }
    }

    const item = json.data?.items?.[0]
    if (!item) return

    // Preference order: TW methodology > raw rank field.
    const ivRank = toFloat(item['tw-implied-volatility-index-rank'])
      ?? toFloat(item['implied-volatility-index-rank'])

    const ivPercentile = toFloat(item['implied-volatility-percentile'])

    // IVx — Tastytrade composite implied volatility index (absolute level, 0–1 decimal → %)
    const ivxRaw = toFloat(item['implied-volatility-index'])

    // Diagnostic log — raw IV fields from Tastytrade /market-metrics
    console.log('[IVRankPoller] Raw fields:', {
      'implied-volatility-index': item['implied-volatility-index'],
      'implied-volatility-index-rank': item['implied-volatility-index-rank'],
      'tw-implied-volatility-index-rank': item['tw-implied-volatility-index-rank'],
      'implied-volatility-percentile': item['implied-volatility-percentile'],
    })

    if (ivRank !== null) {
      const payload = {
        value: ivRank * 100,
        percentile: ivPercentile !== null ? ivPercentile * 100 : null,
        ivx: ivxRaw !== null ? ivxRaw * 100 : null,
      }
      updateIVRank(payload)
      await cacheSet(CACHE_KEY, payload, CACHE_TTL_MS, 'tastytrade')
      console.log(
        `[IVRankPoller] IV Rank: ${payload.value.toFixed(1)}%` +
        ` | IVx: ${payload.ivx !== null ? payload.ivx.toFixed(1) : 'N/A'}`,
      )
    }
  } catch (err) {
    console.error('[IVRankPoller] Error:', (err as Error).message)
  }
}

export function startIVRankPoller(): void {
  // Poll immediately, then every 60s
  pollIVRank().catch(console.error)
  setInterval(() => pollIVRank().catch(console.error), POLL_INTERVAL)
}

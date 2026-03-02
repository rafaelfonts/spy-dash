import { CONFIG } from '../config'
import { ensureAccessToken } from '../auth/tokenManager'
import { updateIVRank } from './marketState'
import { cacheSet } from '../lib/cacheStore'

const POLL_INTERVAL = 60_000
const CACHE_KEY = 'ivrank_snapshot'
const CACHE_TTL_MS = 14 * 60 * 60 * 1000  // 14h — survives overnight/weekend (IV Rank changes on daily cadence)

// API returns numeric fields as strings (e.g. "0.128494281") — parse explicitly.
function toFloat(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : parseFloat(v as string)
  return isFinite(n) ? n : null
}

async function pollIVRank(): Promise<void> {
  try {
    // Always call the API — cache is for startup restore (restoreCache.ts) and error fallback only.
    // A 14h TTL + early-return would freeze the value for the entire trading day.
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

    // Standard IVR (52-week high/low formula — matches Tastytrade UI) preferred over TW proprietary rank.
    const ivRank = toFloat(item['implied-volatility-index-rank'])
      ?? toFloat(item['tw-implied-volatility-index-rank'])

    const ivPercentile = toFloat(item['implied-volatility-percentile'])

    // IVx — Tastytrade composite implied volatility index (absolute level, 0–1 decimal → %)
    const ivxRaw = toFloat(item['implied-volatility-index'])

    const hv30Raw = toFloat(item['hv-30-day'])

    // Diagnostic log — both rank fields side-by-side for verification
    console.log('[IVRankPoller] Raw fields:', {
      'implied-volatility-index': item['implied-volatility-index'],
      'implied-volatility-index-rank': item['implied-volatility-index-rank'],
      'tw-implied-volatility-index-rank': item['tw-implied-volatility-index-rank'],
      'implied-volatility-percentile': item['implied-volatility-percentile'],
      'hv-30-day': item['hv-30-day'],
    })

    if (ivRank !== null) {
      const payload = {
        value: ivRank * 100,
        percentile: ivPercentile !== null ? ivPercentile * 100 : null,
        ivx: ivxRaw !== null ? ivxRaw * 100 : null,
        hv30: hv30Raw !== null ? hv30Raw * 100 : null,
      }
      updateIVRank(payload)
      await cacheSet(CACHE_KEY, payload, CACHE_TTL_MS, 'tastytrade')
      console.log(
        `[IVRankPoller] IV Rank: ${payload.value.toFixed(1)}%` +
        ` | IVx: ${payload.ivx !== null ? payload.ivx.toFixed(1) : 'N/A'}` +
        ` | HV30: ${payload.hv30 !== null ? payload.hv30.toFixed(1) : 'N/A'}%`,
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

import { CONFIG } from '../config'
import { ensureAccessToken } from '../auth/tokenManager'
import { updateIVRank } from './marketState'

const POLL_INTERVAL = 60_000

// API returns numeric fields as strings (e.g. "0.128494281") — parse explicitly.
function toFloat(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : parseFloat(v as string)
  return isFinite(n) ? n : null
}

async function pollIVRank(): Promise<void> {
  try {
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

    if (ivRank !== null) {
      updateIVRank({
        value: ivRank * 100,
        percentile: ivPercentile !== null ? ivPercentile * 100 : null,
      })
      console.log(`[IVRankPoller] IV Rank: ${(ivRank * 100).toFixed(1)}%`)
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

import { emitter, newsSnapshot } from './marketState'
import type { FearGreedData, FearGreedApiResponse } from '../types/market'
import { FearGreedApiSchema } from '../types/market'
import { createBreaker } from '../lib/circuitBreaker'
import { cacheGet, cacheSet } from '../lib/cacheStore'

const POLL_INTERVAL = 4 * 60 * 60 * 1000 // 4 hours
const CACHE_KEY = 'fear_greed'
const CACHE_TTL = 15_840_000 // POLL_INTERVAL * 1.1
const FEAR_GREED_URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata'

// Last successfully validated and transformed data — used as fallback when API fails
let lastValidFearGreed: FearGreedData | null = null

const fetchBreaker = createBreaker(
  async () => {
    const res = await fetch(FEAR_GREED_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SPYDash/1.0)',
        Accept: 'application/json',
        Referer: 'https://edition.cnn.com/',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json() as Promise<unknown>
  },
  'cnn',
  { resetTimeout: 120_000 }, // CNN endpoint is unofficial — retry after 2 min
)

async function pollFearGreed(): Promise<void> {
  const cached = await cacheGet<FearGreedData>(CACHE_KEY)
  if (cached) {
    newsSnapshot.fearGreed = cached
    emitter.emit('newsfeed', { type: 'sentiment', fearGreed: cached, ts: Date.now() })
    return
  }

  const raw = (await fetchBreaker.fire()) as FearGreedApiResponse | null

  if (!raw) {
    // CB fallback: circuit is OPEN or fetch failed — use last valid data
    if (lastValidFearGreed !== null) {
      newsSnapshot.fearGreed = lastValidFearGreed
      emitter.emit('newsfeed', {
        type: 'sentiment',
        fearGreed: lastValidFearGreed,
        ts: Date.now(),
        _stale: true,
      })
      console.warn('[FearGreed] Usando dados em cache (último válido)')
    }
    return
  }

  const parsed = FearGreedApiSchema.safeParse(raw)
  if (!parsed.success) {
    console.error('[FearGreed] Schema inválido:', parsed.error.format())
    console.error('[FearGreed] Payload recebido:', JSON.stringify(raw).slice(0, 500))
    if (lastValidFearGreed !== null) {
      newsSnapshot.fearGreed = lastValidFearGreed
      emitter.emit('newsfeed', {
        type: 'sentiment',
        fearGreed: lastValidFearGreed,
        ts: Date.now(),
        _stale: true,
      })
    }
    return
  }

  const fg = parsed.data.fear_and_greed
  const data: FearGreedData = {
    score: Math.round(fg.score),
    label: fg.rating,
    previousClose: typeof fg.previous_close === 'number' ? Math.round(fg.previous_close) : null,
    lastUpdated: Date.now(),
  }

  lastValidFearGreed = data
  newsSnapshot.fearGreed = data
  await cacheSet(CACHE_KEY, data, CACHE_TTL, 'cnn')
  emitter.emit('newsfeed', { type: 'sentiment', fearGreed: data, ts: Date.now() })
  console.log(`[FearGreed] Score: ${data.score} — ${data.label}`)
}

export function startFearGreedPoller(): void {
  pollFearGreed().catch(console.error)
  setInterval(() => pollFearGreed().catch(console.error), POLL_INTERVAL)
}

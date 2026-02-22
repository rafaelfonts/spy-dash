import { CONFIG } from '../config'
import { emitter, newsSnapshot } from './marketState'
import type { NewsHeadline, GNewsApiResponse } from '../types/market'
import { GNewsResponseSchema } from '../types/market'
import { createBreaker } from '../lib/circuitBreaker'
import { cacheGet, cacheSet } from '../lib/cacheStore'

// 30-min interval → 48 req/day, well within the 100 req/day free limit
const POLL_INTERVAL = 30 * 60 * 1000
const CACHE_KEY = 'gnews_headlines'
const CACHE_TTL = 1_980_000 // POLL_INTERVAL * 1.1

// Focused query for options/macro traders
const QUERY = encodeURIComponent(
  '"Federal Reserve" OR "FOMC" OR "S&P 500" OR "interest rates" OR "CPI" OR "nonfarm payrolls" OR "SPY" OR "volatility"',
)

// Last successfully validated headlines — used as fallback when API fails
let lastValidHeadlines: NewsHeadline[] | null = null

const fetchBreaker = createBreaker(
  async (url: string) => {
    const res = await fetch(url, { headers: { 'User-Agent': 'SPYDash/1.0' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json() as Promise<unknown>
  },
  'gnews',
  { resetTimeout: 3_600_000 }, // quota limited — save retries for 1h
)

async function pollNewsAggregator(): Promise<void> {
  if (!CONFIG.GNEWS_API_KEY) {
    console.warn('[NewsAggregator] GNEWS_API_KEY not set — skipping')
    return
  }

  const cached = await cacheGet<NewsHeadline[]>(CACHE_KEY)
  if (cached) {
    newsSnapshot.headlines = cached
    emitter.emit('newsfeed', { type: 'headlines', items: cached, ts: Date.now() })
    return
  }

  const url = `https://gnews.io/api/v4/search?q=${QUERY}&lang=en&country=us&max=10&token=${CONFIG.GNEWS_API_KEY}`
  const raw = (await fetchBreaker.fire(url)) as GNewsApiResponse | null

  if (!raw) {
    // CB fallback: circuit is OPEN or fetch failed
    if (lastValidHeadlines !== null) {
      newsSnapshot.headlines = lastValidHeadlines
      emitter.emit('newsfeed', {
        type: 'headlines',
        items: lastValidHeadlines,
        ts: Date.now(),
        _stale: true,
      })
      console.warn('[NewsAggregator] Usando dados em cache (último válido)')
    }
    return
  }

  const parsed = GNewsResponseSchema.safeParse(raw)
  if (!parsed.success) {
    console.error('[NewsAggregator] Schema inválido:', parsed.error.format())
    console.error('[NewsAggregator] Payload recebido:', JSON.stringify(raw).slice(0, 500))
    if (lastValidHeadlines !== null) {
      newsSnapshot.headlines = lastValidHeadlines
      emitter.emit('newsfeed', {
        type: 'headlines',
        items: lastValidHeadlines,
        ts: Date.now(),
        _stale: true,
      })
    }
    return
  }

  const articles = parsed.data.articles ?? []
  const items: NewsHeadline[] = articles
    .filter((a) => a.title && a.url)
    .map((a) => ({
      title: a.title!,
      description: a.description ?? null,
      url: a.url!,
      source: a.source?.name ?? 'Desconhecido',
      publishedAt: a.publishedAt ?? new Date().toISOString(),
      image: a.image ?? null,
    }))

  lastValidHeadlines = items
  newsSnapshot.headlines = items
  await cacheSet(CACHE_KEY, items, CACHE_TTL, 'gnews')
  emitter.emit('newsfeed', { type: 'headlines', items, ts: Date.now() })
  console.log(`[NewsAggregator] Updated: ${items.length} headlines`)
}

export function startNewsAggregator(): void {
  pollNewsAggregator().catch(console.error)
  setInterval(() => pollNewsAggregator().catch(console.error), POLL_INTERVAL)
}

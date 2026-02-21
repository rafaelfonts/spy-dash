import { CONFIG } from '../config'
import { emitter, newsSnapshot } from './marketState'
import type { NewsHeadline } from '../types/market'

// 30-min interval → 48 req/day, well within the 100 req/day free limit
const POLL_INTERVAL = 30 * 60 * 1000

// Focused query for options/macro traders
const QUERY = encodeURIComponent(
  '"Federal Reserve" OR "FOMC" OR "S&P 500" OR "interest rates" OR "CPI" OR "nonfarm payrolls" OR "SPY" OR "volatility"',
)

interface GNewsArticle {
  title?: string
  description?: string
  url?: string
  image?: string
  publishedAt?: string
  source?: { name?: string }
}

interface GNewsResponse {
  articles?: GNewsArticle[]
}

async function pollNewsAggregator(): Promise<void> {
  if (!CONFIG.GNEWS_API_KEY) {
    console.warn('[NewsAggregator] GNEWS_API_KEY not set — skipping')
    return
  }

  try {
    const url = `https://gnews.io/api/v4/search?q=${QUERY}&lang=en&country=us&max=10&token=${CONFIG.GNEWS_API_KEY}`
    const res = await fetch(url, { headers: { 'User-Agent': 'SPYDash/1.0' } })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 100)}`)
    }

    const json = (await res.json()) as GNewsResponse
    const articles = json.articles ?? []

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

    newsSnapshot.headlines = items

    emitter.emit('newsfeed', { type: 'headlines', items, ts: Date.now() })
    console.log(`[NewsAggregator] Updated: ${items.length} headlines`)
  } catch (err) {
    console.error('[NewsAggregator] Error:', (err as Error).message)
  }
}

export function startNewsAggregator(): void {
  pollNewsAggregator().catch(console.error)
  setInterval(() => pollNewsAggregator().catch(console.error), POLL_INTERVAL)
}

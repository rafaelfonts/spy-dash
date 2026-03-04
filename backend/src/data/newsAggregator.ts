import OpenAI from 'openai'
import { CONFIG } from '../config'
import { emitter, newsSnapshot } from './marketState'
import type { NewsHeadline, NewsSentiment, GNewsApiResponse } from '../types/market'
import { GNewsResponseSchema } from '../types/market'
import { createBreaker } from '../lib/circuitBreaker'
import { cacheGet, cacheSet } from '../lib/cacheStore'

const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY })

// 30-min interval → 48 req/day, well within the 100 req/day free limit
const POLL_INTERVAL = 30 * 60 * 1000
const CACHE_KEY = 'gnews_headlines'
const CACHE_TTL = 1_980_000 // POLL_INTERVAL * 1.1
const MAX_HEADLINES_TO_ENRICH = 10

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

/**
 * Uses gpt-4o-mini to add sentiment (bullish/bearish/neutral) and a one-line summary
 * per headline. Returns the same list with enriched fields; on failure returns original.
 */
async function enrichHeadlinesWithGptMini(items: NewsHeadline[]): Promise<NewsHeadline[]> {
  if (items.length === 0) return items
  const toEnrich = items.slice(0, MAX_HEADLINES_TO_ENRICH)
  const prompt = `You are a financial news analyst. For each headline below, output ONE line: the exact headline title, then a pipe, then one of: bullish, bearish, neutral, then a pipe, then a concise summary in one phrase (max 15 words). Output only these lines, one per headline, no numbering or extra text.
Headlines:
${toEnrich.map((h) => h.title).join('\n')}`

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 350,
      messages: [{ role: 'user', content: prompt }],
    })
    const raw = res.choices[0]?.message?.content?.trim() ?? ''
    const lines = raw.split('\n').filter((l) => l.includes('|'))
    const map = new Map<string, { sentiment: NewsSentiment; summary: string }>()
    for (const line of lines) {
      const parts = line.split('|').map((p) => p.trim())
      if (parts.length >= 3) {
        const title = parts[0]
        const sentiment = (parts[1].toLowerCase() === 'bullish' || parts[1].toLowerCase() === 'bearish' || parts[1].toLowerCase() === 'neutral')
          ? (parts[1].toLowerCase() as NewsSentiment)
          : 'neutral'
        const summary = parts.slice(2).join('|').trim().slice(0, 120)
        map.set(title, { sentiment, summary })
      }
    }
    return items.map((h) => {
      const en = map.get(h.title)
      if (!en) return h
      return { ...h, sentiment: en.sentiment, summary: en.summary }
    })
  } catch (err) {
    console.warn('[NewsAggregator] Enrichment failed:', (err as Error).message)
    return items
  }
}

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
  const rawItems: NewsHeadline[] = articles
    .filter((a) => a.title && a.url)
    .map((a) => ({
      title: a.title!,
      description: a.description ?? null,
      url: a.url!,
      source: a.source?.name ?? 'Desconhecido',
      publishedAt: a.publishedAt ?? new Date().toISOString(),
      image: a.image ?? null,
    }))

  const items = await enrichHeadlinesWithGptMini(rawItems)
  lastValidHeadlines = items
  newsSnapshot.headlines = items
  await cacheSet(CACHE_KEY, items, CACHE_TTL, 'gnews')
  emitter.emit('newsfeed', { type: 'headlines', items, ts: Date.now() })
  console.log(`[NewsAggregator] Updated: ${items.length} headlines (enriched)`)
}

export function startNewsAggregator(): void {
  pollNewsAggregator().catch(console.error)
  setInterval(() => pollNewsAggregator().catch(console.error), POLL_INTERVAL)
}

import { CONFIG } from '../config'
import { createBreaker } from './circuitBreaker'

export interface TavilyResult {
  title: string
  url: string
  content: string
  score: number
  published_date?: string
}

async function searchLiveNewsRaw(query: string, maxResults: number): Promise<TavilyResult[]> {
  if (!CONFIG.TAVILY_API_KEY) return []

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: CONFIG.TAVILY_API_KEY,
      query,
      max_results: maxResults,
      search_depth: 'basic',
      include_domains: ['reuters.com', 'bloomberg.com', 'wsj.com', 'cnbc.com', 'marketwatch.com', 'ft.com'],
    }),
  })

  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`)

  const data = await res.json() as { results: TavilyResult[] }
  return (data.results ?? []).filter((r) => r.score > 0.5)
}

// createBreaker fallback returns null — handled in searchLiveNews wrapper
const searchBreaker = createBreaker(searchLiveNewsRaw, 'tavily', { timeout: 8_000 })

export async function searchLiveNews(query: string, maxResults = 5): Promise<TavilyResult[]> {
  const result = await searchBreaker.fire(query, maxResults) as TavilyResult[] | null
  const results = result ?? []
  console.log(`[tavily] query="${query}" results=${results.length}`)
  return results
}

// backend/src/lib/redditClient.ts
import { redis } from './cacheStore'
import { CONFIG } from '../config'

const TOKEN_KEY = 'reddit:access_token'
const BASE_URL = 'https://oauth.reddit.com'
const AUTH_URL = 'https://www.reddit.com/api/v1/access_token'

export interface RedditPost {
  id: string
  subreddit: string
  title: string
  selftext: string
  score: number
  num_comments: number
  url: string
  created_utc: number
  author: string
}

async function getAccessToken(): Promise<string> {
  const cached = await redis.get(TOKEN_KEY)
  if (cached) return cached

  const credentials = Buffer.from(
    `${CONFIG.reddit.clientId}:${CONFIG.reddit.clientSecret}`
  ).toString('base64')

  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'User-Agent': CONFIG.reddit.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(8000),
  })

  if (!res.ok) throw new Error(`Reddit auth failed: ${res.status}`)

  const data = (await res.json()) as { access_token: string; expires_in: number }
  // Cache por 55min (token dura 60min)
  await redis.set(TOKEN_KEY, data.access_token, 'EX', 55 * 60)
  console.log(`[RedditClient] Token obtido, expira em ${data.expires_in}s`)
  return data.access_token
}

export async function fetchSubredditPosts(
  subreddit: string,
  sort: 'hot' | 'new' = 'hot',
  limit = 25
): Promise<RedditPost[]> {
  const token = await getAccessToken()
  const url = `${BASE_URL}/r/${subreddit}/${sort}?limit=${limit}&raw_json=1`

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': CONFIG.reddit.userAgent,
    },
    signal: AbortSignal.timeout(8000),
  })

  if (!res.ok) {
    console.warn(`[RedditClient] Falha ao buscar r/${subreddit}/${sort}: ${res.status}`)
    return []
  }

  const data = (await res.json()) as { data: { children: Array<{ data: unknown }> } }
  return data.data.children.map((child) => {
    const p = child.data as Record<string, unknown>
    return {
      id: String(p.id ?? ''),
      subreddit: String(p.subreddit ?? subreddit),
      title: String(p.title ?? ''),
      selftext: String(p.selftext ?? ''),
      score: Number(p.score ?? 0),
      num_comments: Number(p.num_comments ?? 0),
      url: String(p.url ?? ''),
      created_utc: Number(p.created_utc ?? 0),
      author: String(p.author ?? ''),
    }
  })
}

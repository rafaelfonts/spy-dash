import OpenAI from 'openai'
import { redis } from '../lib/cacheStore'
import { sendEmbed } from '../lib/discordClient'
import { fetchSubredditPosts, type RedditPost } from '../lib/redditClient'
import { CONFIG } from '../config'

const SEEN_POSTS_KEY = 'reddit:seen_posts'
const SEEN_POSTS_TTL_S = 24 * 60 * 60
const POLL_INTERVAL_MS = 60 * 60 * 1000
const RELEVANCE_THRESHOLD = 7

const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY })

export interface RedditPostAnalysis {
  tickers: string[]
  thesis: string
  trade_type: 'calls' | 'puts' | 'shares' | 'spread' | 'other' | 'none'
  sentiment: 'bullish' | 'bearish' | 'neutral'
  relevance_score: number
  has_specific_strikes: boolean
}

function passesHardFilter(post: RedditPost): boolean {
  return post.score >= 150 || (post.score >= 75 && post.num_comments >= 30)
}

async function isAlreadySeen(postId: string): Promise<boolean> {
  const result = await redis.sismember(SEEN_POSTS_KEY, postId)
  return result === 1
}

async function markAsSeen(postId: string): Promise<void> {
  await redis.sadd(SEEN_POSTS_KEY, postId)
  await redis.expire(SEEN_POSTS_KEY, SEEN_POSTS_TTL_S)
}

async function analyzePost(post: RedditPost): Promise<RedditPostAnalysis | null> {
  const prompt = `Analise este post do Reddit sobre trading. Extraia informações estruturadas.

Título: ${post.title}
Texto: ${post.selftext.slice(0, 1500)}
Subreddit: r/${post.subreddit}
Score: ${post.score} upvotes, ${post.num_comments} comentários

Retorne JSON com os campos:
- tickers: array de símbolos de ações/ETFs mencionados (ex: ["SPY", "NVDA"])
- thesis: resumo da tese de trade em português, 1-2 frases concisas
- trade_type: "calls" | "puts" | "shares" | "spread" | "other" | "none"
- sentiment: "bullish" | "bearish" | "neutral"
- relevance_score: inteiro 0-10 (10 = tese clara + ticker específico + raciocínio sólido; 7+ = publicar)
- has_specific_strikes: true se menciona strike e/ou expiry concretos

relevance_score >= 7 requer: tese clara, ticker identificado, raciocínio além de "vai subir/cair".`

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
    })
    const content = res.choices[0]?.message?.content
    if (!content) return null
    return JSON.parse(content) as RedditPostAnalysis
  } catch (err) {
    console.warn(`[RedditPosts] Falha ao analisar post ${post.id}:`, (err as Error).message)
    return null
  }
}

function formatAge(createdUtc: number): string {
  const diffMs = Date.now() - createdUtc * 1000
  const diffH = Math.floor(diffMs / (60 * 60 * 1000))
  const diffM = Math.floor((diffMs % (60 * 60 * 1000)) / 60000)
  if (diffH > 0) return `há ${diffH}h`
  return `há ${diffM}min`
}

async function publishPost(post: RedditPost, analysis: RedditPostAnalysis): Promise<void> {
  const tickerStr = analysis.tickers.length > 0
    ? analysis.tickers.map((t) => `$${t}`).join(' · ')
    : 'N/A'

  const tradeEmoji = analysis.trade_type === 'calls' ? '📈'
    : analysis.trade_type === 'puts' ? '📉'
    : '📊'

  const sentimentEmoji = analysis.sentiment === 'bullish' ? '🟢'
    : analysis.sentiment === 'bearish' ? '🔴' : '🟡'

  const strikesLine = analysis.has_specific_strikes
    ? '✅ Strike/expiry mencionados: sim'
    : '❌ Strike/expiry: não especificados'

  await sendEmbed('thread', {
    title: `🔥 Post Viral — r/${post.subreddit}`,
    description: [
      `**"${post.title.slice(0, 200)}"**`,
      `${tradeEmoji} ${post.score.toLocaleString()} upvotes · ${post.num_comments} comentários · ${formatAge(post.created_utc)}`,
      '',
      `**Tickers:** ${tickerStr} · **Trade:** ${analysis.trade_type} · **Sentimento:** ${sentimentEmoji} ${analysis.sentiment}`,
      `**Tese:** ${analysis.thesis}`,
      '',
      strikesLine,
      `⭐ Relevância: ${analysis.relevance_score}/10`,
      '',
      `[Ver post →](${post.url})`,
    ].join('\n'),
    color: 0xFF4500,
    footer: { text: `r/${post.subreddit} · via Reddit API` },
    timestamp: new Date().toISOString(),
  })

  console.log(`[RedditPosts] Publicado no #thread: "${post.title.slice(0, 60)}..." (score: ${analysis.relevance_score}/10)`)
}

async function poll(subreddits: string[]): Promise<void> {
  const fetchTasks = subreddits.flatMap((sub) => [
    fetchSubredditPosts(sub, 'hot', 25),
    fetchSubredditPosts(sub, 'new', 25),
  ])

  const results = await Promise.allSettled(fetchTasks)
  const allPosts = results
    .filter((r): r is PromiseFulfilledResult<RedditPost[]> => r.status === 'fulfilled')
    .flatMap((r) => r.value)

  const uniquePosts = [...new Map(allPosts.map((p) => [p.id, p])).values()]
  const candidates = uniquePosts.filter(passesHardFilter)
  console.log(`[RedditPosts] ${uniquePosts.length} posts únicos, ${candidates.length} passaram filtro hard`)

  for (const post of candidates) {
    const seen = await isAlreadySeen(post.id)
    if (seen) continue

    await markAsSeen(post.id)

    const analysis = await analyzePost(post)
    if (!analysis) continue

    if (analysis.relevance_score >= RELEVANCE_THRESHOLD) {
      await publishPost(post, analysis)
    }
  }
}

export function startRedditPostsPoller(): void {
  if (!CONFIG.reddit.clientId) {
    console.warn('[RedditPosts] REDDIT_CLIENT_ID não configurado — poller não iniciado')
    return
  }

  const subreddits = CONFIG.reddit.subreddits
  console.log('[RedditPosts] Poller iniciado — poll 1h, publicação por relevance_score ≥ 7')

  const schedule = (): void => {
    setTimeout(() => {
      poll(subreddits)
        .catch((err) => console.warn('[RedditPosts] Poll error:', (err as Error).message))
        .finally(schedule)
    }, POLL_INTERVAL_MS)
  }

  setTimeout(() => {
    poll(subreddits)
      .catch((err) => console.warn('[RedditPosts] Poll inicial error:', (err as Error).message))
      .finally(schedule)
  }, 60_000)
}

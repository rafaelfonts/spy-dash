import { redis, cacheGet, cacheSet } from '../lib/cacheStore'
import { sendEmbed, DISCORD_COLORS } from '../lib/discordClient'
import { fetchSubredditPosts } from '../lib/redditClient'
import { CONFIG } from '../config'
import { isMarketOpen } from '../lib/time'

const SNAPSHOT_KEY = 'reddit:sentiment_snapshot'
const YESTERDAY_KEY = 'reddit:sentiment_yesterday'
const DISCORD_STATE_KEY = 'reddit:discord_state'
const SNAPSHOT_TTL_MS = 2 * 60 * 60 * 1000
const YESTERDAY_TTL_MS = 25 * 60 * 60 * 1000
const DISCORD_STATE_TTL_S = 7 * 24 * 60 * 60

const POLL_OPEN_MS = 60 * 60 * 1000
const POLL_CLOSED_MS = 60 * 60 * 1000
const DEBOUNCE_MS = 2 * 60 * 60 * 1000
const MAX_MESSAGES_OPEN = 3
const MAX_MESSAGES_CLOSED = 1

const WATCHLIST = ['SPY', 'QQQ', 'IWM', 'NVDA', 'TSLA', 'AAPL', 'MSFT', 'META', 'GOOGL', 'AMZN']
const TICKER_REGEX = /\$([A-Z]{1,5})\b/g

export interface RedditTickerData {
  ticker: string
  rank: number
  mentionCount: number
  weightedScore: number
  rankYesterday: number
  rankChange: number
  mood: 'bullish_extreme' | 'bullish' | 'neutral' | 'ignored'
  capturedAt: string
}

export interface RedditSentimentSnapshot {
  tickers: RedditTickerData[]
  spyData: RedditTickerData
  subredditsScanned: string[]
  totalPostsAnalyzed: number
  capturedAt: string
}

interface DiscordPublishState {
  lastPublishTime: number
  messagesPublishedToday: number
  lastResetDate: string
  lastWindowUsed: 'opening' | 'midday' | 'close' | null
}

function extractTickers(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(TICKER_REGEX)) {
    found.add(match[1])
  }
  return [...found]
}

function getMood(rank: number): RedditTickerData['mood'] {
  if (rank <= 3) return 'bullish_extreme'
  if (rank <= 10) return 'bullish'
  if (rank <= 30) return 'neutral'
  return 'ignored'
}

function getMoodEmoji(mood: RedditTickerData['mood']): string {
  switch (mood) {
    case 'bullish_extreme': return '🔥'
    case 'bullish': return '📈'
    case 'neutral': return '➡️'
    case 'ignored': return '👻'
  }
}

function getRankArrow(rankChange: number): string {
  if (rankChange > 0) return `↑${rankChange}`
  if (rankChange < 0) return `↓${Math.abs(rankChange)}`
  return '→'
}

async function buildSnapshot(subreddits: string[]): Promise<RedditSentimentSnapshot | null> {
  const tickerScore: Map<string, { mentions: number; score: number }> = new Map()
  const scanned: string[] = []
  let totalPosts = 0

  for (const t of WATCHLIST) tickerScore.set(t, { mentions: 0, score: 0 })

  const results = await Promise.allSettled(
    subreddits.map((sub) => fetchSubredditPosts(sub, 'hot', 100))
  )

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.status === 'rejected' || r.value.length === 0) continue
    scanned.push(subreddits[i])
    for (const post of r.value) {
      totalPosts++
      const text = `${post.title} ${post.selftext.slice(0, 500)}`
      const tickers = extractTickers(text)
      for (const t of tickers) {
        const prev = tickerScore.get(t) ?? { mentions: 0, score: 0 }
        tickerScore.set(t, { mentions: prev.mentions + 1, score: prev.score + post.score })
      }
    }
  }

  if (scanned.length < 3) {
    console.warn('[RedditSentiment] Menos de 3 subreddits responderam — abortando snapshot')
    return null
  }

  const yesterday = await cacheGet<RedditTickerData[]>(YESTERDAY_KEY) ?? []
  const yesterdayMap = new Map(yesterday.map((t) => [t.ticker, t.rank]))

  const sorted = [...tickerScore.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .map(([ticker, data], idx) => {
      const rank = idx + 1
      const rankYesterday = yesterdayMap.get(ticker) ?? 999
      return {
        ticker,
        rank,
        mentionCount: data.mentions,
        weightedScore: data.score,
        rankYesterday,
        rankChange: rankYesterday === 999 ? 0 : rankYesterday - rank,
        mood: getMood(rank),
        capturedAt: new Date().toISOString(),
      } satisfies RedditTickerData
    })

  const spyData = sorted.find((t) => t.ticker === 'SPY') ?? {
    ticker: 'SPY', rank: 999, mentionCount: 0, weightedScore: 0,
    rankYesterday: 999, rankChange: 0, mood: 'ignored' as const,
    capturedAt: new Date().toISOString(),
  }

  return {
    tickers: sorted.slice(0, 20),
    spyData,
    subredditsScanned: scanned,
    totalPostsAnalyzed: totalPosts,
    capturedAt: new Date().toISOString(),
  }
}

async function loadDiscordState(): Promise<DiscordPublishState> {
  try {
    const raw = await redis.get(DISCORD_STATE_KEY)
    if (raw) return JSON.parse(raw) as DiscordPublishState
  } catch { /* ignora */ }
  return { lastPublishTime: 0, messagesPublishedToday: 0, lastResetDate: '', lastWindowUsed: null }
}

async function saveDiscordState(state: DiscordPublishState): Promise<void> {
  try {
    await redis.set(DISCORD_STATE_KEY, JSON.stringify(state), 'EX', DISCORD_STATE_TTL_S)
  } catch (err) {
    console.warn('[RedditSentiment] Falha ao salvar estado Discord:', (err as Error).message)
  }
}

function getETDateString(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

function getCurrentWindow(): 'opening' | 'midday' | 'close' | null {
  const now = new Date()
  const etHour = parseInt(now.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'America/New_York' }))
  const etMin = now.getMinutes()
  const etTotal = etHour * 60 + etMin
  if (etTotal >= 9 * 60 + 30 && etTotal < 11 * 60) return 'opening'
  if (etTotal >= 12 * 60 + 30 && etTotal < 14 * 60) return 'midday'
  if (etTotal >= 15 * 60 && etTotal < 16 * 60) return 'close'
  return null
}

function shouldPublish(state: DiscordPublishState, marketOpen: boolean): boolean {
  const now = Date.now()
  const today = getETDateString()
  const messagesReset = state.lastResetDate !== today ? 0 : state.messagesPublishedToday
  const debounceOk = now - state.lastPublishTime >= DEBOUNCE_MS

  if (!debounceOk) return false

  if (marketOpen) {
    if (messagesReset >= MAX_MESSAGES_OPEN) return false
    const window = getCurrentWindow()
    if (!window || window === state.lastWindowUsed) return false
    return true
  } else {
    return messagesReset < MAX_MESSAGES_CLOSED
  }
}

async function publishToDiscord(snapshot: RedditSentimentSnapshot, state: DiscordPublishState): Promise<void> {
  const today = getETDateString()
  const messagesReset = state.lastResetDate !== today ? 0 : state.messagesPublishedToday
  const window = getCurrentWindow()

  const topLines = snapshot.tickers.slice(0, 8).map((t) => {
    const arrow = getRankArrow(t.rankChange)
    const moodLabel = t.mood === 'bullish_extreme' ? ' → BULLISH EXTREMO' : ''
    return `${getMoodEmoji(t.mood)} #${t.rank} $${t.ticker} — ${t.mentionCount.toLocaleString()} menções | ${t.weightedScore.toLocaleString()} pts ${arrow}${moodLabel}`
  }).join('\n')

  const spyWarning = snapshot.spyData.mood === 'bullish_extreme'
    ? '\n\n> ⚠️ SPY em top 3 = euforia varejo (indicador contrário)'
    : ''

  const subList = snapshot.subredditsScanned.slice(0, 3).map((s) => `r/${s}`).join(', ')
  const extraSubs = snapshot.subredditsScanned.length > 3
    ? ` (+${snapshot.subredditsScanned.length - 3})`
    : ''

  await sendEmbed('feed', {
    title: '📊 Reddit Sentiment — Top Tickers',
    description: `**Top Menções Hoje**\n${topLines}${spyWarning}\n\n**Subreddits:** ${subList}${extraSubs}\n**Posts analisados:** ${snapshot.totalPostsAnalyzed.toLocaleString()}`,
    color: DISCORD_COLORS.redditSentiment,
    footer: { text: 'Reddit API oficial' },
    timestamp: snapshot.capturedAt,
  })

  const newState: DiscordPublishState = {
    lastPublishTime: Date.now(),
    messagesPublishedToday: messagesReset + 1,
    lastResetDate: today,
    lastWindowUsed: window,
  }
  await saveDiscordState(newState)
  console.log(`[RedditSentiment] Publicado no #feed (${messagesReset + 1}/${MAX_MESSAGES_OPEN} hoje)`)
}

async function poll(): Promise<void> {
  if (!CONFIG.reddit.clientId || !CONFIG.reddit.clientSecret) {
    console.warn('[RedditSentiment] Credenciais não configuradas — poller desativado')
    return
  }

  const subreddits = CONFIG.reddit.subreddits
  const snapshot = await buildSnapshot(subreddits)
  if (!snapshot) return

  _snapshot = snapshot
  await cacheSet(SNAPSHOT_KEY, snapshot, SNAPSHOT_TTL_MS, 'reddit_sentiment')
  await cacheSet(YESTERDAY_KEY, snapshot.tickers, YESTERDAY_TTL_MS, 'reddit_sentiment')

  console.log(
    `[RedditSentiment] Snapshot capturado — ${snapshot.totalPostsAnalyzed} posts, ` +
    `${snapshot.tickers.length} tickers detectados`
  )

  const marketOpen = isMarketOpen()
  const state = await loadDiscordState()
  if (shouldPublish(state, marketOpen)) {
    await publishToDiscord(snapshot, state)
  }
}

export function startRedditSentimentPoller(): void {
  if (!CONFIG.reddit.clientId) {
    console.warn('[RedditSentiment] REDDIT_CLIENT_ID não configurado — poller não iniciado')
    return
  }

  console.log('[RedditSentiment] Poller iniciado — poll 1h, Discord máx 3/dia em janelas')

  const schedule = (): void => {
    const marketOpen = isMarketOpen()
    const delay = marketOpen ? POLL_OPEN_MS : POLL_CLOSED_MS
    setTimeout(() => {
      poll().catch((err) => console.warn('[RedditSentiment] Poll error:', (err as Error).message))
        .finally(schedule)
    }, delay)
  }

  setTimeout(() => {
    poll().catch((err) => console.warn('[RedditSentiment] Poll inicial error:', (err as Error).message))
      .finally(schedule)
  }, 30_000)
}

let _snapshot: RedditSentimentSnapshot | null = null

export function getRedditSentimentSnapshot(): RedditSentimentSnapshot | null {
  return _snapshot
}

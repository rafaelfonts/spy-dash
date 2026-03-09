/**
 * ApeWisdom — Reddit WSB/options/stocks sentiment para SPY.
 * Poll adaptativo: 2h com mercado aberto, 4h fechado.
 * Discord #feed: máx 3 msg/dia em horário de mercado (janelas abertura/meio-dia/fechamento),
 * máx 1 msg/dia fora; debounce 2h entre mensagens.
 */

import { cacheSet, redis } from '../lib/cacheStore'
import { sendEmbed, DISCORD_COLORS } from '../lib/discordClient'
import { isMarketOpen, getDateET, getETMinutes } from '../lib/time'

const CACHE_KEY = 'ape_wisdom_spy'
const DISCORD_STATE_KEY = 'ape_wisdom_discord_state'
const DISCORD_STATE_TTL_SEC = 7 * 24 * 60 * 60  // 7 dias
const APE_URL = 'https://apewisdom.io/api/v1.0/filter/all-stocks/page/1'
const POLL_MARKET_OPEN_MS = 2 * 60 * 60 * 1000   // 2h com mercado aberto
const POLL_MARKET_CLOSED_MS = 4 * 60 * 60 * 1000 // 4h com mercado fechado
const DEBOUNCE_MS = 2 * 60 * 60 * 1000          // 2h entre mensagens
const MAX_MESSAGES_PER_DAY_OPEN = 3
const MAX_MESSAGES_PER_DAY_OFF = 1
const RANK_CHANGE_SIGNIFICANT_OPEN = 10   // durante mercado
const RANK_CHANGE_SIGNIFICANT_OFF = 20   // fora do mercado
const MAX_TOP_RANK_OPEN = 10
const MAX_TOP_RANK_OFF = 5   // só alerta extremo fora do horário
const CACHE_TTL_MS = 6 * 60 * 60 * 1000  // 6h no Redis

// Janelas ET: abertura 09:30–11:00, meio-dia 12:00–14:00, fechamento 14:30–16:00
const WINDOW_OPENING_START = 570   // 09:30
const WINDOW_OPENING_END = 660    // 11:00
const WINDOW_MIDDAY_START = 720   // 12:00
const WINDOW_MIDDAY_END = 840     // 14:00
const WINDOW_CLOSE_START = 870    // 14:30
const WINDOW_CLOSE_END = 960      // 16:00

export interface DiscordPublishState {
  lastPublishTime: number
  lastPublishedRank: number
  lastPublishedMood: ApeWisdomSPYData['mood']
  messagesPublishedToday: number
  lastResetDate: string
  lastWindowUsed: 'opening' | 'midday' | 'close' | null
}

export interface ApeWisdomSPYData {
  rank: number
  mentions: number
  upvotes: number
  rankYesterday: number
  rankChange: number   // positivo = subiu no ranking (mais popular)
  mood: 'bullish_extreme' | 'bullish' | 'neutral' | 'ignored'
  capturedAt: string
}

async function fetchApeWisdom(): Promise<ApeWisdomSPYData | null> {
  try {
    const res = await fetch(APE_URL, { signal: AbortSignal.timeout(8000) })
    const json = (await res.json()) as {
      results?: Array<{
        ticker: string
        rank: number
        mentions: string
        upvotes: string
        rank_24h_ago: string
      }>
    }

    const spy = json.results?.find((r) => r.ticker === 'SPY')
    if (!spy) {
      return {
        rank: 999,
        mentions: 0,
        upvotes: 0,
        rankYesterday: 999,
        rankChange: 0,
        mood: 'ignored',
        capturedAt: new Date().toISOString(),
      }
    }

    const rank = spy.rank
    const rankYesterday = parseInt(spy.rank_24h_ago ?? '999', 10)
    const rankChange = rankYesterday - rank
    const mentions = parseInt(spy.mentions ?? '0', 10)
    const upvotes = parseInt(spy.upvotes ?? '0', 10)

    const mood: ApeWisdomSPYData['mood'] =
      rank <= 5 ? 'bullish_extreme'
      : rank <= 15 ? 'bullish'
      : rank <= 50 ? 'neutral'
      : 'ignored'

    return {
      rank,
      mentions,
      upvotes,
      rankYesterday,
      rankChange,
      mood,
      capturedAt: new Date().toISOString(),
    }
  } catch (err) {
    console.warn('[ApeWisdom] Falha no fetch:', (err as Error).message)
    return null
  }
}

async function loadDiscordState(): Promise<DiscordPublishState | null> {
  try {
    const raw = await redis.get(DISCORD_STATE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as DiscordPublishState
  } catch {
    return null
  }
}

async function saveDiscordState(state: DiscordPublishState): Promise<void> {
  try {
    await redis.set(DISCORD_STATE_KEY, JSON.stringify(state), 'EX', DISCORD_STATE_TTL_SEC)
  } catch (err) {
    console.warn('[ApeWisdom] Falha ao salvar estado Discord:', (err as Error).message)
  }
}

/** Retorna a janela atual em ET se mercado aberto, senão null. */
function getCurrentWindow(): 'opening' | 'midday' | 'close' | null {
  const et = getETMinutes()
  if (et >= WINDOW_OPENING_START && et < WINDOW_OPENING_END) return 'opening'
  if (et >= WINDOW_MIDDAY_START && et < WINDOW_MIDDAY_END) return 'midday'
  if (et >= WINDOW_CLOSE_START && et < WINDOW_CLOSE_END) return 'close'
  return null
}

function shouldPublishToDiscord(
  data: ApeWisdomSPYData,
  prev: ApeWisdomSPYData | null,
  state: DiscordPublishState | null,
  now: Date,
): boolean {
  const today = getDateET(now)
  const nowMs = now.getTime()

  let stateAdjusted = state
  if (!stateAdjusted || stateAdjusted.lastResetDate !== today) {
    stateAdjusted = {
      lastPublishTime: 0,
      lastPublishedRank: data.rank,
      lastPublishedMood: data.mood,
      messagesPublishedToday: 0,
      lastResetDate: today,
      lastWindowUsed: null,
    }
  }

  if (nowMs - stateAdjusted.lastPublishTime < DEBOUNCE_MS) return false

  const marketOpen = isMarketOpen()
  const maxPerDay = marketOpen ? MAX_MESSAGES_PER_DAY_OPEN : MAX_MESSAGES_PER_DAY_OFF
  if (stateAdjusted.messagesPublishedToday >= maxPerDay) return false

  if (marketOpen) {
    const window = getCurrentWindow()
    if (!window) return false
    if (stateAdjusted.lastWindowUsed === window && stateAdjusted.messagesPublishedToday > 0) return false
    const isFirstOfDay = stateAdjusted.messagesPublishedToday === 0
    const rankChangeSignificant = Math.abs(data.rank - stateAdjusted.lastPublishedRank) >= RANK_CHANGE_SIGNIFICANT_OPEN
    const moodChange = stateAdjusted.lastPublishedMood !== data.mood && data.mood !== 'neutral'
    const inTop = data.rank <= MAX_TOP_RANK_OPEN
    const enteredOrLeftTop = (data.rank <= MAX_TOP_RANK_OPEN) !== (stateAdjusted.lastPublishedRank <= MAX_TOP_RANK_OPEN)
    const firstOfDayRelevant = isFirstOfDay && (inTop || Math.abs(data.rankChange) >= RANK_CHANGE_SIGNIFICANT_OPEN || data.mood !== 'neutral')
    return firstOfDayRelevant || rankChangeSignificant || moodChange || inTop || enteredOrLeftTop
  }

  const rankExtreme = data.rank <= MAX_TOP_RANK_OFF
  const rankChangeBig = Math.abs(data.rank - stateAdjusted.lastPublishedRank) >= RANK_CHANGE_SIGNIFICANT_OFF
  return rankExtreme || rankChangeBig
}

async function publishEmbedToDiscord(data: ApeWisdomSPYData): Promise<void> {
  const moodLabel: Record<ApeWisdomSPYData['mood'], string> = {
    bullish_extreme: '🔥 BULLISH EXTREMO — varejo eufórico com SPY (indicador contrário: cautela)',
    bullish: '📈 Bullish — SPY em destaque no Reddit',
    neutral: '➡️ Neutro',
    ignored: '👻 Ignorado — varejo não está falando de SPY',
  }

  const rankTrend =
    data.rankChange > 0
      ? `↑ ${data.rankChange} posições vs ontem`
      : data.rankChange < 0
        ? `↓ ${Math.abs(data.rankChange)} posições vs ontem`
        : 'estável'

  const quote =
    data.mood === 'bullish_extreme'
      ? `> ⚠️ Euforia de varejo = indicador contrário. Não ampliar tamanho de posição.`
      : data.mood === 'ignored'
        ? `> Ausência de varejo pode indicar puts baratas — verificar IV Rank.`
        : `> Nível normal de atenção ao SPY.`

  await sendEmbed('feed', {
    title: '💬 Reddit WSB — SPY Sentiment',
    description: [
      `**Rank hoje:** #${data.rank} de 100 (${rankTrend})`,
      `**Menções 24h:** ${data.mentions} | **Upvotes:** ${data.upvotes}`,
      ``,
      `**Mood:** ${moodLabel[data.mood]}`,
      ``,
      quote,
    ].join('\n'),
    color: DISCORD_COLORS.redditSentiment,
    footer: { text: 'Fonte: ApeWisdom (r/wallstreetbets, r/options, r/stocks)' },
    timestamp: new Date().toISOString(),
  })
}

async function maybePublishToDiscord(
  data: ApeWisdomSPYData,
  prev: ApeWisdomSPYData | null,
): Promise<void> {
  const now = new Date()
  const state = await loadDiscordState()
  if (!shouldPublishToDiscord(data, prev, state, now)) return

  await publishEmbedToDiscord(data)

  const today = getDateET(now)
  const base = state && state.lastResetDate === today ? state : {
    lastPublishTime: 0,
    lastPublishedRank: data.rank,
    lastPublishedMood: data.mood as ApeWisdomSPYData['mood'],
    messagesPublishedToday: 0,
    lastResetDate: today,
    lastWindowUsed: null as DiscordPublishState['lastWindowUsed'],
  }
  const window = isMarketOpen() ? getCurrentWindow() : null
  await saveDiscordState({
    lastPublishTime: now.getTime(),
    lastPublishedRank: data.rank,
    lastPublishedMood: data.mood,
    messagesPublishedToday: base.messagesPublishedToday + 1,
    lastResetDate: today,
    lastWindowUsed: window ?? base.lastWindowUsed,
  })
}

export function startApeWisdomPoller(): void {
  let prevData: ApeWisdomSPYData | null = null

  const poll = async (): Promise<void> => {
    const pollMs = isMarketOpen() ? POLL_MARKET_OPEN_MS : POLL_MARKET_CLOSED_MS
    const lockKey = `lock:ape_wisdom_poll:${new Date().toISOString().slice(0, 13)}`
    const lockTTL = Math.ceil(pollMs / 1000)
    const acquired = await redis.set(lockKey, '1', 'EX', lockTTL, 'NX')
    if (!acquired) return

    const data = await fetchApeWisdom()
    if (!data) return

    await cacheSet(CACHE_KEY, data, CACHE_TTL_MS, 'ape_wisdom')
    await maybePublishToDiscord(data, prevData)
    prevData = data
  }

  function scheduleNext(): void {
    const delay = isMarketOpen() ? POLL_MARKET_OPEN_MS : POLL_MARKET_CLOSED_MS
    setTimeout(() => {
      poll().catch((err) => console.warn('[ApeWisdom] Poll error:', (err as Error).message))
      scheduleNext()
    }, delay)
  }

  setTimeout(() => {
    poll().catch((err) => console.warn('[ApeWisdom] Initial poll error:', (err as Error).message))
    scheduleNext()
  }, 30_000)

  console.log('[ApeWisdom] Poller iniciado — poll 2h (mercado aberto) / 4h (fechado), Discord máx 3/dia em janelas')
}

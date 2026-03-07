/**
 * ApeWisdom — Reddit WSB/options/stocks sentiment para SPY.
 * Poll a cada 4h; envia ao #feed apenas em anomalia (rank ≤ 10 ou |rankChange| ≥ 15).
 */

import { cacheSet } from '../lib/cacheStore'
import { sendEmbed, DISCORD_COLORS } from '../lib/discordClient'

const CACHE_KEY = 'ape_wisdom_spy'
const APE_URL = 'https://apewisdom.io/api/v1.0/filter/all-stocks/page/1'
const POLL_MS = 4 * 60 * 60 * 1000  // 4 horas
const MAX_DISCORD_RANK = 10   // só envia se SPY está nos top 10
const MIN_RANK_CHANGE = 15   // ou se moveu mais de 15 posições
const CACHE_TTL_MS = 6 * 60 * 60 * 1000  // 6h no Redis

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

async function maybePublishToDiscord(
  data: ApeWisdomSPYData,
  prev: ApeWisdomSPYData | null,
): Promise<void> {
  const shouldSend =
    data.rank <= MAX_DISCORD_RANK ||
    Math.abs(data.rankChange) >= MIN_RANK_CHANGE ||
    (prev != null && prev.mood !== data.mood && data.mood !== 'neutral')

  if (!shouldSend) return

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

export function startApeWisdomPoller(): void {
  let prevData: ApeWisdomSPYData | null = null

  const poll = async (): Promise<void> => {
    const data = await fetchApeWisdom()
    if (!data) return

    await cacheSet(CACHE_KEY, data, CACHE_TTL_MS, 'ape_wisdom')
    await maybePublishToDiscord(data, prevData)
    prevData = data
  }

  setTimeout(() => poll().catch(() => {}), 30_000)
  setInterval(() => poll().catch(() => {}), POLL_MS)

  console.log('[ApeWisdom] Poller iniciado — poll a cada 4h, Discord apenas em anomalias')
}

/**
 * Macro + Notícias Digest — 3x/semana (Seg/Qua/Sex) às 10:00 ET.
 * Aviso D-1 para FOMC/CPI/NFP às 18:00 ET.
 */

import OpenAI from 'openai'
import { CONFIG } from '../config'
import { marketState, newsSnapshot, emitter } from './marketState'
import { cacheSet, cacheGet, redis } from '../lib/cacheStore'
import { sendEmbed, DISCORD_COLORS } from '../lib/discordClient'

const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY })

const CACHE_KEY_LAST = 'macro_digest_last'
const CHECK_MS = 60_000
const DIGEST_DAYS = new Set([1, 3, 5])  // Seg, Qua, Sex
const DIGEST_HOUR_ET = 10
const DIGEST_MINUTE_ET = 0
const TTL_14H_MS = 14 * 60 * 60 * 1000
const TTL_14H_S = 14 * 60 * 60
const TTL_24H_S = 24 * 60 * 60

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

interface MacroDigestEntry {
  text: string
  capturedAt: string
}

let lastDigest: MacroDigestEntry | null = null

export function getLastMacroDigest(): MacroDigestEntry | null {
  return lastDigest
}

/** Called on startup to restore last digest from Redis (TTL 14h). */
export async function restoreMacroDigestFromCache(): Promise<void> {
  try {
    const cached = await cacheGet<MacroDigestEntry>(CACHE_KEY_LAST)
    if (cached) {
      lastDigest = cached
      console.log('[MacroDigest] Digest restaurado do cache Redis')
    }
  } catch (err) {
    console.warn('[MacroDigest] Falha ao restaurar cache:', (err as Error).message)
  }
}

function getTodayDateET(): string {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const y = et.getFullYear()
  const m = String(et.getMonth() + 1).padStart(2, '0')
  const d = String(et.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

async function buildDigestPrompt(): Promise<string> {
  const sections: string[] = []

  if (newsSnapshot.headlines?.length) {
    const top5 = newsSnapshot.headlines
      .slice(0, 5)
      .map((h) => `- ${h.title}${h.source ? ` (${h.source})` : ''}`)
      .join('\n')
    sections.push(`HEADLINES RECENTES:\n${top5}`)
  }

  if (newsSnapshot.macroEvents?.length) {
    const today = new Date().toDateString()
    const upcoming = newsSnapshot.macroEvents
      .filter((e) => e.impact === 'high' && e.time && new Date(e.time).toDateString() >= today)
      .slice(0, 4)
      .map(
        (e) =>
          `- ${e.event} (${e.time ? new Date(e.time).toLocaleTimeString('pt-BR', { timeZone: 'America/New_York' }) : '?'} ET)${e.estimate != null ? ` | Est: ${e.estimate}` : ''}`,
      )
      .join('\n')
    if (upcoming) sections.push(`EVENTOS MACRO HOJE/AMANHÃ (alto impacto):\n${upcoming}`)
  }

  if (newsSnapshot.macro?.length) {
    const relevant = newsSnapshot.macro
      .slice(0, 4)
      .map((m) => `- ${m.name}: ${m.value != null ? m.value : 'N/A'} (${m.unit})`)
      .join('\n')
    sections.push(`DADOS MACRO FRED:\n${relevant}`)
  }

  // SEC EDGAR — 8-K e 13F (resumo leve, melhor esforço)
  try {
    const { fetchRecent8KForSPYComponents, fetchRecent13FForSelectedFunds } = await import('./secEdgarService')

    const [recent8k, recent13f] = await Promise.allSettled([
      fetchRecent8KForSPYComponents(3),
      fetchRecent13FForSelectedFunds(3),
    ])

    if (recent8k.status === 'fulfilled' && recent8k.value.length > 0) {
      const lines = recent8k.value
        .slice(0, 3)
        .map((e) => {
          const date = e.filedAt.slice(0, 10)
          const sym = e.symbol ?? e.cik
          const title = e.title ?? 'Evento 8-K'
          return `- ${date} — ${sym}: ${title}`
        })
        .join('\n')
      sections.push(`EVENTOS SEC 8-K RECENTES (componentes SPY):\n${lines}`)
    }

    if (recent13f.status === 'fulfilled' && recent13f.value.length > 0) {
      const lines = recent13f.value
        .slice(0, 3)
        .map((p) => {
          const dir = p.changeVsPrev ?? 'flat'
          return `- ${p.managerName}: posição em SPY (${dir}) no relatório de ${p.reportDate}`
        })
        .join('\n')
      sections.push(`MUDANÇAS 13F EM SPY (fundos selecionados):\n${lines}`)
    }
  } catch (err) {
    console.warn('[MacroDigest] SEC EDGAR indisponível — omitindo seção SEC:', (err as Error).message)
  }

  // Treasury TGA — saldo e fluxo de liquidez
  try {
    const { getTreasuryTgaSnapshot } = await import('./treasuryState')
    const tga = getTreasuryTgaSnapshot()
    if (tga) {
      const deltaStr =
        tga.delta != null
          ? `${tga.delta >= 0 ? '+' : ''}${tga.delta.toLocaleString('en-US')}`
          : 'N/A'
      sections.push(
        `TREASURY TGA: ${tga.asOfDate} — saldo $${tga.closingBalance?.toLocaleString('en-US') ?? 'N/A'} (${deltaStr} vs abertura)`,
      )
    }
  } catch {
    // ignore — TGA é opcional no digest
  }

  // EIA Oil — estoques de petróleo/gasolina
  try {
    const { getEiaOilSnapshot } = await import('./eiaOilState')
    const oil = getEiaOilSnapshot()
    if (oil) {
      const crude = oil.crudeInventories != null ? oil.crudeInventories.toLocaleString('en-US') : 'N/A'
      const change =
        oil.crudeChange != null
          ? `${oil.crudeChange >= 0 ? '+' : ''}${oil.crudeChange.toFixed(2)}`
          : 'N/A'
      sections.push(
        `EIA ESTOQUES: semana ${oil.asOfDate} — crude=${crude} (Δ=${change} M bbl)`,
      )
    }
  } catch {
    // ignore — EIA é opcional no digest
  }

  if (newsSnapshot.fearGreed) {
    const fg = newsSnapshot.fearGreed
    sections.push(`FEAR & GREED: ${fg.score ?? 'N/A'}/100 — ${fg.label ?? 'N/A'}`)
  }

  const spy = marketState.spy?.last != null ? `SPY: $${marketState.spy.last.toFixed(2)}` : null
  const vix = marketState.vix?.last != null ? `VIX: ${marketState.vix.last.toFixed(2)}` : null
  if (spy || vix) sections.push(`MERCADO ATUAL: ${[spy, vix].filter(Boolean).join(' · ')}`)

  if (sections.length === 0) return ''

  return `Você é um estrategista quantitativo sênior de opções sobre SPY.
Com base nos dados abaixo, gere um digest macro CONCISO para operadores de Put Spreads.

${sections.join('\n\n')}

FORMATO OBRIGATÓRIO (máximo 800 caracteres total):
**Contexto Macro:** [2 frases — o que os dados dizem sobre o ambiente atual]
**Eventos-Chave:** [bullet list de até 3 eventos de alto impacto próximos]
**Implicação para SPY:** [1 frase sobre bias direcional/vol]
**Recomendação de Postura:** [CAUTELOSO / NEUTRO / FAVORÁVEL para premium selling + motivo em 1 linha]

Responda APENAS com o conteúdo formatado acima. Sem introdução, sem conclusão, sem disclaimer.
Idioma: Português.`
}

async function generateAndSendMacroDigest(): Promise<void> {
  const prompt = await buildDigestPrompt()
  if (!prompt) {
    console.warn('[MacroDigest] newsSnapshot vazio — pulando digest')
    return
  }

  const todayStr = getTodayDateET()
  const lockKey = `lock:macro_digest:${todayStr}`
  const acquired = await redis.set(lockKey, '1', 'EX', TTL_14H_S, 'NX')
  if (!acquired) return

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 400,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.choices[0]?.message?.content?.trim() ?? ''
    if (!text) return

    const entry: MacroDigestEntry = { text, capturedAt: new Date().toISOString() }
    lastDigest = entry

    await cacheSet(CACHE_KEY_LAST, entry, TTL_14H_MS, 'macro_digest')

    // Broadcast to SSE clients
    emitter.emit('macro-digest', entry)

    const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
    const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const dayLabel = dayNames[etNow.getDay()]

    await sendEmbed('briefings', {
      title: `📰 Digest Macro + Notícias — ${dayLabel} ${etNow.toLocaleDateString('pt-BR', { timeZone: 'America/New_York' })}`,
      description: text,
      color: DISCORD_COLORS.macroDigest,
      footer: { text: 'SPY Dash · Digest 10:00 ET (Seg/Qua/Sex) · via gpt-4o-mini' },
      timestamp: new Date().toISOString(),
    })

    console.log('[MacroDigest] Digest enviado ao #briefings')
  } catch (err) {
    console.warn('[MacroDigest] Falha na geração:', (err as Error).message)
  }
}

const HIGH_IMPACT_KEYWORDS = ['FOMC', 'CPI', 'NFP', 'Nonfarm', 'GDP', 'PCE', 'Federal Reserve']

async function checkAndSendDayBeforeAlert(): Promise<void> {
  if (!newsSnapshot.macroEvents?.length) return

  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = tomorrow.toDateString()
  const tomorrowYYYYMMDD = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`

  const highImpactTomorrow = newsSnapshot.macroEvents.filter((e) => {
    if (e.impact !== 'high' || !e.time) return false
    if (new Date(e.time).toDateString() !== tomorrowStr) return false
    return HIGH_IMPACT_KEYWORDS.some((kw) => e.event.includes(kw))
  })

  if (!highImpactTomorrow.length) return

  const lockKey = `lock:macro_d1_alert:${tomorrowYYYYMMDD}`
  const acquired = await redis.set(lockKey, '1', 'EX', TTL_24H_S, 'NX')
  if (!acquired) return

  const eventList = highImpactTomorrow
    .map(
      (e) =>
        `• **${e.event}** — ${e.time ? new Date(e.time).toLocaleTimeString('pt-BR', { timeZone: 'America/New_York' }) : '?'} ET${e.estimate != null ? ` | Estimativa: ${e.estimate}` : ''}`,
    )
    .join('\n')

  await sendEmbed('briefings', {
    title: '📅 Evento Macro Amanhã — Atenção',
    description: [
      `Evento(s) de alto impacto amanhã (${tomorrow.toLocaleDateString('pt-BR', { timeZone: 'America/New_York' })}):`,
      ``,
      eventList,
      ``,
      `> ⚠️ Considerar redução de tamanho ou esperar resultado antes de abrir novas posições.`,
    ].join('\n'),
    color: DISCORD_COLORS.macroDayBefore,
    footer: { text: 'SPY Dash · Aviso Macro D-1 · 18:00 ET' },
    timestamp: new Date().toISOString(),
  })
}

export function startMacroDigestScheduler(): void {
  setInterval(async () => {
    const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const day = etNow.getDay()
    const hour = etNow.getHours()
    const minute = etNow.getMinutes()

    if (DIGEST_DAYS.has(day) && hour === DIGEST_HOUR_ET && minute === DIGEST_MINUTE_ET) {
      await generateAndSendMacroDigest().catch(() => {})
    }

    if (day >= 1 && day <= 5 && hour === 18 && minute === 0) {
      await checkAndSendDayBeforeAlert().catch(() => {})
    }
  }, CHECK_MS)

  console.log('[MacroDigest] Scheduler iniciado — digest 10:00 ET (Seg/Qua/Sex), D-1 alert 18:00 ET')
}

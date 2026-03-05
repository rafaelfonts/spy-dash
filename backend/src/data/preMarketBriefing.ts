/**
 * Pre-Market Briefing — automatic daily briefing generated at 9:00 ET.
 *
 * Schedule:
 *  - 09:00 ET Mon–Fri: pre-market briefing (expires 10:30 ET)
 *  - 16:15 ET Mon–Fri: post-close summary (expires 06:00 ET next day)
 *
 * Cooldown: one briefing per type per calendar day (ET), backed by Redis.
 * If the server restarts, restoreBriefingFromCache() recovers today's briefing
 * without calling OpenAI again.
 */

import Anthropic from '@anthropic-ai/sdk'
import { marketState, newsSnapshot, emitter } from './marketState'
import { cacheGet, cacheSet, redis } from '../lib/cacheStore'
import { CONFIG } from '../config'
import type {
  PreMarketBriefing,
  EarningsItem,
  MacroEvent,
  NewsHeadline,
  MacroDataItem,
  FearGreedData,
} from '../types/market'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BRIEFING_TTL_MS = 14 * 60 * 60 * 1000  // 14h — survives overnight in Redis
const DISCORD_EMBED_DESC_MAX = 4000          // safe under Discord's 4096 limit
const DISCORD_EMBED_COLOR_PRE = 65416        // #00ff88 — Pré-Market (paleta frontend)
const DISCORD_EMBED_COLOR_POST = 16763904    // #ffcc00 — Pós-Market (paleta frontend)

const PRE_MARKET_PROMPT = `Você é o Estrategista Quantitativo Chefe do SPY Dash, operando com foco exclusivo em Put Spreads de 21 a 45 DTE. Sua tarefa é analisar os dados pré-mercado fornecidos (Preço SPY, GEX, IV Rank, VIX, Macro Events) e entregar o briefing de abertura.
REGRAS DE FORMATAÇÃO E ESTILO (INEGOCIÁVEIS):
1. ZERO RUÍDO: Não use saudações, introduções ou fechamentos. Comece imediatamente com os dados.
2. CONCISÃO EXTREMA: O texto final DEVE ter menos de 2.500 caracteres. Use bullet points curtos e diretos.
3. ESTRUTURA OBRIGATÓRIA:
- 🧱 **Estrutura GEX & Preço**: SPY atual vs. Maior Gamma Negativo (Suporte) e Positivo (Resistência).
- 🌪️ **Volatilidade**: Status do VIX e IV Rank. Indique se o IV Rank favorece venda de prêmio (> 30%) ou exige cautela.
- 📅 **Risco Macro**: Liste apenas os eventos binários de ALTO IMPACTO do dia. Se não houver, diga 'Sessão Livre de Eventos Macro'.
- 🎯 **Veredito Sniper**: Com base nos dados, há configuração matemática para buscar entradas de Put Spread (21-45 DTE) hoje? (Sim/Não e justificativa em 1 linha).
Não explique o que é GEX ou IV Rank. Entregue apenas o sinal.`

const POST_MARKET_PROMPT = `Você é o Gestor de Risco Quantitativo do SPY Dash. O mercado acaba de fechar. Sua tarefa é ler os dados de fechamento (Preço SPY, GEX atualizado, VIX) e o status do portfólio de opções ativas (Put Spreads de 21 a 45 DTE).
REGRAS DE FORMATAÇÃO E ESTILO (INEGOCIÁVEIS):
1. ZERO RUÍDO: Sem saudações ou explicações teóricas. Estilo institucional, telegráfico.
2. CONCISÃO EXTREMA: Máximo de 2.500 caracteres.
3. ESTRUTURA OBRIGATÓRIA:
- 📊 **Resumo do Fechamento**: Onde o SPY fechou em relação às 'paredes' de GEX? Houve expansão ou contração de volatilidade?
- 💼 **Auditoria de Portfólio**: Avalie as posições abertas enviadas no payload.
- 🚨 **Ações Exigidas (A Regra de Ouro)**:
Se alguma posição atingiu >= 50% de lucro, ordene o fechamento imediato.
Se alguma posição atingiu <= 21 DTE, ordene o fechamento ou rolagem.
Se nenhuma regra for quebrada, emita 'Status: Manter Posições'.`

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let todaysBriefing: PreMarketBriefing | null = null

export function getTodaysBriefing(): PreMarketBriefing | null {
  return todaysBriefing
}

// ---------------------------------------------------------------------------
// Bootstrap: restore from Redis on server start
// ---------------------------------------------------------------------------

export async function restoreBriefingFromCache(): Promise<void> {
  const today = getTodayDateET()
  const preKey = `cache:premarket_briefing:${today}`
  const postKey = `cache:postclose_briefing:${today}`

  const [pre, post] = await Promise.all([
    cacheGet<PreMarketBriefing>(preKey),
    cacheGet<PreMarketBriefing>(postKey),
  ])

  // Prefer the post-close if available (more recent); fall back to pre-market
  todaysBriefing = post ?? pre ?? null

  if (todaysBriefing) {
    console.log(`[PreMarket] Briefing '${todaysBriefing.type}' restaurado do Redis (${today})`)
  }
}

// ---------------------------------------------------------------------------
// Scheduler — checks every 60 s whether it's time to generate
// ---------------------------------------------------------------------------

export function startPreMarketScheduler(): void {
  setInterval(() => {
    const et = getETNow()
    const dow = et.getDay()   // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) return

    const h = et.getHours()
    const m = et.getMinutes()

    if (h === 9 && m === 0) {
      generateBriefing('pre-market').catch((err) =>
        console.error('[PreMarket] Scheduler: erro pre-market:', err),
      )
    }

    if (h === 16 && m === 15) {
      generateBriefing('post-close').catch((err) =>
        console.error('[PreMarket] Scheduler: erro post-close:', err),
      )
    }
  }, 60_000)

  console.log('[PreMarket] Scheduler iniciado (verificação a cada 60s)')
}

// ---------------------------------------------------------------------------
// Core generator
// ---------------------------------------------------------------------------

async function generateBriefing(type: 'pre-market' | 'post-close'): Promise<void> {
  const today = getTodayDateET()
  const cacheKey =
    type === 'pre-market'
      ? `cache:premarket_briefing:${today}`
      : `cache:postclose_briefing:${today}`

  // Distributed lock — prevents duplicate generation across HA instances (Fly.io 2-machine HA)
  // Redis SET NX is atomic: only one instance acquires the lock; others return immediately.
  // TTL of 300s ensures the lock expires if the generating instance crashes mid-flight.
  const lockKey = `lock:briefing:${type}:${today}`
  const acquired = await redis.set(lockKey, '1', 'EX', 300, 'NX')
  if (!acquired) {
    console.log(`[PreMarket] Lock '${type}' não adquirido — outra instância está gerando`)
    return
  }

  // Cooldown: skip if we already have a briefing of this type for today
  const existing = await cacheGet<PreMarketBriefing>(cacheKey)
  if (existing) {
    console.log(`[PreMarket] Briefing '${type}' já existe para ${today} — pulando geração`)
    if (!todaysBriefing || todaysBriefing.type !== type) todaysBriefing = existing
    return
  }

  console.log(`[PreMarket] Gerando briefing '${type}'...`)

  try {
    const spyPreMarket = await getSpyPreMarketPrice()

    const context: BriefingContext = {
      spy: {
        last: marketState.spy.last,
        prevClose: marketState.spy.prevClose,
        change: marketState.spy.change,
        changePct: marketState.spy.changePct,
        dayHigh: marketState.spy.dayHigh,
        dayLow: marketState.spy.dayLow,
        open: marketState.spy.open,
        preMarket: spyPreMarket,
      },
      vix: {
        last: marketState.vix.last,
        change: marketState.vix.change,
        changePct: marketState.vix.changePct,
        level: marketState.vix.level,
      },
      ivRank: {
        value: marketState.ivRank.value,
        hv30: marketState.ivRank.hv30,
        label: marketState.ivRank.label,
      },
      earnings: newsSnapshot.earnings,
      macroEvents: newsSnapshot.macroEvents,
      headlines: newsSnapshot.headlines.slice(0, 5),
      fearGreed: newsSnapshot.fearGreed,
      macro: newsSnapshot.macro,
    }

    const userPrompt =
      type === 'pre-market'
        ? buildPreMarketPrompt(context)
        : buildPostClosePrompt(context)

    const systemContent = type === 'pre-market' ? PRE_MARKET_PROMPT : POST_MARKET_PROMPT

    let markdown = ''
    const useClaude = Boolean(CONFIG.ANTHROPIC_API_KEY)

    if (useClaude) {
      try {
        const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY })
        const msg = await anthropic.messages.create({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 4096,
          system: systemContent,
          messages: [{ role: 'user', content: userPrompt }],
        })
        const textBlock = msg.content.find((b): b is { type: 'text'; text: string } => b.type === 'text')
        markdown = textBlock?.text?.trim() ?? ''
        if (markdown) console.log('[PreMarket] Briefing gerado via Claude')
      } catch (err) {
        console.warn('[PreMarket] Claude falhou, fallback para GPT-4o:', (err as Error).message)
      }
    }

    if (!markdown) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 4096,
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: userPrompt },
          ],
        }),
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 200)}`)
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      markdown = json.choices?.[0]?.message?.content ?? ''
    }

    if (!markdown) {
      throw new Error('Nem Claude nem OpenAI retornaram conteúdo')
    }

    const expiresAt =
      type === 'pre-market'
        ? getExpirationET(10, 30)        // 10:30 ET (1h após abertura)
        : getExpirationET(6, 0, 1)       // 06:00 ET do dia seguinte

    const briefing: PreMarketBriefing = {
      type,
      generatedAt: new Date().toISOString(),
      markdown,
      expiresAt,
    }

    await cacheSet(cacheKey, briefing, BRIEFING_TTL_MS, 'premarket')
    todaysBriefing = briefing

    // Broadcast to all connected SSE clients
    emitter.emit('briefing', briefing)

    // Discord webhook — fire-and-forget, failure does not affect SSE
    sendToDiscord(markdown, type).catch((err) =>
      console.error('[Discord] Falha ao enviar briefing:', err),
    )

    console.log(`[PreMarket] Briefing '${type}' gerado com sucesso`)
  } catch (err) {
    console.error(`[PreMarket] Erro ao gerar briefing '${type}':`, err)
    // Do not rethrow — scheduler must not break the process
  }
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

interface BriefingContext {
  spy: {
    last: number | null
    prevClose: number | null
    change: number | null
    changePct: number | null
    dayHigh: number | null
    dayLow: number | null
    open: number | null
    preMarket: number | null
  }
  vix: {
    last: number | null
    change: number | null
    changePct: number | null
    level: 'low' | 'moderate' | 'high' | null
  }
  ivRank: {
    value: number | null
    hv30: number | null
    label: 'low' | 'medium' | 'high' | null
  }
  earnings: EarningsItem[]
  macroEvents: MacroEvent[]
  headlines: NewsHeadline[]
  fearGreed: FearGreedData | null
  macro: MacroDataItem[]
}

function buildPreMarketPrompt(ctx: BriefingContext): string {
  const lines: string[] = ['=== PRE-MARKET DATA ===', '']

  // SPY
  lines.push('### SPY')
  if (ctx.spy.preMarket != null) {
    lines.push(`- Pré-market: $${ctx.spy.preMarket.toFixed(2)}`)
  }
  if (ctx.spy.last != null) {
    lines.push(`- Último preço (DXFeed): $${ctx.spy.last.toFixed(2)}`)
  }
  if (ctx.spy.prevClose != null) {
    lines.push(`- Fechamento anterior: $${ctx.spy.prevClose.toFixed(2)}`)
  }
  if (ctx.spy.changePct != null) {
    const sign = ctx.spy.changePct >= 0 ? '+' : ''
    lines.push(`- Variação overnight: ${sign}${ctx.spy.changePct.toFixed(2)}%`)
  }
  if (ctx.spy.dayHigh != null && ctx.spy.dayLow != null) {
    lines.push(`- Range do dia: $${ctx.spy.dayLow.toFixed(2)} – $${ctx.spy.dayHigh.toFixed(2)}`)
  }
  lines.push('')

  // VIX
  lines.push('### VIX')
  if (ctx.vix.last != null) {
    lines.push(`- VIX: ${ctx.vix.last.toFixed(2)} (${ctx.vix.level ?? 'n/a'})`)
  }
  if (ctx.vix.changePct != null) {
    const sign = ctx.vix.changePct >= 0 ? '+' : ''
    lines.push(`- Variação overnight: ${sign}${ctx.vix.changePct.toFixed(2)}%`)
  }
  lines.push('')

  // IV Rank
  lines.push('### IV Rank')
  if (ctx.ivRank.value != null) {
    lines.push(`- IV Rank: ${ctx.ivRank.value.toFixed(0)}% (${ctx.ivRank.label ?? 'n/a'})`)
  }
  if (ctx.ivRank.hv30 != null) {
    lines.push(`- HV30: ${ctx.ivRank.hv30.toFixed(1)}%`)
  }
  lines.push('')

  // Fear & Greed
  if (ctx.fearGreed?.score != null) {
    lines.push('### Fear & Greed')
    lines.push(`- Score: ${ctx.fearGreed.score} — ${ctx.fearGreed.label ?? ''}`)
    if (ctx.fearGreed.previousClose != null) {
      lines.push(`- Fechamento anterior: ${ctx.fearGreed.previousClose}`)
    }
    lines.push('')
  }

  // Earnings today / before open
  const todayEarnings = ctx.earnings.filter(
    (e) => e.daysToEarnings != null && e.daysToEarnings <= 1,
  )
  if (todayEarnings.length > 0) {
    lines.push('### Earnings Before Open')
    for (const e of todayEarnings) {
      lines.push(`- ${e.symbol} (dte: ${e.daysToEarnings ?? '?'}d)`)
    }
    lines.push('')
  }

  // Macro events today
  const todayEvents = ctx.macroEvents.filter(isTodayET)
  if (todayEvents.length > 0) {
    lines.push('### Eventos Macro Hoje')
    for (const ev of todayEvents) {
      const impact = ev.impact === 'high' ? '🔴' : ev.impact === 'medium' ? '🟡' : '🟢'
      const time = ev.time ? formatMacroEventTime(ev.time) : 'horário n/d'
      lines.push(
        `- ${impact} ${ev.event} (${time})` +
          (ev.estimate != null ? ` — estimativa: ${ev.estimate}${ev.unit ?? ''}` : ''),
      )
    }
    lines.push('')
  }

  // Headlines (use summary when enriched by gpt-4o-mini pipeline)
  if (ctx.headlines.length > 0) {
    lines.push('### Headlines Recentes')
    for (const h of ctx.headlines) {
      const text = h.summary ? `${h.summary} [${h.sentiment ?? 'neutral'}]` : `${h.title} (${h.source})`
      lines.push(`- ${text}`)
    }
    lines.push('')
  }

  // FRED macro data
  if (ctx.macro.length > 0) {
    lines.push('### Dados Macro (FRED)')
    for (const m of ctx.macro.slice(0, 4)) {
      lines.push(
        `- ${m.name}: ${m.value ?? 'n/d'}${m.unit} (anterior: ${m.previousValue ?? 'n/d'}${m.unit})`,
      )
    }
    lines.push('')
  }

  lines.push('=== FIM DOS DADOS ===')
  return lines.join('\n')
}

function buildPostClosePrompt(ctx: BriefingContext): string {
  const lines: string[] = ['=== POST-CLOSE DATA ===', '']

  // SPY session summary
  lines.push('### SPY — Sessão de Hoje')
  if (ctx.spy.open != null) lines.push(`- Abertura: $${ctx.spy.open.toFixed(2)}`)
  if (ctx.spy.last != null) lines.push(`- Fechamento: $${ctx.spy.last.toFixed(2)}`)
  if (ctx.spy.changePct != null) {
    const sign = ctx.spy.changePct >= 0 ? '+' : ''
    lines.push(`- Variação: ${sign}${ctx.spy.changePct.toFixed(2)}%`)
  }
  if (ctx.spy.dayHigh != null && ctx.spy.dayLow != null) {
    lines.push(`- Range: $${ctx.spy.dayLow.toFixed(2)} – $${ctx.spy.dayHigh.toFixed(2)}`)
  }
  lines.push('')

  // VIX
  lines.push('### VIX — Fechamento')
  if (ctx.vix.last != null) lines.push(`- VIX: ${ctx.vix.last.toFixed(2)} (${ctx.vix.level ?? 'n/a'})`)
  if (ctx.vix.changePct != null) {
    const sign = ctx.vix.changePct >= 0 ? '+' : ''
    lines.push(`- Variação no dia: ${sign}${ctx.vix.changePct.toFixed(2)}%`)
  }
  lines.push('')

  // Fear & Greed
  if (ctx.fearGreed?.score != null) {
    lines.push('### Fear & Greed')
    lines.push(`- Score: ${ctx.fearGreed.score} — ${ctx.fearGreed.label ?? ''}`)
    lines.push('')
  }

  // Macro events with actual results
  const todayEvents = ctx.macroEvents.filter(isTodayET)
  if (todayEvents.length > 0) {
    lines.push('### Eventos Macro — Resultados')
    for (const ev of todayEvents) {
      const impact = ev.impact === 'high' ? '🔴' : ev.impact === 'medium' ? '🟡' : '🟢'
      const actual = ev.actual != null ? `${ev.actual}${ev.unit ?? ''}` : 'n/d'
      const estimate = ev.estimate != null ? `${ev.estimate}${ev.unit ?? ''}` : 'n/d'
      lines.push(`- ${impact} ${ev.event}: real=${actual} vs estimativa=${estimate}`)
    }
    lines.push('')
  }

  // Earnings
  const todayEarnings = ctx.earnings.filter(
    (e) => e.daysToEarnings != null && e.daysToEarnings <= 1,
  )
  if (todayEarnings.length > 0) {
    lines.push('### Earnings do Dia')
    for (const e of todayEarnings) {
      lines.push(`- ${e.symbol}`)
    }
    lines.push('')
  }

  // FRED macro
  if (ctx.macro.length > 0) {
    lines.push('### Dados Macro (FRED)')
    for (const m of ctx.macro.slice(0, 4)) {
      lines.push(`- ${m.name}: ${m.value ?? 'n/d'}${m.unit}`)
    }
    lines.push('')
  }

  lines.push('=== FIM DOS DADOS ===')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Tradier pre-market price helper
// ---------------------------------------------------------------------------

async function getSpyPreMarketPrice(): Promise<number | null> {
  if (!CONFIG.TRADIER_API_KEY) return null

  try {
    const today = getTodayDateET()
    const url =
      `${CONFIG.TRADIER_BASE_URL}/v1/markets/timesales` +
      `?symbol=SPY&interval=1min&start=${today}%2004:00&session_filter=all`

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${CONFIG.TRADIER_API_KEY}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8_000),
    })

    if (!res.ok) return null

    const json = (await res.json()) as {
      series?: { data?: Array<{ time: string; close: number }> | { time: string; close: number } } | null
    }

    const raw = json?.series?.data
    const bars = Array.isArray(raw) ? raw : raw ? [raw] : []

    // Filter bars before 09:30 ET (pre-market) and take the last one
    const preMarketBars = bars.filter((b) => {
      // time format: "2026-03-01T09:29:00" — compare time portion only
      const timePart = b.time.split('T')[1] ?? b.time.split(' ')[1] ?? ''
      return timePart < '09:30:00'
    })

    if (preMarketBars.length === 0) return null
    return preMarketBars[preMarketBars.length - 1].close
  } catch {
    // Non-critical: briefing still generates without pre-market price
    return null
  }
}

// ---------------------------------------------------------------------------
// Discord webhook (embeds — description limit 4096; we use 4000 and split if needed)
// ---------------------------------------------------------------------------

/** Splits text at a line break near targetLen so we don't cut mid-sentence. */
function splitAtLineBreak(text: string, targetLen: number): [string, string] {
  if (text.length <= targetLen) return [text, '']
  const margin = 400
  const start = Math.max(0, targetLen - margin)
  const end = Math.min(text.length, targetLen + margin)
  const chunk = text.slice(start, end)
  const double = chunk.indexOf('\n\n')
  const single = chunk.indexOf('\n')
  let splitAt = targetLen
  if (double !== -1) splitAt = start + double + 2
  else if (single !== -1) splitAt = start + single + 1
  return [text.slice(0, splitAt).trim(), text.slice(splitAt).trim()]
}

async function sendToDiscord(markdown: string, type: 'pre-market' | 'post-close'): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL
  if (!webhookUrl) return

  const dateET = getTodayDateET()
  const title =
    type === 'pre-market'
      ? `🌅 Pré-Market Report: SPY — ${dateET}`
      : `🏁 Pós-Fechamento: SPY — ${dateET}`

  const embedColor = type === 'pre-market' ? DISCORD_EMBED_COLOR_PRE : DISCORD_EMBED_COLOR_POST
  const embeds: Array<{ title: string; description: string; color: number }> = []

  if (markdown.length <= DISCORD_EMBED_DESC_MAX) {
    embeds.push({ title, description: markdown, color: embedColor })
  } else {
    const [part1, part2] = splitAtLineBreak(markdown, DISCORD_EMBED_DESC_MAX)
    embeds.push({ title, description: part1, color: embedColor })
    embeds.push({
      title: `${type === 'pre-market' ? '🌅 Pré-Market' : '🏁 Pós-Fechamento'} (continuação)`,
      description: part2,
      color: embedColor,
    })
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds }),
  })

  if (!res.ok) {
    throw new Error(`Discord webhook HTTP ${res.status}`)
  }
}

// ---------------------------------------------------------------------------
// ET timezone helpers
// ---------------------------------------------------------------------------

function getETNow(): Date {
  // toLocaleString in America/New_York respects DST automatically
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
}

function getTodayDateET(): string {
  const et = getETNow()
  const y = et.getFullYear()
  const m = String(et.getMonth() + 1).padStart(2, '0')
  const d = String(et.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Returns an ISO string for a target time on the current ET calendar day.
 * dayOffset: 0 = today, 1 = tomorrow.
 */
function getExpirationET(targetHour: number, targetMin: number, dayOffset = 0): string {
  const et = getETNow()
  et.setHours(targetHour, targetMin, 0, 0)
  if (dayOffset > 0) et.setDate(et.getDate() + dayOffset)
  // Convert back to UTC ISO string via the original Date
  const offsetMs = new Date(et.toLocaleString('en-US', { timeZone: 'UTC' })).getTime() -
    new Date(et.toLocaleString('en-US', { timeZone: 'America/New_York' })).getTime()
  return new Date(et.getTime() + offsetMs).toISOString()
}

/** Returns true if a MacroEvent's time field falls on today in ET. */
function isTodayET(ev: MacroEvent): boolean {
  if (!ev.time) return false
  try {
    const dateStr = ev.time.split(' ')[0] ?? ev.time.split('T')[0]
    return dateStr === getTodayDateET()
  } catch {
    return false
  }
}

/** Formats a Finnhub event time string ('YYYY-MM-DD HH:MM:SS' UTC) to 'HH:MM ET'. */
function formatMacroEventTime(time: string): string {
  try {
    const iso = time.replace(' ', 'T') + 'Z'  // treat as UTC
    const et = new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York' }))
    return `${String(et.getHours()).padStart(2, '0')}:${String(et.getMinutes()).padStart(2, '0')} ET`
  } catch {
    return time
  }
}

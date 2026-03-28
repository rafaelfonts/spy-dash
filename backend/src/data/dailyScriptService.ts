/**
 * Daily Script — automatic recap (roteiro) generated at 16:20 ET (5min after close).
 *
 * Condenses the entire day's briefing, signals, and macro events into a cohesive narrative.
 * References pre-market briefing setup, 10:30 signal, 15:00 signal, and closing summary.
 *
 * Cache: one script per calendar day (ET), backed by Redis.
 */

import Anthropic from '@anthropic-ai/sdk'
import { marketState, newsSnapshot, emitter } from './marketState'
import { cacheGet, cacheSet, redis } from '../lib/cacheStore'
import { sendEmbed, DISCORD_COLORS } from '../lib/discordClient'
import { getPortfolioSnapshot } from './portfolioTrackerService'
import { getAdvancedMetricsSnapshot } from './advancedMetricsState'
import { getTodaysBriefing } from './preMarketBriefing'
import { getLastScheduledSignal } from './scheduledSignalService'
import type { PreMarketBriefing } from '../types/market'
import { CONFIG } from '../config'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRIPT_TTL_MS = 14 * 60 * 60 * 1000  // 14h — survives overnight

const DAILY_SCRIPT_PROMPT = `Você é o Narrador Estratégico do SPY Dash. O dia de trading acabou. Sua tarefa é tecer uma narrativa coesa que conecte:
1. O Setup Matemático identificado no briefing 9h
2. A confirmação/rejeição do setup no sinal 10:30
3. A evolução do regime durante o dia (sinal 15:00)
4. O resultado final no fechamento

O script deve contar a história do dia — não como lista de fatos, mas como narrativa que explique a dinâmica de preço, GEX, regime e decisões tomadas/descartadas.

REGRAS DE FORMATAÇÃO E ESTILO (INEGOCIÁVEIS):
1. ZERO RUÍDO: Sem saudações, explicações teóricas ou fechamentos. Comece imediatamente.
2. CONCISÃO EXTREMA: Máximo 2.000 caracteres. Use parágrafos curtos e ritmo ágil.
3. ESTRUTURA OBRIGATÓRIA:
- **Abertura Matemática**: O setup do briefing 9h — qual era a oportunidade estrutural?
- **Teste do Setup (10:30)**: O setup foi confirmado ou rejeitado? Qual era o regime score?
- **Evolução Intraday (15:00)**: Como o regime mudou ao longo do dia? Qual foi a revisão do score?
- **Desfecho no Fechamento**: Para onde SPY convergiu vs. as estruturas de GEX? O dia resolveu o conflito?
- **Lição do Dia**: Uma frase-resumo sobre o que o dia ensinou para amanhã.

ESTILO: Telegráfico, direto, como um briefing pós-sesão para quem acompanhou os sinais.
PROIBIÇÃO: Não recrie os sinais. Apenas referenças a eles ("Sinal 10:30: OPERAR"; "Regime 15:00: 7/10"). Não invente resultados.
PROIBIÇÃO DE TERMOS TÉCNICOS DE BACKEND: Nunca instrua o usuário a 'abrir Supabase' ou 'consultar banco de dados'. Use jargão de trading público.`

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let todaysScript: PreMarketBriefing | null = null  // reuse same type structure

export function getTodaysScript(): PreMarketBriefing | null {
  return todaysScript
}

// ---------------------------------------------------------------------------
// Bootstrap: restore from Redis on server start
// ---------------------------------------------------------------------------

export async function restoreDailyScriptFromCache(): Promise<void> {
  const today = getTodayDateET()
  const key = `cache:daily_script:${today}`

  const script = await cacheGet<PreMarketBriefing>(key)

  if (script) {
    todaysScript = script
    console.log(`[DailyScript] Script restaurado do Redis (${today})`)
  }
}

// ---------------------------------------------------------------------------
// Scheduler — checks every 60s whether it's 16:20 ET
// ---------------------------------------------------------------------------

export function startDailyScriptScheduler(): void {
  setInterval(() => {
    const et = getETNow()
    const dow = et.getDay()   // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) return

    const h = et.getHours()
    const m = et.getMinutes()

    if (h === 16 && m === 20) {
      generateDailyScript().catch((err) =>
        console.error('[DailyScript] Scheduler erro:', err),
      )
    }
  }, 60_000)

  console.log('[DailyScript] Scheduler iniciado (16:20 ET, dias úteis)')
}

// ---------------------------------------------------------------------------
// Core generator
// ---------------------------------------------------------------------------

async function generateDailyScript(): Promise<void> {
  const today = getTodayDateET()
  const cacheKey = `cache:daily_script:${today}`

  // Distributed lock
  const lockKey = `lock:daily_script:${today}`
  const acquired = await redis.set(lockKey, '1', 'EX', 300, 'NX')
  if (!acquired) {
    console.log(`[DailyScript] Lock não adquirido — outra instância está gerando`)
    return
  }

  // Cooldown: skip if we already have a script for today
  const existing = await cacheGet<PreMarketBriefing>(cacheKey)
  if (existing) {
    console.log(`[DailyScript] Script já existe para ${today} — pulando geração`)
    if (!todaysScript) todaysScript = existing
    return
  }

  console.log(`[DailyScript] Gerando script do dia...`)

  try {
    const context = await buildScriptContext()
    const userPrompt = buildScriptPrompt(context)

    let markdown = ''
    let usedClaude = false
    const useClaude = Boolean(CONFIG.ANTHROPIC_API_KEY)

    if (!CONFIG.ANTHROPIC_API_KEY) {
      console.error('[CRITICAL] ANTHROPIC_API_KEY is missing — script será gerado via OpenAI')
    }

    if (useClaude) {
      try {
        const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY })
        const msg = await anthropic.messages.create({
          model: CONFIG.ANTHROPIC_MODEL,
          max_tokens: 4096,
          system: DAILY_SCRIPT_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
        })
        const textBlock = msg.content.find((b): b is { type: 'text'; text: string } => b.type === 'text')
        markdown = textBlock?.text?.trim() ?? ''
        if (markdown) {
          usedClaude = true
          console.log('[DailyScript] Script gerado via Claude')
        }
      } catch (err) {
        console.warn(`[FALLBACK] Falha na Anthropic: ${(err as Error).message}. Roteando para OpenAI...`)
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
            { role: 'system', content: DAILY_SCRIPT_PROMPT },
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

    const expiresAt = getExpirationET(6, 0, 1)  // 06:00 ET do dia seguinte

    const script: PreMarketBriefing = {
      type: 'daily-script',
      generatedAt: new Date().toISOString(),
      markdown,
      expiresAt,
    }

    await cacheSet(cacheKey, script, SCRIPT_TTL_MS, 'daily_script')
    todaysScript = script

    // Broadcast to all connected SSE clients
    emitter.emit('daily_script', script)

    // Discord — fire-and-forget (#briefings channel)
    await sendEmbed('briefings', {
      title: '📜 Roteiro do Dia — SPY Dash',
      description: markdown,
      color: DISCORD_COLORS.dailyScript ?? 0x9b59b6,  // purple as fallback
      footer: { text: `Gerado às ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}` },
      timestamp: new Date().toISOString(),
    })

    console.log(`[DailyScript] Script gerado com sucesso`)
  } catch (err) {
    console.error(`[DailyScript] Erro ao gerar script:`, err)
  }
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

interface ScriptContext {
  spy: {
    open: number | null
    last: number | null
    prevClose: number | null
    changePct: number | null
    dayHigh: number | null
    dayLow: number | null
  }
  vix: {
    last: number | null
    changePct: number | null
  }
  briefing: {
    thesis: string
    markdown: string
  } | null
  signal_1030: {
    decision: string
    regime_score: number | null
    support?: number[]
    resistance?: number[]
  } | null
  signal_1500: {
    decision: string
    regime_score: number | null
  } | null
  portfolio: {
    count: number
    positions_summary: string
  }
  gex_closing: string  // GEX structure summary at close
}

async function buildScriptContext(): Promise<ScriptContext> {
  const briefing = getTodaysBriefing()
  const signal10 = await cacheGet<any>(`cache:trade_signal_slot:${getTodayDateET()}:10:30`)
  const signal15 = await cacheGet<any>(`cache:trade_signal_slot:${getTodayDateET()}:15:00`)
  const advSnap = getAdvancedMetricsSnapshot()
  const portfolio = getPortfolioSnapshot()

  // GEX closing structure summary
  let gexClosing = 'Não disponível'
  if (advSnap?.gexDynamic && advSnap.gexDynamic.length > 0) {
    const mainGex = advSnap.gexDynamic[0]?.gex
    if (mainGex) {
      const parts = []
      if (mainGex.flipPoint != null) parts.push(`Flip Point: $${mainGex.flipPoint.toFixed(2)}`)
      if (mainGex.totalNetGamma != null) {
        const sign = mainGex.totalNetGamma >= 0 ? '+' : ''
        parts.push(`GEX: ${sign}$${mainGex.totalNetGamma.toFixed(1)}M`)
      }
      if (mainGex.regime) parts.push(`Regime: ${mainGex.regime.toUpperCase()}`)
      gexClosing = parts.join(' | ') || 'Não disponível'
    }
  }

  // Portfolio summary
  const positions = portfolio?.positions ?? []
  let portfolioSummary = 'Carteira zerada'
  if (positions.length > 0) {
    const totalPL = positions.reduce((s, p) => s + p.profit_percentage, 0)
    const avgPL = (totalPL / positions.length).toFixed(1)
    portfolioSummary = `${positions.length} posição(ões): P/L médio ${avgPL}%`
  }

  return {
    spy: {
      open: marketState.spy.open,
      last: marketState.spy.last,
      prevClose: marketState.spy.prevClose,
      changePct: marketState.spy.changePct,
      dayHigh: marketState.spy.dayHigh,
      dayLow: marketState.spy.dayLow,
    },
    vix: {
      last: marketState.vix.last,
      changePct: marketState.vix.changePct,
    },
    briefing: briefing && briefing.type === 'pre-market' ? {
      thesis: '',  // Could extract from markdown if needed
      markdown: briefing.markdown,
    } : null,
    signal_1030: signal10 ? {
      decision: signal10.trade_signal ?? 'wait',
      regime_score: signal10.regime_score,
      support: signal10.key_levels?.support,
      resistance: signal10.key_levels?.resistance,
    } : null,
    signal_1500: signal15 ? {
      decision: signal15.trade_signal ?? 'wait',
      regime_score: signal15.regime_score,
    } : null,
    portfolio: {
      count: positions.length,
      positions_summary: portfolioSummary,
    },
    gex_closing: gexClosing,
  }
}

function buildScriptPrompt(ctx: ScriptContext): string {
  const lines: string[] = ['=== DAILY RECAP DATA ===', '']

  // SPY session
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
  if (ctx.vix.last != null) lines.push(`- VIX: ${ctx.vix.last.toFixed(2)}`)
  if (ctx.vix.changePct != null) {
    const sign = ctx.vix.changePct >= 0 ? '+' : ''
    lines.push(`- Variação: ${sign}${ctx.vix.changePct.toFixed(2)}%`)
  }
  lines.push('')

  // GEX at close
  lines.push('### Estrutura GEX no Fechamento')
  lines.push(`- ${ctx.gex_closing}`)
  lines.push('')

  // Briefing 9h setup
  if (ctx.briefing) {
    lines.push('### Setup Matemático (Briefing 9h)')
    lines.push(ctx.briefing.markdown)
    lines.push('')
  }

  // Signal 10:30
  if (ctx.signal_1030) {
    lines.push('### Sinal 10:30 ET')
    const labelMap = { trade: 'OPERAR', wait: 'AGUARDAR', avoid: 'NÃO OPERAR' }
    lines.push(`- Decisão: ${labelMap[ctx.signal_1030.decision] ?? ctx.signal_1030.decision}`)
    if (ctx.signal_1030.regime_score != null) {
      lines.push(`- Regime Score: ${ctx.signal_1030.regime_score}/10`)
    }
    if (ctx.signal_1030.support?.length) {
      lines.push(`- Suporte: $${ctx.signal_1030.support.join(', ')}`)
    }
    if (ctx.signal_1030.resistance?.length) {
      lines.push(`- Resistência: $${ctx.signal_1030.resistance.join(', ')}`)
    }
    lines.push('')
  }

  // Signal 15:00
  if (ctx.signal_1500) {
    lines.push('### Sinal 15:00 ET')
    const labelMap = { trade: 'OPERAR', wait: 'AGUARDAR', avoid: 'NÃO OPERAR' }
    lines.push(`- Decisão: ${labelMap[ctx.signal_1500.decision] ?? ctx.signal_1500.decision}`)
    if (ctx.signal_1500.regime_score != null) {
      lines.push(`- Regime Score: ${ctx.signal_1500.regime_score}/10`)
    }
    lines.push('')
  }

  // Portfolio
  lines.push('### Portfólio')
  lines.push(`- ${ctx.portfolio.positions_summary}`)
  lines.push('')

  lines.push('=== FIM DOS DADOS ===')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// ET timezone helpers
// ---------------------------------------------------------------------------

function getETNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
}

function getTodayDateET(): string {
  const et = getETNow()
  const y = et.getFullYear()
  const m = String(et.getMonth() + 1).padStart(2, '0')
  const d = String(et.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function getExpirationET(targetHour: number, targetMin: number, dayOffset = 0): string {
  const et = getETNow()
  et.setHours(targetHour, targetMin, 0, 0)
  if (dayOffset > 0) et.setDate(et.getDate() + dayOffset)
  const offsetMs = new Date(et.toLocaleString('en-US', { timeZone: 'UTC' })).getTime() -
    new Date(et.toLocaleString('en-US', { timeZone: 'America/New_York' })).getTime()
  return new Date(et.getTime() + offsetMs).toISOString()
}

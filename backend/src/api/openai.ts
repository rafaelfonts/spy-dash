import type { FastifyInstance } from 'fastify'
import type { ServerResponse } from 'http'
import { analysisRateLimit } from '../middleware/rateLimiter'
import { CONFIG } from '../config'
import { marketState, newsSnapshot } from '../data/marketState'
import type { OptionExpiry } from '../data/optionChain'
import { getOptionChainCapturedAt } from '../data/optionChain'
import { humanizeAge } from '../lib/time'
import type { MacroDataItem, FearGreedData, MacroEvent, EarningsItem } from '../types/market'

interface ContextData {
  fearGreed?: { score: FearGreedData['score']; label: FearGreedData['label'] }
  macro?: MacroDataItem[]
  bls?: MacroDataItem[]
  macroEvents?: MacroEvent[]
  earnings?: EarningsItem[]
}

interface FreshnessBlock {
  spy?: string
  vix?: string
  ivRank?: string
  optionChain?: string
  fearGreed?: string
  macro?: string
  bls?: string
  macroEvents?: string
  earnings?: string
}

interface AnalyzeBody {
  marketSnapshot?: {
    spy?: { last: number; change: number; changePct: number }
    vix?: { last: number; level: string }
    ivRank?: { value: number; percentile: number; label: string }
  }
  optionChain?: OptionExpiry[]
  context?: ContextData
  freshness?: FreshnessBlock
}

function formatMacroValue(value: number, unit: string): string {
  if (unit === '%' || unit === '% YoY') return `${value.toFixed(2)}%`
  if (unit === 'K') return `${value.toLocaleString('en-US')}K`
  if (unit === '$/h') return `$${value.toFixed(2)}`
  return value.toFixed(2)
}

/** Format a Greek value to fixed decimal places, or empty string if null. */
function fmtGreek(v: number | null | undefined, decimals: number): string {
  if (v == null) return ''
  return v.toFixed(decimals)
}

function buildPrompt(
  snapshot: AnalyzeBody['marketSnapshot'],
  chain?: OptionExpiry[],
  context?: ContextData,
  freshness?: FreshnessBlock,
): string {
  const spy = snapshot?.spy
  const vix = snapshot?.vix
  const ivRank = snapshot?.ivRank

  let prompt = `Análise de mercado atual:\n\n`

  // --- Dados de mercado em tempo real ---
  const spyAge = freshness?.spy ? ` ${humanizeAge(freshness.spy)}` : ''
  const vixAge = freshness?.vix ? ` ${humanizeAge(freshness.vix)}` : ''
  const ivAge = freshness?.ivRank ? ` ${humanizeAge(freshness.ivRank)}` : ''
  const fgAge = freshness?.fearGreed ? ` ${humanizeAge(freshness.fearGreed)}` : ''

  if (spy) {
    prompt += `**SPY**${spyAge}: $${spy.last?.toFixed(2)} | Variação: ${spy.change >= 0 ? '+' : ''}${spy.change?.toFixed(2)} (${spy.changePct?.toFixed(2)}%)\n`
  }
  if (vix) {
    prompt += `**VIX**${vixAge}: ${vix.last?.toFixed(2)} | Nível: ${vix.level}\n`
  }
  if (ivRank) {
    prompt += `**IV Rank SPY**${ivAge}: ${ivRank.value?.toFixed(1)}% | Percentil: ${ivRank.percentile?.toFixed(1)}% | Classificação: ${ivRank.label}\n`
  }
  if (context?.fearGreed?.score !== null && context?.fearGreed?.score !== undefined) {
    prompt += `**Fear & Greed**${fgAge}: ${context.fearGreed.score}/100 — ${context.fearGreed.label}\n`
  }

  // --- Cadeia de opções: ATM ±5 strikes para as 3 expirações mais próximas ---
  const chainAge = freshness?.optionChain ? ` ${humanizeAge(freshness.optionChain)}` : ''
  if (chain && chain.length > 0) {
    const spyLast = spy?.last ?? 0
    prompt += `\n**Cadeia de Opções SPY (strikes próximos ATM)**${chainAge}:\n`
    for (const exp of chain.slice(0, 3)) {
      const atmCalls = exp.calls
        .filter((c) => c.bid !== null && c.ask !== null)
        .sort((a, b) => Math.abs(a.strike - spyLast) - Math.abs(b.strike - spyLast))
        .slice(0, 5)

      if (atmCalls.length === 0) continue

      // Determine dominant greek source for this expiry
      const apiLegs = exp.calls.filter((c) => c.greeksSource === 'api').length
      const bsLegs = exp.calls.filter((c) => c.greeksSource === 'calculated').length
      const srcLabel = apiLegs >= bsLegs ? '(greeks: api)' : '(greeks: BS)'

      prompt += `\nExpiração ${exp.expirationDate} (${exp.dte} DTE) ${srcLabel}:\n`
      prompt += `Strike | Call (bid/ask/Δ/θ) | Put (bid/ask/Δ/θ)\n`
      for (const call of atmCalls) {
        const put = exp.puts.find((p) => p.strike === call.strike)

        const callBidAsk = `bid=${call.bid} ask=${call.ask}`
        const callDelta = call.delta != null ? ` Δ${fmtGreek(call.delta, 2)}` : ''
        const callTheta = call.theta != null ? ` θ${fmtGreek(call.theta, 2)}` : ''
        const callStr = `$${call.strike}C: ${callBidAsk}${callDelta}${callTheta}`

        let putStr = '—'
        if (put) {
          const putBidAsk =
            put.bid != null && put.ask != null ? `bid=${put.bid} ask=${put.ask}` : '—'
          const putDelta = put.delta != null ? ` Δ${fmtGreek(put.delta, 2)}` : ''
          const putTheta = put.theta != null ? ` θ${fmtGreek(put.theta, 2)}` : ''
          putStr = `$${put.strike}P: ${putBidAsk}${putDelta}${putTheta}`
        }

        prompt += `${callStr} | ${putStr}\n`
      }
    }
  }

  // --- Contexto macroeconômico (FRED + BLS) ---
  const macroAge = freshness?.macro ? ` ${humanizeAge(freshness.macro)}` : ''
  const blsAge = freshness?.bls ? ` ${humanizeAge(freshness.bls)}` : ''
  const allMacro = [...(context?.macro ?? []), ...(context?.bls ?? [])]
  if (allMacro.length > 0) {
    const hasMacro = (context?.macro?.length ?? 0) > 0
    const hasBls = (context?.bls?.length ?? 0) > 0
    let macroLabel = 'Contexto Macroeconômico'
    if (hasMacro && hasBls) {
      macroLabel = `Contexto Macroeconômico (FRED${macroAge} + BLS${blsAge})`
    } else if (hasMacro) {
      macroLabel = `Contexto Macroeconômico (FRED${macroAge})`
    } else if (hasBls) {
      macroLabel = `Contexto Macroeconômico (BLS${blsAge})`
    }
    prompt += `\n**${macroLabel}:**\n`
    for (const item of allMacro) {
      if (item.value === null) continue
      const dir =
        item.previousValue !== null
          ? item.value > item.previousValue
            ? '▲'
            : item.value < item.previousValue
              ? '▼'
              : '→'
          : ''
      prompt += `- ${item.name}: ${dir} ${formatMacroValue(item.value, item.unit)} (${item.date})\n`
    }
  }

  // --- Earnings de componentes SPY com prazo ≤7 dias ---
  const earningsAge = freshness?.earnings ? ` ${humanizeAge(freshness.earnings)}` : ''
  const urgentEarnings = (context?.earnings ?? []).filter(
    (e) => e.daysToEarnings !== null && e.daysToEarnings >= 0 && e.daysToEarnings <= 7,
  )
  if (urgentEarnings.length > 0) {
    prompt += `\n**Earnings de componentes SPY (próximos 7 dias)**${earningsAge}:\n`
    for (const e of urgentEarnings.slice(0, 6)) {
      prompt += `- ${e.symbol}: ${e.earningsDate ?? '?'} (em ${e.daysToEarnings} dias)\n`
    }
  }

  // --- Eventos macro de alto impacto nas próximas 48h ---
  const eventsAge = freshness?.macroEvents ? ` ${humanizeAge(freshness.macroEvents)}` : ''
  const highImpact = (context?.macroEvents ?? []).filter((ev) => ev.impact === 'high')
  if (highImpact.length > 0) {
    prompt += `\n**Eventos macro de alto impacto (próximas 48h)**${eventsAge}:\n`
    for (const ev of highImpact.slice(0, 6)) {
      const est = ev.estimate !== null ? ` | Est: ${ev.estimate}${ev.unit ?? ''}` : ''
      const prev = ev.prev !== null ? ` | Prev: ${ev.prev}${ev.unit ?? ''}` : ''
      prompt += `- ${ev.time ? `[${ev.time}] ` : ''}${ev.event}${est}${prev}\n`
    }
  }

  prompt += `\nCom base nessas condições de mercado, forneça:\n`
  prompt += `1. Análise do ambiente de volatilidade atual\n`
  prompt += `2. Estratégias de opções mais adequadas para este momento\n`
  prompt += `3. Considerações de risco específicas para SPY hoje\n`
  prompt += `4. Níveis técnicos importantes para monitorar\n`

  return prompt
}

export async function registerOpenAI(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: AnalyzeBody }>('/api/analyze', { preHandler: [analysisRateLimit] }, async (request, reply) => {
    const body = request.body ?? {}
    const snapshot = body.marketSnapshot ?? {
      spy: marketState.spy.last
        ? {
            last: marketState.spy.last,
            change: marketState.spy.change ?? 0,
            changePct: marketState.spy.changePct ?? 0,
          }
        : undefined,
      vix: marketState.vix.last
        ? { last: marketState.vix.last, level: marketState.vix.level ?? 'unknown' }
        : undefined,
      ivRank: marketState.ivRank.value
        ? {
            value: marketState.ivRank.value,
            percentile: marketState.ivRank.percentile ?? 0,
            label: marketState.ivRank.label ?? 'unknown',
          }
        : undefined,
    }

    // Derive freshness: prefer client-supplied body.freshness, fall back to server-side timestamps
    const msToIso = (ms: number): string | undefined =>
      ms > 0 ? new Date(ms).toISOString() : undefined

    const freshness: FreshnessBlock = body.freshness ?? {
      spy: msToIso(marketState.spy.lastUpdated),
      vix: msToIso(marketState.vix.lastUpdated),
      ivRank: msToIso(marketState.ivRank.lastUpdated),
      optionChain: msToIso(getOptionChainCapturedAt()),
      fearGreed: newsSnapshot.fearGreed?.lastUpdated
        ? msToIso(newsSnapshot.fearGreed.lastUpdated)
        : undefined,
      macro: msToIso(newsSnapshot.macroTs),
      bls: msToIso(newsSnapshot.blsTs),
      macroEvents: msToIso(newsSnapshot.macroEventsTs),
      earnings: msToIso(newsSnapshot.earningsTs),
    }

    const res = reply.raw as ServerResponse
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    // Immediate ping so proxies with short read-timeout don't kill the connection
    // before the first GPT-4o token arrives
    res.write('event: ping\ndata: starting\n\n')

    const userId = (request as any).user?.sub ?? 'unknown'
    console.log(`[ANALYZE] user=${userId} model=gpt-4o tokens_max=1200`)

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    try {
      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          stream: true,
          max_tokens: 1200,
          messages: [
            {
              role: 'system',
              content:
                'Você é um especialista sênior em opções americanas, com foco em SPY e ETFs de grande liquidez. ' +
                'Suas análises são concisas, objetivas e acionáveis. ' +
                'Use markdown para formatar suas respostas com headers, listas e destaques. ' +
                'Dados marcados [AO VIVO] têm máxima relevância para análise de timing. ' +
                'Dados marcados [RECENTE] são muito confiáveis para decisões táticas. ' +
                'Dados marcados [SNAPSHOT] são contexto estrutural — use-os para direção de tendência, não para decisões de entrada/saída. ' +
                'Use delta para avaliar probabilidade ITM (call ATM ≈ 0.50 ≈ 50% de chance de expirar ITM). ' +
                'Use theta para comparar custo de carregamento diário entre strikes e expirações — theta é maior em magnitude em 0DTE.',
            },
            {
              role: 'user',
              content: buildPrompt(snapshot, body.optionChain, body.context, freshness),
            },
          ],
        }),
      })

      if (!openaiRes.ok) {
        const text = await openaiRes.text()
        sendEvent('error', { message: `OpenAI error: ${openaiRes.status} — ${text}` })
        res.end()
        return
      }

      const reader = openaiRes.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data === '[DONE]') {
              sendEvent('done', {})
              res.end()
              reply.hijack()
              return
            }
            try {
              const parsed = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string } }>
              }
              const content = parsed.choices?.[0]?.delta?.content
              if (content) {
                sendEvent('token', { text: content })
              }
            } catch {
              // skip malformed lines
            }
          }
        }
      }

      sendEvent('done', {})
      res.end()
    } catch (err) {
      sendEvent('error', { message: (err as Error).message })
      res.end()
    }

    reply.hijack()
  })
}

// backend/src/api/equityAnalyze.ts
import type { FastifyInstance } from 'fastify'
import OpenAI from 'openai'
import { getTradierClient } from '../lib/tradierClient.js'
import { CONFIG } from '../config.js'
import { computeEquityTechnicals } from '../lib/equityTechnicals.js'
import type { TradierBar } from '../lib/equityTechnicals.js'
import { scoreEquityRegime } from '../lib/equityRegimeScorer.js'
import { buildEquityMemoryBlock, saveEquityAnalysis } from '../data/equityMemory.js'
import { searchLiveNews } from '../lib/tavilyClient.js'
import type { TavilyResult } from '../lib/tavilyClient.js'
import { buildEquityNewsDigest } from '../lib/equityNewsDigest.js'
import { cacheGet, cacheSet } from '../lib/cacheStore.js'
import type { AnalysisStructuredEquity, EquityTechnicals } from '../types/market.js'

const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY })

// 30 minutes TTL for Tavily equity news cache
const TAVILY_EQUITY_TTL_MS = 30 * 60 * 1000

// ---------------------------------------------------------------------------
// JSON Schema — full AnalysisStructuredEquity
// ---------------------------------------------------------------------------

const EQUITY_ANALYSIS_SCHEMA = {
  name: 'equity_analysis_output',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      symbol:               { type: 'string' },
      setup:                { type: 'string' },
      entry_range:          { type: 'string' },
      target:               { type: 'string' },
      stop:                 { type: 'string' },
      risk_reward:          { type: 'string' },
      confidence:           { type: 'string', enum: ['ALTA', 'MÉDIA', 'BAIXA'] },
      warning:              { anyOf: [{ type: 'string' }, { type: 'null' }] },
      equity_regime_score:  { type: 'integer' },
      rsi_zone:             { type: 'string', enum: ['oversold', 'neutral', 'overbought'] },
      trend:                { type: 'string', enum: ['uptrend', 'downtrend', 'sideways'] },
      catalyst_confirmed:   { type: 'boolean' },
      timeframe:            { type: 'string', enum: ['1d', '2d', '3-5d'] },
      invalidation_level:   { anyOf: [{ type: 'number' }, { type: 'null' }] },
      key_levels: {
        type: 'object',
        properties: {
          support:    { type: 'array', items: { type: 'number' } },
          resistance: { type: 'array', items: { type: 'number' } },
        },
        required: ['support', 'resistance'],
        additionalProperties: false,
      },
      trade_signal:     { type: 'string', enum: ['trade', 'wait', 'avoid'] },
      no_trade_reasons: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'symbol', 'setup', 'entry_range', 'target', 'stop', 'risk_reward',
      'confidence', 'warning', 'equity_regime_score', 'rsi_zone', 'trend',
      'catalyst_confirmed', 'timeframe', 'invalidation_level', 'key_levels',
      'trade_signal', 'no_trade_reasons',
    ],
    additionalProperties: false,
  },
}

// ---------------------------------------------------------------------------
// Tavily tool definition
// ---------------------------------------------------------------------------

const SEARCH_EQUITY_NEWS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'search_equity_news',
    description:
      'Search for recent news about the stock. Use when: (1) high volume without known catalyst, ' +
      '(2) large price move without technical explanation, (3) potential earnings catalyst.',
    parameters: {
      type: 'object',
      properties: {
        query:  { type: 'string', description: 'Search query e.g. "NVDA news today earnings"' },
        reason: { type: 'string', description: 'Why you are searching' },
      },
      required: ['query', 'reason'],
    },
  },
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildEquityPrompt(
  symbol: string,
  quoteBlock: string,
  priceBlock: string,
  newsBlock: string,
  technicals: EquityTechnicals,
  regimeScore: number,
  regimeComponents: ReturnType<typeof scoreEquityRegime>['components'],
  memoryBlock: string,
): string {
  const t = technicals
  const techBlock = [
    `RSI(14): ${t.rsi?.toFixed(1) ?? 'n/a'} [${t.rsiZone}]`,
    `MACD: ${t.macd?.value?.toFixed(4) ?? 'n/a'} | Histograma: ${t.macd?.histogram?.toFixed(4) ?? 'n/a'} | Sinal: ${t.macdCross}`,
    `BB: Upper=${t.bb?.upper?.toFixed(2) ?? 'n/a'} Middle=${t.bb?.middle?.toFixed(2) ?? 'n/a'} Lower=${t.bb?.lower?.toFixed(2) ?? 'n/a'} | %B=${t.bbPercentB?.toFixed(2) ?? 'n/a'}`,
    `VWAP: ${t.vwap?.toFixed(2) ?? 'n/a'}`,
    `Tendência: ${t.trend}`,
  ].join('\n')

  const regimeBlock = [
    `Score: ${regimeScore}/10`,
    `Componentes: RSI=${regimeComponents.rsi} MACD=${regimeComponents.macd} BB=${regimeComponents.bb} Catalisador=${regimeComponents.catalyst} SPY=${regimeComponents.spyAlignment}`,
  ].join('\n')

  const memSection = memoryBlock
    ? `\n## Memória (análises recentes)\n${memoryBlock}\n`
    : ''

  return `Você é um analista quantitativo de swing trade. Analise ${symbol} para uma operação de 1–5 dias com capital de $50.

## Dados do Mercado (${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/New_York' })} ET)
${quoteBlock}

## Histórico de Preço (barras intraday 1min)
${priceBlock}

## Indicadores Técnicos
${techBlock}

## Regime Score (PRÉ-COMPUTADO — NÃO recalcule)
${regimeBlock}

## Notícias Hoje
${newsBlock}
${memSection}
## Instruções
- setup deve ter no máximo 2 frases em pt-BR descrevendo o contexto técnico e direcional
- entry_range, target e stop em formato "$X.XX"
- risk_reward como "1.5:1"
- warning pode ser null se não houver alerta específico
- equity_regime_score: use exatamente o valor pré-computado acima (NÃO altere)
- rsi_zone e trend: reflitam os indicadores técnicos acima
- catalyst_confirmed: true somente se houver catalisador confirmado (notícia Tavily ou Finnhub)
- trade_signal: "trade" = setup completo e favorável; "wait" = setup incompleto ou indefinido; "avoid" = risco elevado ou condições adversas
- no_trade_reasons: lista as razões para wait/avoid, ou [] se trade_signal = "trade"
- key_levels: identifique suportes e resistências próximos ao preço atual (2–4 cada)
- invalidation_level: nível que invalida o setup (ex: rompimento de suporte), ou null`
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerEquityAnalyzeRoute(app: FastifyInstance): Promise<void> {
  app.post('/api/equity/analyze', async (request, reply) => {
    // Authentication — userId is set by the global requireAuth preHandler
    const userId: string = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Não autenticado' })
    }

    const { symbol: rawSymbol } = request.body as { symbol?: string }
    if (
      !rawSymbol ||
      typeof rawSymbol !== 'string' ||
      !/^[A-Z]{1,5}$/.test(rawSymbol.trim().toUpperCase())
    ) {
      return reply.status(400).send({ error: 'symbol inválido' })
    }

    const symbol = rawSymbol.trim().toUpperCase()
    const todayDate = new Date().toISOString().split('T')[0]

    // -----------------------------------------------------------------------
    // 1. Data gathering
    // -----------------------------------------------------------------------
    const tradier = getTradierClient()

    const [quotes, timesalesRaw] = await Promise.allSettled([
      tradier.getQuotes([symbol]),
      tradier.getTimeSales(symbol),
    ])

    const q = quotes.status === 'fulfilled' ? quotes.value[0] : null
    const quoteBlock = q
      ? `Preço: $${q.last ?? q.close ?? 'N/A'} | Var: ${q.change_percentage?.toFixed(2) ?? 'N/A'}% | Vol: ${q.volume?.toLocaleString() ?? 'N/A'} | AvgVol: ${q.average_volume?.toLocaleString() ?? 'N/A'}`
      : 'Cotação indisponível'

    const bars: TradierBar[] =
      timesalesRaw.status === 'fulfilled' ? (timesalesRaw.value as TradierBar[]) : []

    // Price block: all bars formatted (up to 390)
    const priceBlock =
      bars.length > 0
        ? bars.map((b) => `${b.time}: $${b.close}`).join(' | ')
        : 'Histórico indisponível'

    // Finnhub news
    let newsBlock = 'Notícias indisponíveis'
    let news: Array<{ headline: string }> = []
    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${todayDate}&to=${todayDate}&token=${CONFIG.FINNHUB_API_KEY}`,
        { signal: AbortSignal.timeout(5000) }
      )
      if (res.ok) {
        news = await res.json() as Array<{ headline: string }>
        newsBlock =
          news.slice(0, 3).map((n) => `- ${n.headline}`).join('\n') || 'Sem notícias hoje'
      }
    } catch { /* ignora */ }

    // -----------------------------------------------------------------------
    // 2. Compute technicals
    // -----------------------------------------------------------------------
    const technicals = computeEquityTechnicals(bars)

    // -----------------------------------------------------------------------
    // 3. Initial regime score (tavilyConfirmed not yet known)
    // -----------------------------------------------------------------------
    const hasCatalyst = news.length > 0
    let tavilyConfirmed = false
    let regimeResult = scoreEquityRegime({ technicals, tavilyConfirmed, hasCatalyst })

    // -----------------------------------------------------------------------
    // 4. Build memory block
    // -----------------------------------------------------------------------
    const memoryBlock = await buildEquityMemoryBlock(userId, symbol, technicals.rsi)

    // -----------------------------------------------------------------------
    // 5. Build initial messages for OpenAI tool-calling loop
    // -----------------------------------------------------------------------
    const systemPrompt = buildEquityPrompt(
      symbol,
      quoteBlock,
      priceBlock,
      newsBlock,
      technicals,
      regimeResult.score,
      regimeResult.components,
      memoryBlock,
    )

    type OAIMessage = OpenAI.Chat.ChatCompletionMessageParam

    const messages: OAIMessage[] = [
      { role: 'user', content: systemPrompt },
    ]

    // -----------------------------------------------------------------------
    // Tool call loop (max 2 rounds)
    // -----------------------------------------------------------------------
    let tavilyDigest: string | null = null
    let finalContent: string | null = null
    const MAX_TOOL_ROUNDS = 2

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let response: OpenAI.Chat.ChatCompletion
      try {
        response = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages,
          tools: [SEARCH_EQUITY_NEWS_TOOL],
          tool_choice: 'auto',
          response_format: {
            type: 'json_schema',
            json_schema: EQUITY_ANALYSIS_SCHEMA,
          },
          max_tokens: 800,
        })
      } catch (e) {
        console.error('[equityAnalyze] OpenAI error:', e)
        return reply.status(500).send({ error: 'Falha na análise IA' })
      }

      const choice = response.choices[0]

      // If model wants to call a tool
      if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls?.length) {
        const toolCall = choice.message.tool_calls[0]
        const args = JSON.parse(toolCall.function.arguments ?? '{}') as {
          query: string
          reason: string
        }

        console.log(`[equityAnalyze] tool call: search_equity_news query="${args.query}" reason="${args.reason}"`)

        // Check Tavily cache first
        const cacheKey = `tavily:equity:${symbol}:${todayDate}`
        let tavilyResults: TavilyResult[] | null = await cacheGet<TavilyResult[]>(cacheKey)

        if (!tavilyResults) {
          tavilyResults = await searchLiveNews(args.query)
          if (tavilyResults.length > 0) {
            await cacheSet(cacheKey, tavilyResults, TAVILY_EQUITY_TTL_MS, 'tavily-equity')
          }
        } else {
          console.log(`[equityAnalyze] Tavily cache hit for ${symbol}`)
        }

        tavilyConfirmed = tavilyResults.length > 0
        tavilyDigest = await buildEquityNewsDigest(tavilyResults, symbol, args.reason)

        // Re-run regime score with updated tavilyConfirmed
        regimeResult = scoreEquityRegime({ technicals, tavilyConfirmed, hasCatalyst })

        // Build updated prompt with Tavily digest injected
        const updatedSystemPrompt = buildEquityPrompt(
          symbol,
          quoteBlock,
          priceBlock,
          newsBlock,
          technicals,
          regimeResult.score,
          regimeResult.components,
          memoryBlock,
        )

        // Push assistant tool call + tool result into messages
        messages[0] = { role: 'user', content: updatedSystemPrompt }
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: choice.message.tool_calls,
        } as OpenAI.Chat.ChatCompletionAssistantMessageParam)

        const toolResultContent = tavilyDigest
          ? `Notícias encontradas para ${symbol}:\n${tavilyDigest}`
          : `Nenhuma notícia relevante encontrada para ${symbol}.`

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResultContent,
        } as OpenAI.Chat.ChatCompletionToolMessageParam)

        // Continue to next round
        continue
      }

      // Model produced final content
      finalContent = choice.message?.content ?? null
      break
    }

    if (!finalContent) {
      return reply.status(500).send({ error: 'IA sem resposta' })
    }

    // -----------------------------------------------------------------------
    // 6. Parse structured output
    // -----------------------------------------------------------------------
    let structured: AnalysisStructuredEquity
    try {
      structured = JSON.parse(finalContent) as AnalysisStructuredEquity
    } catch {
      return reply.status(500).send({ error: 'Resposta da IA inválida' })
    }

    // -----------------------------------------------------------------------
    // 9. Override regime_score with pre-computed value (prevent model drift)
    // -----------------------------------------------------------------------
    structured.equity_regime_score = regimeResult.score

    // -----------------------------------------------------------------------
    // 8. Save analysis (fire-and-forget)
    // -----------------------------------------------------------------------
    const marketSnapshot: Record<string, unknown> = {
      symbol,
      date: todayDate,
      quote: q ? { last: q.last, change_percentage: q.change_percentage, volume: q.volume } : null,
      technicals: {
        rsi: technicals.rsi,
        rsiZone: technicals.rsiZone,
        macdCross: technicals.macdCross,
        trend: technicals.trend,
        bbPercentB: technicals.bbPercentB,
        vwap: technicals.vwap,
      },
      regimeScore: regimeResult.score,
      tavilyConfirmed,
      hasCatalyst,
    }

    saveEquityAnalysis(
      userId,
      symbol,
      finalContent,
      structured as unknown as Record<string, unknown>,
      marketSnapshot,
    ).catch((err) => console.error('[equityAnalyze] saveEquityAnalysis error:', err))

    return reply.send({ analysis: structured })
  })
}

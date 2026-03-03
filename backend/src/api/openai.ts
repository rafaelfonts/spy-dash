import type { FastifyInstance } from 'fastify'
import type { ServerResponse } from 'http'
import { analysisRateLimit } from '../middleware/rateLimiter'
import { CONFIG } from '../config'
import { marketState, newsSnapshot } from '../data/marketState'
import type { OptionExpiry } from '../data/optionChain'
import { getOptionChainCapturedAt } from '../data/optionChain'
import { humanizeAge, isMarketOpen } from '../lib/time'
import type { MacroDataItem, FearGreedData, MacroEvent, EarningsItem, AnalysisStructuredOutput, PricePoint } from '../types/market'
import { saveAnalysis, getRecentAnalyses } from '../data/analysisMemory'
import { getLastVwap } from '../data/priceHistory'
import type { DailyGexResult, GEXByExpiration } from '../data/gexService'
import { getAdvancedMetricsSnapshot } from '../data/advancedMetricsState'
import { getVIXTermStructureSnapshot } from '../data/vixTermStructureState'
import { getTechnicalSnapshot } from '../data/technicalIndicatorsState'
import { deriveBBPosition } from '../data/technicalIndicatorsPoller'
import type { TechnicalData } from '../data/technicalIndicatorsState'
import { calculateConfidence } from '../lib/confidenceScorer'
import type { ConfidenceResult } from '../lib/confidenceScorer'
import { getBreakerStatuses } from '../lib/circuitBreaker'
import { registerAlertsFromAnalysis } from '../data/alertEngine'

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

// ---------------------------------------------------------------------------
// Tool definition — fetch_24h_context
// The model calls this tool only when it detects macro-relevant conditions.
// ---------------------------------------------------------------------------

const FETCH_CONTEXT_TOOL = {
  type: 'function' as const,
  function: {
    name: 'fetch_24h_context',
    description:
      'Retrieve 24h macro context: FRED economic data, BLS employment data, Fear & Greed index, ' +
      'VIX term structure, upcoming SPY component earnings (≤7 days), and high-impact macro events (≤48h). ' +
      'Call this tool ONLY when you detect: VIX above 20 or spiking (>15% change), unusual P/C ratio ' +
      '(>1.3 or <0.6), RSI in extreme zone (<30 or >70) combined with MACD crossover, or when the ' +
      'user explicitly asks about macro drivers, earnings, or economic events.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
}

// ---------------------------------------------------------------------------
// JSON Schema for structured output — enforced by gpt-4o-mini response_format
// ---------------------------------------------------------------------------

const STRUCTURED_SCHEMA = {
  name: 'analysis_output',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      bias: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
      confidence: { type: 'number' },
      timeframe: { type: 'string' },
      key_levels: {
        type: 'object',
        properties: {
          support: { type: 'array', items: { type: 'number' } },
          resistance: { type: 'array', items: { type: 'number' } },
          gex_flip: { type: ['number', 'null'] },
        },
        required: ['support', 'resistance', 'gex_flip'],
        additionalProperties: false,
      },
      suggested_strategy: {
        anyOf: [
          {
            type: 'object',
            properties: {
              name: { type: 'string' },
              legs: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['call', 'put'] },
                    action: { type: 'string', enum: ['buy', 'sell'] },
                    strike: { type: 'number' },
                    dte: { type: 'number' },
                  },
                  required: ['type', 'action', 'strike', 'dte'],
                  additionalProperties: false,
                },
              },
              max_risk: { type: 'number' },
              max_reward: { type: 'number' },
              breakeven: { type: 'number' },
            },
            required: ['name', 'legs', 'max_risk', 'max_reward', 'breakeven'],
            additionalProperties: false,
          },
          { type: 'null' },
        ],
      },
      catalysts: { type: 'array', items: { type: 'string' } },
      risk_factors: { type: 'array', items: { type: 'string' } },
    },
    required: ['bias', 'confidence', 'timeframe', 'key_levels', 'suggested_strategy', 'catalysts', 'risk_factors'],
    additionalProperties: false,
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Formata a tag de confiança para inserção inline no prompt. Score 0 = sem rastreabilidade → omite tag. */
function confTag(c: ConfidenceResult | undefined): string {
  if (!c || c.score === 0) return ''
  return ` [Confiança: ${c.score} ${c.label}]`
}

function buildGexMultiDTEBlock(gex: GEXByExpiration): string {
  const LABELS: Record<string, string> = {
    dte0: '0DTE', dte1: '1D', dte7: '7D', dte21: '21D', dte45: '45D', all: 'ALL',
  }

  const buckets = (['dte0', 'dte1', 'dte7', 'dte21', 'dte45', 'all'] as const).filter(
    (k) => gex[k] != null,
  )

  if (buckets.length === 0) return ''

  let block = `\n=== GEX POR EXPIRAÇÃO (Multi-DTE) ===\n`
  block += `| DTE  | Expiração  | Regime   | GEX Total | Flip Point | Max Gamma |\n`
  block += `|------|-----------|----------|-----------|------------|-----------|\n`

  for (const key of buckets) {
    const d = gex[key]!
    const label = LABELS[key]
    const expLabel = key === 'all' ? 'Agregado  ' : d.expiration
    const regime = d.regime === 'positive' ? 'POSITIVO' : 'NEGATIVO'
    const total = `${d.totalNetGamma >= 0 ? '+' : ''}$${d.totalNetGamma}M`
    const flip = d.flipPoint != null ? `$${d.flipPoint.toFixed(2)}` : 'N/A'
    block += `| ${label.padEnd(4)} | ${expLabel} | ${regime} | ${total.padEnd(9)} | ${flip.padEnd(10)} | $${d.maxGexStrike} |\n`
  }

  const wallLines: string[] = []
  for (const key of buckets) {
    const d = gex[key]!
    const label = LABELS[key]
    if (key === 'all') continue
    wallLines.push(`- ${label}: Call Wall $${d.callWall} | Put Wall $${d.putWall}`)
  }
  if (wallLines.length > 0) {
    block += `\nCall Wall / Put Wall por DTE:\n${wallLines.join('\n')}\n`
  }

  return block
}

function buildPutCallRatioBlock(pc: {
  ratio: number
  putVolume: number
  callVolume: number
  label: string
  expiration: string
}): string {
  let block = `\n=== PUT/CALL RATIO SPY — ${pc.expiration} ===\n`
  block += `P/C Ratio: ${pc.ratio} (${pc.label.toUpperCase()})\n`
  block += `Volume: ${pc.putVolume.toLocaleString('en-US')} puts / ${pc.callVolume.toLocaleString('en-US')} calls\n`
  const interp =
    pc.label === 'bearish'
      ? 'Hedge pesado — traders comprando proteção. Sinal de cautela.'
      : pc.label === 'bullish'
      ? 'Calls dominam — positioning bullish, risco de complacência.'
      : 'Balanceado — sem sinal direcional forte no fluxo.'
  block += `Interpretação: ${interp}\n`
  return block
}

function buildVIXTermStructureBlock(ts: {
  spot: number
  structure: string
  steepness: number
  curve: Array<{ dte: number; iv: number }>
}): string {
  let block = `\n=== VIX TERM STRUCTURE ===\n`
  block += `Spot: ${ts.spot.toFixed(2)} | Estrutura: ${ts.structure.toUpperCase()}\n`
  block += `Steepness: ${ts.steepness > 0 ? '+' : ''}${ts.steepness}%\n`
  if (ts.curve.length > 0) {
    block += `Curva IV por DTE: ${ts.curve.map((p) => `${p.dte}d=${p.iv}%`).join(' → ')}\n`
  }
  const interp =
    ts.structure === 'contango'
      ? 'Mercado precifica mais vol futura — DTEs mais longos oferecem melhor theta enquanto vol spot é barata.'
      : ts.structure === 'backwardation'
      ? 'Vol spot > futura — pânico atual. 0-1 DTE pode capturar mean reversion rápida de vol.'
      : 'Curva flat — vol estável em todos os prazos.'
  block += `Interpretação: ${interp}\n`
  return block
}

function buildTechBlock(
  tech: TechnicalData,
  spyPrice: number | null,
  confidence?: Record<string, ConfidenceResult>,
  vwap?: number | null,
): string {
  const bbands = spyPrice != null
    ? { ...tech.bbands, position: deriveBBPosition(spyPrice, tech.bbands) }
    : tech.bbands

  const rsiLabel = tech.rsi14 > 70 ? ' [SOBRECOMPRADO]' : tech.rsi14 < 30 ? ' [SOBREVENDIDO]' : ''
  const histSign = tech.macd.histogram >= 0 ? '+' : ''
  const crossLabel = tech.macd.crossover !== 'none' ? ` [CROSSOVER ${tech.macd.crossover.toUpperCase()}]` : ''

  let block = `\n=== INDICADORES TÉCNICOS (SPY 15min)${confTag(confidence?.technicals)} ===\n`
  block += `RSI(14): ${tech.rsi14.toFixed(2)}${rsiLabel}\n`
  block += `MACD: hist=${histSign}${tech.macd.histogram.toFixed(4)} macd=${tech.macd.macd.toFixed(4)} signal=${tech.macd.signal.toFixed(4)}${crossLabel}\n`
  block += `Bollinger(20): upper=${bbands.upper.toFixed(2)} mid=${bbands.middle.toFixed(2)} lower=${bbands.lower.toFixed(2)}\n`
  block += `  → SPY em posição: ${bbands.position.replace(/_/g, ' ').toUpperCase()}\n`
  if (vwap != null && spyPrice != null) {
    const vwapDev = ((spyPrice - vwap) / vwap * 100)
    const vwapDir = vwapDev >= 0 ? 'ACIMA' : 'ABAIXO'
    block += `VWAP: $${vwap.toFixed(2)} | SPY ${vwapDir} do VWAP em ${Math.abs(vwapDev).toFixed(2)}%\n`
  }
  return block
}

/**
 * Builds the 24h macro context block — returned as tool result when the model
 * invokes fetch_24h_context. Includes FRED, BLS, Fear & Greed, VIX term structure,
 * earnings (≤7d), and high-impact macro events (≤48h).
 */
function buildMacroContextBlock(
  context: ContextData | undefined,
  freshness: FreshnessBlock,
  confidence: Record<string, ConfidenceResult>,
): string {
  let block = ''

  // Fear & Greed
  const fgAge = freshness.fearGreed ? ` ${humanizeAge(freshness.fearGreed)}` : ''
  if (context?.fearGreed?.score !== null && context?.fearGreed?.score !== undefined) {
    block += `**Fear & Greed**${fgAge}${confTag(confidence.fearGreed)}: ${context.fearGreed.score}/100 — ${context.fearGreed.label}\n`
  }

  // VIX Term Structure
  const tsSnapshot = getVIXTermStructureSnapshot()
  if (tsSnapshot) {
    block += buildVIXTermStructureBlock(tsSnapshot)
  }

  // Macro (FRED + BLS)
  const macroAge = freshness.macro ? ` ${humanizeAge(freshness.macro)}` : ''
  const blsAge = freshness.bls ? ` ${humanizeAge(freshness.bls)}` : ''
  const allMacro = [...(context?.macro ?? []), ...(context?.bls ?? [])]
  if (allMacro.length > 0) {
    const hasMacro = (context?.macro?.length ?? 0) > 0
    const hasBls = (context?.bls?.length ?? 0) > 0
    let macroLabel = 'Contexto Macroeconômico'
    if (hasMacro && hasBls) {
      macroLabel = `Contexto Macroeconômico (FRED${macroAge}${confTag(confidence.macro)} + BLS${blsAge}${confTag(confidence.bls)})`
    } else if (hasMacro) {
      macroLabel = `Contexto Macroeconômico (FRED${macroAge}${confTag(confidence.macro)})`
    } else if (hasBls) {
      macroLabel = `Contexto Macroeconômico (BLS${blsAge}${confTag(confidence.bls)})`
    }
    block += `\n**${macroLabel}:**\n`
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
      block += `- ${item.name}: ${dir} ${formatMacroValue(item.value, item.unit)} (${item.date})\n`
    }
  }

  // Earnings (≤7 days)
  const earningsAge = freshness.earnings ? ` ${humanizeAge(freshness.earnings)}` : ''
  const urgentEarnings = (context?.earnings ?? []).filter(
    (e) => e.daysToEarnings !== null && e.daysToEarnings >= 0 && e.daysToEarnings <= 7,
  )
  if (urgentEarnings.length > 0) {
    block += `\n**Earnings de componentes SPY (próximos 7 dias)**${earningsAge}${confTag(confidence.earnings)}:\n`
    for (const e of urgentEarnings.slice(0, 6)) {
      block += `- ${e.symbol}: ${e.earningsDate ?? '?'} (em ${e.daysToEarnings} dias)\n`
    }
  }

  // High-impact macro events (≤48h)
  const eventsAge = freshness.macroEvents ? ` ${humanizeAge(freshness.macroEvents)}` : ''
  const highImpact = (context?.macroEvents ?? []).filter((ev) => ev.impact === 'high')
  if (highImpact.length > 0) {
    block += `\n**Eventos macro de alto impacto (próximas 48h)**${eventsAge}${confTag(confidence.macroEvents)}:\n`
    for (const ev of highImpact.slice(0, 6)) {
      const est = ev.estimate !== null ? ` | Est: ${ev.estimate}${ev.unit ?? ''}` : ''
      const prev = ev.prev !== null ? ` | Prev: ${ev.prev}${ev.unit ?? ''}` : ''
      block += `- ${ev.time ? `[${ev.time}] ` : ''}${ev.event}${est}${prev}\n`
    }
  }

  return block || 'Sem dados macro disponíveis neste momento.'
}

/**
 * Builds an intraday price history summary for the AI prompt.
 * Samples the full PricePoint[] array at ~15-min intervals (max 26 points for a full session)
 * and computes session OHLC, intraday range, 1h trend, and a rough HV estimate.
 */
function buildPriceHistoryBlock(history: PricePoint[]): string {
  if (history.length < 5) return ''

  const prices = history.map((pt) => pt.p)
  const open = prices[0]
  const current = prices[prices.length - 1]
  const high = Math.max(...prices)
  const low = Math.min(...prices)
  const range = high - low
  const rangePct = (range / open * 100)

  // Sample at ~15-min intervals (15 bars out of up to 390)
  const step = Math.max(1, Math.floor(history.length / 26))
  const sampled = history.filter((_, i) => i % step === 0 || i === history.length - 1)

  const formatTime = (t: number) =>
    new Date(t).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York',
    })

  const curve = sampled
    .map((pt) => `${formatTime(pt.t)}→${pt.p.toFixed(2)}`)
    .join(' | ')

  // 1h trend: last 60 bars vs current
  const lookback = Math.min(60, history.length - 1)
  const priceAgo = history[history.length - 1 - lookback].p
  const trendChange = current - priceAgo
  const trendPct = (trendChange / priceAgo * 100)
  const trendDir = trendChange > 0 ? '↑ Alta' : trendChange < 0 ? '↓ Queda' : '→ Lateral'

  // Intraday HV: std dev of 1-min log returns × √252×390 (annualized)
  let hv = 0
  if (prices.length >= 10) {
    const returns = prices.slice(1).map((p, i) => Math.log(p / prices[i]))
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length
    const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length
    hv = Math.sqrt(variance * 252 * 390) * 100
  }

  let block = `\n=== HISTÓRICO INTRADAY SPY (${history.length} barras de 1-min) ===\n`
  block += `Sessão: Open $${open.toFixed(2)} → Atual $${current.toFixed(2)} | High $${high.toFixed(2)} | Low $${low.toFixed(2)}\n`
  block += `Range: $${range.toFixed(2)} (${rangePct.toFixed(2)}%)\n`
  block += `Curva (cada ~15min): ${curve}\n`
  block += `Tendência 1h: ${trendChange >= 0 ? '+' : ''}$${trendChange.toFixed(2)} (${trendPct >= 0 ? '+' : ''}${trendPct.toFixed(2)}%) — ${trendDir}\n`
  if (hv > 0) {
    block += `HV Intraday (estimada): ~${hv.toFixed(1)}%\n`
  }
  return block
}

function buildPrompt(
  snapshot: AnalyzeBody['marketSnapshot'],
  chain?: OptionExpiry[],
  freshness?: FreshnessBlock,
  memoryBlock?: string,
  gexMultiBlock?: string | null,
  putCallRatioBlock?: string | null,
  confidence?: Record<string, ConfidenceResult>,
  techBlock?: string | null,
  priceHistoryBlock?: string | null,
): string {
  const spy = snapshot?.spy
  const vix = snapshot?.vix
  const ivRank = snapshot?.ivRank

  let prompt = ''

  if (memoryBlock) {
    prompt += `=== SUAS ANÁLISES ANTERIORES (HOJE) ===\n${memoryBlock}\n\n`
    prompt += `INSTRUÇÃO: Compare sua análise atual com as anteriores. Se mudou de opinião, explique por quê. Se os níveis anteriores foram testados, comente o resultado. Mantenha consistência narrativa.\n\n`
  }

  prompt += `Análise de mercado atual:\n\n`

  // --- Dados de mercado em tempo real ---
  const spyAge = freshness?.spy ? ` ${humanizeAge(freshness.spy)}` : ''
  const vixAge = freshness?.vix ? ` ${humanizeAge(freshness.vix)}` : ''
  const ivAge = freshness?.ivRank ? ` ${humanizeAge(freshness.ivRank)}` : ''

  if (spy) {
    prompt += `**SPY**${spyAge}${confTag(confidence?.spy)}: $${spy.last?.toFixed(2)} | Variação: ${spy.change >= 0 ? '+' : ''}${spy.change?.toFixed(2)} (${spy.changePct?.toFixed(2)}%)\n`
  }
  if (vix) {
    prompt += `**VIX**${vixAge}${confTag(confidence?.vix)}: ${vix.last?.toFixed(2)} | Nível: ${vix.level}\n`
  }
  if (ivRank) {
    const hv30 = marketState.ivRank.hv30
    const ivhvRatio = (ivRank.value != null && hv30 != null && hv30 > 0)
      ? ` | IV/HV(30d)=${(ivRank.value / hv30).toFixed(2)}${ivRank.value / hv30 > 1.3 ? ' [VOL CARA]' : ''}`
      : ''
    prompt += `**IV Rank SPY**${ivAge}${confTag(confidence?.ivRank)}: ${ivRank.value?.toFixed(1)}% | Percentil: ${ivRank.percentile?.toFixed(1)}% | Classificação: ${ivRank.label}${ivhvRatio}\n`
  }

  // --- GEX (Gamma Exposure) ---
  if (gexMultiBlock) {
    prompt += gexMultiBlock
  }

  // --- Put/Call Ratio ---
  if (putCallRatioBlock) {
    prompt += putCallRatioBlock
  }

  // --- Indicadores Técnicos ---
  if (techBlock) {
    prompt += techBlock
  }

  // --- Histórico Intraday ---
  if (priceHistoryBlock) {
    prompt += priceHistoryBlock
  }

  // --- Cadeia de opções: ATM ±5 strikes para as 3 expirações mais próximas ---
  const chainAge = freshness?.optionChain ? ` ${humanizeAge(freshness.optionChain)}` : ''
  if (chain && chain.length > 0) {
    const spyLast = spy?.last ?? 0
    prompt += `\n**Cadeia de Opções SPY (strikes próximos ATM)**${chainAge}${confTag(confidence?.optionChain)}:\n`
    for (const exp of chain.slice(0, 3)) {
      const atmCalls = exp.calls
        .filter((c) => c.bid !== null && c.ask !== null)
        .sort((a, b) => Math.abs(a.strike - spyLast) - Math.abs(b.strike - spyLast))
        .slice(0, 5)

      if (atmCalls.length === 0) continue

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

  prompt += `\nCom base nessas condições de mercado, forneça:\n`
  prompt += `1. Análise do ambiente de volatilidade atual\n`
  prompt += `2. Estratégias de opções mais adequadas para este momento\n`
  prompt += `3. Considerações de risco específicas para SPY hoje\n`
  prompt += `4. Níveis técnicos importantes para monitorar\n`

  return prompt
}

// ---------------------------------------------------------------------------
// Structured output extraction — called after the GPT-4o stream completes.
// Uses json_schema response_format for schema-enforced extraction (no example needed).
// ---------------------------------------------------------------------------

async function extractStructuredOutput(
  fullText: string,
  snapshot: AnalyzeBody['marketSnapshot'],
): Promise<AnalysisStructuredOutput | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 600,
        response_format: { type: 'json_schema', json_schema: STRUCTURED_SCHEMA },
        messages: [
          {
            role: 'system',
            content: 'Extraia dados estruturados de análises de opções. Retorne JSON conforme o schema.',
          },
          {
            role: 'user',
            content: [
              'Baseado na análise abaixo, extraia os dados estruturados.',
              '',
              `SPY: ${snapshot?.spy?.last ?? 'N/A'} | VIX: ${snapshot?.vix?.last ?? 'N/A'}`,
              '',
              '--- ANÁLISE ---',
              fullText,
            ].join('\n'),
          },
        ],
      }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const raw = json.choices?.[0]?.message?.content ?? ''
    return JSON.parse(raw) as AnalysisStructuredOutput
  } catch (err) {
    console.error('[Structured] Extraction failed:', (err as Error).message)
    return null
  }
}

// ---------------------------------------------------------------------------
// Streaming helper — reads an OpenAI stream and emits tokens via SSE.
// Returns the full accumulated response text.
// ---------------------------------------------------------------------------

async function streamTokens(
  openaiRes: Response,
  sendEvent: (event: string, data: unknown) => void,
): Promise<{ fullResponse: string; toolCallName: string | null }> {
  const reader = openaiRes.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''
  let fullResponse = ''
  // Accumulate tool_call function name and arguments across chunks
  let toolCallName: string | null = null
  let toolCallArgs = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') continue

      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string
              tool_calls?: Array<{
                index: number
                id?: string
                type?: string
                function?: { name?: string; arguments?: string }
              }>
            }
            finish_reason?: string
          }>
        }
        const choice = parsed.choices?.[0]
        if (!choice) continue

        // Accumulate tool_call chunks
        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            if (tc.function?.name) toolCallName = tc.function.name
            if (tc.function?.arguments) toolCallArgs += tc.function.arguments
          }
        }

        // Stream content tokens to client
        const content = choice.delta?.content
        if (content) {
          fullResponse += content
          sendEvent('token', { text: content })
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  return { fullResponse, toolCallName }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

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

    const userId = (request as any).user?.id ?? 'unknown'
    console.log(`[ANALYZE] user=${userId} model=gpt-4o tokens_max=1200`)

    // Fetch intraday memory — GEX comes from in-memory snapshot (no extra API call)
    const pastAnalyses = await getRecentAnalyses(userId, 3)

    const memoryBlock = pastAnalyses.length > 0
      ? pastAnalyses.map((a, i) => {
          const age = humanizeAge(a.created_at)
          const spyThen = a.market_snapshot?.spyPrice
          const spyStr = spyThen ? ` SPY era $${spyThen.toFixed(2)}.` : ''
          return `[Análise ${i + 1} — ${age}] Bias: ${a.bias ?? 'N/A'}.${spyStr} ${a.summary}`
        }).join('\n')
      : ''

    const advancedSnapshot = getAdvancedMetricsSnapshot()
    const gexMultiBlock = advancedSnapshot?.gexByExpiration
      ? buildGexMultiDTEBlock(advancedSnapshot.gexByExpiration)
      : null
    const pcBlock = advancedSnapshot?.putCallRatio
      ? buildPutCallRatioBlock(advancedSnapshot.putCallRatio)
      : null

    const techSnapshot = getTechnicalSnapshot()

    // Confidence scores — computed once per analysis request
    const breakerStatuses = getBreakerStatuses()
    const tradierStatus = Object.entries(breakerStatuses)
      .filter(([k]) => k.startsWith('tradier'))
      .map(([, v]) => v)
      .reduce(
        (worst, s) => s === 'OPEN' ? 'OPEN' : (worst === 'OPEN' ? 'OPEN' : s === 'HALF_OPEN' ? 'HALF_OPEN' : worst),
        'CLOSED' as string,
      )
    const confidence: Record<string, ConfidenceResult> = {
      spy:         calculateConfidence('spy',         freshness.spy,         undefined),
      vix:         calculateConfidence('vix',         freshness.vix,         breakerStatuses['vix-finnhub']),
      ivRank:      calculateConfidence('ivRank',      freshness.ivRank,      undefined),
      fearGreed:   calculateConfidence('fearGreed',   freshness.fearGreed,   breakerStatuses['cnn']),
      macro:       calculateConfidence('macro',       freshness.macro,       breakerStatuses['fred']),
      bls:         calculateConfidence('bls',         freshness.bls,         breakerStatuses['bls']),
      macroEvents: calculateConfidence('macroEvents', freshness.macroEvents, breakerStatuses['finnhub']),
      headlines:   calculateConfidence('headlines',   null,                  undefined),
      earnings:    calculateConfidence('earnings',    freshness.earnings,    undefined),
      optionChain:  calculateConfidence('optionChain',  freshness.optionChain,  tradierStatus),
      technicals:   calculateConfidence('technicals',   techSnapshot?.capturedAt ?? null, breakerStatuses['alphavantage']),
    }

    const techBlock = techSnapshot
      ? buildTechBlock(techSnapshot, snapshot?.spy?.last ?? null, confidence, getLastVwap())
      : null

    const priceHistoryBlock = buildPriceHistoryBlock(marketState.spy.priceHistory)

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const marketStatusNote = isMarketOpen()
      ? ''
      : 'ATENÇÃO: O mercado está FECHADO no momento (fim de semana ou fora do horário de negociação NYSE). ' +
        'Todos os dados disponíveis são da última captura antes do fechamento — não há cotações ao vivo. ' +
        'Comece a análise mencionando isso explicitamente. ' +
        'Enquadre qualquer recomendação para a próxima abertura de mercado; não sugira entradas ou saídas imediatas.\n\n'

    const systemPrompt =
      marketStatusNote +
      'Você é um especialista sênior em opções americanas, com foco em SPY e ETFs de grande liquidez. ' +
      'Suas análises são concisas, objetivas e acionáveis. ' +
      'Use markdown para formatar suas respostas com headers, listas e destaques. ' +
      'Dados marcados [AO VIVO] têm máxima relevância para análise de timing. ' +
      'Dados marcados [RECENTE] são muito confiáveis para decisões táticas. ' +
      'Dados marcados [SNAPSHOT] são contexto estrutural — use-os para direção de tendência, não para decisões de entrada/saída. ' +
      'Use delta para avaliar probabilidade ITM (call ATM ≈ 0.50 ≈ 50% de chance de expirar ITM). ' +
      'Use theta para comparar custo de carregamento diário entre strikes e expirações — theta é maior em magnitude em 0DTE. ' +
      'Você tem acesso às suas análises anteriores do dia. Use-as para: manter coerência narrativa, reconhecer quando mudou de opinião (e explicar por quê), e avaliar se níveis de suporte/resistência anteriores foram testados com sucesso. ' +
      'GEX (Gamma Exposure) indica níveis de hedging de market makers. ' +
      'Em regime de GEX positivo, MMs compram quedas e vendem altas — o mercado tende a reverter à média. ' +
      'Em regime negativo, MMs amplificam movimentos — espere maior volatilidade direcional. ' +
      'O GEX flip point e o Zero Gamma Level (ZGL) são os níveis mais importantes: acima deles, supressão de volatilidade; abaixo, amplificação. ' +
      'Use o max gamma strike como nível magnético primário para análise de suporte/resistência intraday. ' +
      'O Put/Call Ratio do dia indica o sentimento do fluxo real de opções SPY. ' +
      'P/C > 1.2 (BEARISH): hedgers dominam — cautela com posições longas desprotegidas. ' +
      'P/C < 0.7 (BULLISH): calls dominam — possível complacência, monitore reversão. ' +
      'P/C 0.7–1.2 (NEUTRAL): sem sinal direcional forte no fluxo de opções. ' +
      'VIX Term Structure: contango (vol curta < vol longa) = calma agora, medo futuro — favorecer DTEs 7-21 para capturar theta enquanto vol spot é barata. ' +
      'Backwardation (vol curta > vol longa) = pânico agora — favorecer 0-1 DTE para capturar mean reversion rápida de vol. ' +
      'Curva flat = vol estável — DTE neutro, focar em outros fatores. ' +
      'Cada seção de dados inclui um score de Confiança (0-1). ' +
      'Confiança ALTA (>=0.8): use para decisões de timing e entrada. ' +
      'Confiança MÉDIA (0.5-0.8): use como contexto direcional. ' +
      'Confiança BAIXA (<0.5): mencione com ressalva, pode estar desatualizado. ' +
      'Nunca baseie uma recomendação de entrada/saída exclusivamente em dados com Confiança BAIXA. ' +
      'RSI sobrecomprado (>70) + resistência GEX = setup de venda forte. ' +
      'RSI sobrevendido (<30) + suporte GEX = setup de compra forte. ' +
      'MACD crossover bullish + GEX positivo = momentum sustentável. ' +
      'Use indicadores técnicos como confirmação, não como sinal primário. ' +
      'Tens à disposição a ferramenta fetch_24h_context. ' +
      'Invoca-a APENAS se detetares: VIX acima de 20 ou em spike (>15% variação), ' +
      'Put/Call Ratio acima de 1.3 ou abaixo de 0.6, RSI em zona extrema (<30 ou >70) combinado com MACD crossover, ' +
      'ou se o utilizador mencionar macro, eventos, earnings ou contexto económico. ' +
      'Em análises intraday rotineiras sem estes sinais, NÃO invoques a ferramenta — poupa tokens e latência. ' +
      'Interpretação do GEX por DTE: ' +
      '0DTE/1D: regime determina comportamento intraday imediato — GEX negativo amplifica moves, positivo induz reversão à média; use para avaliar se 0DTE é viável. ' +
      '7D: janela tática para debit/credit spreads semanais; flip point 7D é o nível-chave de breakeven. ' +
      '21D: janela ideal para iron condors e vertical spreads mensais; max gamma 21D é a ancoragem dos MMs para o mês. ' +
      '45D: contexto estrutural; use para confirmar direção de médio prazo. ' +
      'ALL (agregado): exposição consolidada total dos MMs — indica onde a pressão de hedge é mais intensa globalmente. ' +
      'Ao recomendar estratégias, sempre indique qual DTE/GEX embasa a recomendação. ' +
      'Framework de análise — aplique nesta ordem: ' +
      '(1) REGIME VOL: IV Rank + IV/HV30 + VIX term structure → ambiente de venda ou compra de volatilidade? ' +
      '(2) REGIME GEX por DTE: para o DTE candidato, qual é o regime? Flip point e max gamma são os níveis de âncora. ' +
      '(3) STRIKE COM PoP: use delta como proxy de PoP (delta 0.16 ≈ 84% PoP, delta 0.30 ≈ 70% PoP); posicione short strikes além dos walls de GEX do DTE escolhido. ' +
      '(4) CONFIRMAÇÃO TÉCNICA: RSI/MACD/VWAP/BBands confirmam ou contradizem? Se contraditório, mencione o conflito. ' +
      'Formato de saída para estratégias recomendadas: ' +
      'Estratégia: [nome] | DTE: [X] dias | Expiração: [data] | ' +
      'Estrutura: [legs] | PoP estimado: ~XX% (delta ≈ 0.XX) | ' +
      'Crédito: ~$X.XX | Risco máx: ~$X.XX | Theta/dia: ~$X.XX | ' +
      'Ancoragem GEX: [nível — put wall/call wall/flip point do DTE] | ' +
      'Invalidação: [preço e descrição do nível] | ' +
      'Confiança: ALTA/MÉDIA/BAIXA — [justificativa em 1 linha]'

    const baseMessages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: buildPrompt(
          snapshot,
          body.optionChain,
          freshness,
          memoryBlock || undefined,
          gexMultiBlock,
          pcBlock,
          confidence,
          techBlock,
          priceHistoryBlock || null,
        ),
      },
    ]

    try {
      // First call — with tool available, streaming enabled
      const firstRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          stream: true,
          max_tokens: 1200,
          tools: [FETCH_CONTEXT_TOOL],
          tool_choice: 'auto',
          messages: baseMessages,
        }),
      })

      if (!firstRes.ok) {
        const text = await firstRes.text()
        sendEvent('error', { message: `OpenAI error: ${firstRes.status} — ${text}` })
        res.end()
        return
      }

      const { fullResponse: firstResponse, toolCallName } = await streamTokens(firstRes, sendEvent)

      let fullResponse = firstResponse

      // If the model requested the fetch_24h_context tool, provide macro context and continue
      if (toolCallName === 'fetch_24h_context') {
        console.log(`[ANALYZE] user=${userId} tool_call=fetch_24h_context → injecting macro context`)
        const macroBlock = buildMacroContextBlock(body.context, freshness, confidence)

        const followUpMessages = [
          ...baseMessages,
          // The assistant turn that triggered the tool call
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_macro',
                type: 'function',
                function: { name: 'fetch_24h_context', arguments: '{}' },
              },
            ],
          } as any,
          // Tool result
          {
            role: 'tool',
            tool_call_id: 'call_macro',
            content: macroBlock,
          } as any,
        ]

        const secondRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o',
            stream: true,
            max_tokens: 1200,
            messages: followUpMessages,
          }),
        })

        if (!secondRes.ok) {
          const text = await secondRes.text()
          sendEvent('error', { message: `OpenAI error (follow-up): ${secondRes.status} — ${text}` })
          res.end()
          return
        }

        const { fullResponse: secondResponse } = await streamTokens(secondRes, sendEvent)
        fullResponse = secondResponse
      } else {
        console.log(`[ANALYZE] user=${userId} tool_call=none → base context only`)
      }

      // Extract structured output via JSON Schema enforcement
      const structured = await extractStructuredOutput(fullResponse, snapshot)
      if (structured) {
        sendEvent('structured', structured)
        registerAlertsFromAnalysis(userId, structured)
      }
      sendEvent('done', {})
      saveAnalysis(userId, fullResponse, {
        spyPrice: snapshot?.spy?.last ?? 0,
        vix: snapshot?.vix?.last ?? 0,
        ivRank: snapshot?.ivRank?.value ?? 0,
      }, structured ?? undefined).catch(() => {})
      res.end()
    } catch (err) {
      sendEvent('error', { message: (err as Error).message })
      res.end()
    }

    reply.hijack()
  })

  // ---------------------------------------------------------------------------
  // POST /api/analyze/gex-flow — GEX flow analysis (streaming, gpt-4o-mini)
  // ---------------------------------------------------------------------------

  interface GexFlowBody {
    selectedDte: '0DTE' | '1D' | '7D' | '21D' | '45D' | 'ALL'
    gexData: DailyGexResult
    spyLast: number
    vixLast: number | null
  }

  fastify.post<{ Body: GexFlowBody }>('/api/analyze/gex-flow', async (request, reply) => {
    const { selectedDte, gexData, spyLast, vixLast } = request.body ?? {}

    if (!gexData || !spyLast) {
      reply.code(400).send({ error: 'gexData and spyLast are required' })
      return
    }

    const res = reply.raw as ServerResponse
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    res.write('event: ping\ndata: starting\n\n')

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const marketStatusNote = isMarketOpen()
      ? ''
      : 'ATENÇÃO: Mercado FECHADO. Dados da última captura.\n\n'

    const vixStr = vixLast != null ? `VIX: ${vixLast.toFixed(2)}` : 'VIX: indisponível'
    const regimeLabel = gexData.regime === 'positive'
      ? 'POSITIVO (MMs suprimem volatilidade — range-bound)'
      : 'NEGATIVO (MMs amplificam volatilidade — breakout/breakdown)'

    const topStrikes = [...(gexData.profile.byStrike ?? [])]
      .sort((a, b) => Math.abs(b.netGEX) - Math.abs(a.netGEX))
      .slice(0, 8)
      .map((s) => `  Strike ${s.strike}: Net ${s.netGEX >= 0 ? '+' : ''}${s.netGEX.toFixed(1)}M (Call ${s.callGEX.toFixed(1)}M / Put ${Math.abs(s.putGEX).toFixed(1)}M)`)
      .join('\n')

    const userMessage =
      marketStatusNote +
      `## Análise de Fluxo de Opções — ${selectedDte}\n\n` +
      `**SPY:** $${spyLast.toFixed(2)} | **${vixStr}**\n` +
      `**Expiração:** ${gexData.expiration}\n` +
      `**GEX Total:** ${gexData.totalNetGamma >= 0 ? '+' : ''}${gexData.totalNetGamma.toFixed(1)}M\n` +
      `**Regime:** ${regimeLabel}\n` +
      `**Flip Point:** ${gexData.flipPoint ?? 'N/A'}\n` +
      `**Zero Gamma Level:** ${gexData.zeroGammaLevel ?? 'N/A'}\n` +
      `**Call Wall:** ${gexData.callWall}\n` +
      `**Put Wall:** ${gexData.putWall}\n` +
      `**Max Gamma Strike:** ${gexData.maxGexStrike}\n\n` +
      `**Top strikes por exposição:**\n${topStrikes}\n\n` +
      `Analise este perfil de GEX para a expiração ${selectedDte}. Explique:\n` +
      `1. O que o regime ${gexData.regime} implica para o movimento de preço do SPY\n` +
      `2. A importância do Flip Point / Zero Gamma Level como nível técnico\n` +
      `3. Call Wall e Put Wall como resistência/suporte de dealers\n` +
      `4. Strikes com maior concentração de gamma como zonas de atração ou rejeição\n` +
      `Seja conciso, objetivo e acionável. Máximo 250 palavras.`

    try {
      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          stream: true,
          max_tokens: 400,
          messages: [
            {
              role: 'system',
              content:
                'Você é um especialista em estrutura de mercado de opções, com foco em Gamma Exposure (GEX) e posicionamento de dealers. ' +
                'Suas análises são concisas, técnicas e acionáveis. Use markdown.',
            },
            { role: 'user', content: userMessage },
          ],
        }),
      })

      if (!openaiRes.ok || !openaiRes.body) {
        throw new Error(`OpenAI error: ${openaiRes.status}`)
      }

      const reader = openaiRes.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') break
          try {
            const chunk = JSON.parse(raw)
            const text = chunk.choices?.[0]?.delta?.content
            if (text) sendEvent('token', { text })
          } catch {
            // skip malformed chunk
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

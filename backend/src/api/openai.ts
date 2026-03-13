import type { FastifyInstance } from 'fastify'
import type { ServerResponse } from 'http'
import Anthropic from '@anthropic-ai/sdk'
import { analysisRateLimit } from '../middleware/rateLimiter'
import { CONFIG } from '../config'
import { marketState, newsSnapshot } from '../data/marketState'
import { createBreaker } from '../lib/circuitBreaker'
import type { OptionExpiry } from '../data/optionChain'
import { getOptionChainCapturedAt, getOptionChainSnapshot } from '../data/optionChain'
import { humanizeAge, isMarketOpen } from '../lib/time'
import type { MacroDataItem, FearGreedData, MacroEvent, EarningsItem, AnalysisStructuredOutput, PricePoint, FinraDarkPoolSnapshot, Sec8KEvent, Sec13FPositionSummary } from '../types/market'
import { saveAnalysis, buildMemoryBlock } from '../data/analysisMemory'
import { getLastVwap } from '../data/priceHistory'
import type { DailyGexResult, GEXDynamic } from '../data/gexService'
import { getAdvancedMetricsSnapshot } from '../data/advancedMetricsState'
import { getVIXTermStructureSnapshot } from '../data/vixTermStructureState'
import { getTechnicalSnapshot } from '../data/technicalIndicatorsState'
import type { TechnicalData } from '../data/technicalIndicatorsState'
import { calculateConfidence } from '../lib/confidenceScorer'
import type { ConfidenceResult } from '../lib/confidenceScorer'
import { getBreakerStatuses } from '../lib/circuitBreaker'
import { registerAlertsFromAnalysis } from '../data/alertEngine'
import { getExpectedMoveSnapshot } from '../data/expectedMoveState'
import type { ExpectedMoveSnapshot } from '../data/expectedMoveState'
import { calcProbabilityOTMPut } from '../lib/blackScholes'
import { computeRegimeScore, getGexVsYesterday, getRegimeFlipCount } from '../data/regimeScorer'
import type { RegimeScorerResult, GexComparison } from '../data/regimeScorer'
import { getSkewSnapshot } from '../data/skewState'
import type { SkewByDTE, SkewEntry } from '../data/skewService'
import { getOpexStatus } from '../data/opexCalendar'
import { loadGEXHistory, computeGEXHistoryContext } from '../data/gexHistoryService'
import { getLastCBOEPCR } from '../data/cboePCRPoller'
import type { CBOEPCRData } from '../data/cboePCRPoller'
import type { GEXHistoryContext } from '../data/gexHistoryService'
import { loadVolumeHistory, computeVolumeAnomaly } from '../data/volumeAnomalyService'
import type { VolumeAnomalyData } from '../data/volumeAnomalyService'
import { getIVConeSnapshot } from '../data/ivConeService'
import type { IVConeSnapshot } from '../data/ivConeService'
import { getLastMacroDigest } from '../data/macroDigestService'
import { getTreasuryTgaSnapshot } from '../data/treasuryState'
import { getEiaOilSnapshot } from '../data/eiaOilState'
import { getFinraDarkPoolSnapshot } from '../data/finraDarkPoolState'
import { getRVOLSnapshot } from '../data/rvolPoller'
import { searchLiveNews } from '../lib/tavilyClient'
import { buildNewsDigest } from '../lib/newsDigest'

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
      '(>1.3 or <0.6), RSI in extreme zone (<30 or >70) combined with MACD crossover, ' +
      'when the user explicitly asks about macro drivers, earnings, or economic events, ' +
      'or when a high-impact macro event (FOMC, CPI, NFP, PPI) is scheduled within 48 hours.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
}

const FETCH_SEC_FILINGS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'fetch_sec_filings',
    description:
      'Consultar filings recentes da SEC relevantes para SPY: 8-K de componentes importantes e 13F de fundos/ETFs selecionados. ' +
      'Use este tool SOMENTE quando o usuário perguntar explicitamente sobre fluxo institucional de fundos, grandes mudanças em posição em SPY, ' +
      'ou eventos materiais (8-K) de empresas componentes. Não chame em toda análise rotineira.',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['spy', 'component', 'fund'],
          description: 'Escopo principal da consulta: SPY agregado, componentes ou fundos.',
        },
        limit: {
          type: 'number',
          description: 'Número máximo de eventos/filings a resumir (1–5).',
        },
      },
      required: [],
    },
  },
}

// Anthropic tool format (name, description, input_schema)
const ANTHROPIC_FETCH_CONTEXT_TOOL = {
  name: 'fetch_24h_context',
  description:
    'Retrieve 24h macro context: FRED economic data, BLS employment data, Fear & Greed index, ' +
    'VIX term structure, upcoming SPY component earnings (≤7 days), and high-impact macro events (≤48h). ' +
    'Call this tool ONLY when you detect: VIX above 20 or spiking (>15% change), unusual P/C ratio ' +
    '(>1.3 or <0.6), RSI in extreme zone (<30 or >70) combined with MACD crossover, ' +
    'when the user explicitly asks about macro drivers, earnings, or economic events, ' +
    'or when a high-impact macro event (FOMC, CPI, NFP, PPI) is scheduled within 48 hours.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
}

const ANTHROPIC_FETCH_SEC_FILINGS_TOOL = {
  name: 'fetch_sec_filings',
  description:
    'Consultar filings recentes da SEC relevantes para SPY: 8-K de componentes importantes e 13F de fundos/ETFs selecionados. ' +
    'Use este tool SOMENTE quando o usuário perguntar explicitamente sobre fluxo institucional de fundos, grandes mudanças em posição em SPY, ' +
    'ou eventos materiais (8-K) de empresas componentes. Não chame em toda análise rotineira.',
  input_schema: {
    type: 'object' as const,
    properties: {
      scope: {
        type: 'string',
        enum: ['spy', 'component', 'fund'],
      },
      limit: {
        type: 'number',
      },
    },
    required: [],
  },
}

// ---------------------------------------------------------------------------
// Tool definition — search_live_news
// The model calls this tool when it detects an unexplained price/volume anomaly.
// ---------------------------------------------------------------------------

const SEARCH_LIVE_NEWS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'search_live_news',
    description:
      'Busca notícias ao vivo sobre o SPY e mercado americano quando detectar movimento de preço/volume inexplicável ' +
      'pelos dados estruturais internos. ' +
      'Acione quando: (1) variação ≥ 0.4% em 15min não correlacionada com VIX/GEX/P/C; ' +
      '(2) RVOL > 2.0 sem catalisador estrutural identificado; ' +
      '(3) regime_score caiu ≥ 3 pontos sem mudança em GEX, vanna ou charm. ' +
      'Formule a query incluindo o preço atual do SPY, a variação e o timeframe.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Query contextualizada ao movimento detectado. Ex: "SPY fell 0.6% in 15min from $580 to $576 reason today"',
        },
        reason: {
          type: 'string',
          description: 'Descrição da anomalia. Ex: "RVOL 2.3x without GEX or P/C catalyst"',
        },
      },
      required: ['query', 'reason'],
    },
  },
}

const ANTHROPIC_SEARCH_LIVE_NEWS_TOOL = {
  name: 'search_live_news',
  description:
    'Busca notícias ao vivo sobre o SPY e mercado americano quando detectar movimento de preço/volume inexplicável ' +
    'pelos dados estruturais internos. ' +
    'Acione quando: (1) variação ≥ 0.4% em 15min não correlacionada com VIX/GEX/P/C; ' +
    '(2) RVOL > 2.0 sem catalisador estrutural identificado; ' +
    '(3) regime_score caiu ≥ 3 pontos sem mudança em GEX, vanna ou charm. ' +
    'Formule a query incluindo o preço atual do SPY, a variação e o timeframe.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['query', 'reason'],
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
      recommended_dte: { type: ['number', 'null'] },
      pop_estimate: { type: ['number', 'null'] },
      supporting_gex_dte: { type: ['string', 'null'] },
      invalidation_level: { type: ['number', 'null'] },
      expected_credit: { type: ['number', 'null'] },
      theta_per_day: { type: ['number', 'null'] },
      trade_signal: { type: 'string', enum: ['trade', 'wait', 'avoid'] },
      no_trade_reasons: { type: 'array', items: { type: 'string' } },
      regime_score: { type: 'integer', minimum: 0, maximum: 10 },
      data_quality_warning: { type: ['string', 'null'] },
      vanna_regime: { type: 'string', enum: ['tailwind', 'neutral', 'headwind'] },
      charm_pressure: { type: 'string', enum: ['significant', 'moderate', 'neutral'] },
      price_distribution: {
        anyOf: [
          {
            type: 'object',
            properties: {
              p10: { type: 'number' },
              p25: { type: 'number' },
              p50: { type: 'number' },
              p75: { type: 'number' },
              p90: { type: 'number' },
              expected_range_1sigma: { type: 'string' },
            },
            required: ['p10', 'p25', 'p50', 'p75', 'p90', 'expected_range_1sigma'],
            additionalProperties: false,
          },
          { type: 'null' },
        ],
      },
      gex_vs_yesterday: {
        anyOf: [
          { type: 'string', enum: ['stronger_positive', 'weaker_positive', 'unchanged', 'weaker_negative', 'stronger_negative'] },
          { type: 'null' },
        ],
      },
    },
    required: [
      'bias', 'confidence', 'timeframe', 'key_levels', 'suggested_strategy',
      'catalysts', 'risk_factors',
      'recommended_dte', 'pop_estimate', 'supporting_gex_dte',
      'invalidation_level', 'expected_credit', 'theta_per_day',
      'trade_signal', 'no_trade_reasons', 'regime_score', 'data_quality_warning',
      'vanna_regime', 'charm_pressure', 'price_distribution', 'gex_vs_yesterday',
    ],
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

function buildGexMultiDTEBlock(gexDynamic: GEXDynamic): string {
  if (gexDynamic.length === 0) return ''

  let block = `\n=== GEX POR EXPIRAÇÃO (Term Structure Dinâmica — 0–60 DTE) ===\n`
  block += `INSTRUÇÃO: Varra TODOS os vencimentos abaixo. Identifique o DTE com maior anomalia de Gamma\n`
  block += `e justifique matematicamente a escolha de janela de tempo.\n\n`
  block += `| Label               | DTE | Expiração  | Regime   | GEX Total  | Flip Point | Max Gamma | Anomalia |\n`
  block += `|---------------------|-----|-----------|----------|------------|------------|-----------|---------|\n`

  for (const entry of gexDynamic) {
    const { label, dte, expiration, gex, gammaAnomaly } = entry
    const regime = gex.regime === 'positive' ? 'POSITIVO' : 'NEGATIVO'
    const total = `${gex.totalNetGamma >= 0 ? '+' : ''}$${gex.totalNetGamma.toFixed(1)}M`
    const flip = gex.flipPoint != null ? `$${gex.flipPoint.toFixed(2)}` : 'N/A'
    const anomalyLabel = gammaAnomaly >= 0.8 ? '⚡ ALTA' : gammaAnomaly >= 0.5 ? 'MÉD' : 'baixa'
    block += `| ${label.padEnd(19)} | ${String(dte).padEnd(3)} | ${expiration} | ${regime} | ${total.padEnd(10)} | ${flip.padEnd(10)} | $${gex.maxGexStrike} | ${anomalyLabel} |\n`
  }

  // Call Wall / Put Wall por expiração
  block += `\nCall Wall / Put Wall por expiração:\n`
  for (const entry of gexDynamic) {
    block += `- ${entry.label}: Call Wall $${entry.gex.callWall} | Put Wall $${entry.gex.putWall}\n`
  }

  // VEX/CEX summary — aggregated across all entries
  const aggVex = gexDynamic.reduce((sum, e) => sum + (e.gex.totalVannaExposure ?? 0), 0)
  const aggCex = gexDynamic.reduce((sum, e) => sum + (e.gex.totalCharmExposure ?? 0), 0)
  const vexSign = aggVex >= 0 ? '+' : ''
  const cexSign = aggCex >= 0 ? '+' : ''
  const vexInterp = aggVex > 2
    ? 'POSITIVO → IV comprimindo = dealers de-hedge comprando spot (viés altista estrutural)'
    : aggVex < -2
    ? 'NEGATIVO → IV subindo = dealers vendendo spot (amplificador bearish)'
    : 'neutro'
  const cexInterp = Math.abs(aggCex) > 1
    ? `SIGNIFICATIVO → Power Hour (14:30–16:00 ET) pode ter drift direcional mecânico`
    : 'neutro'
  block += `\nVEX Agregado (Vanna): ${vexSign}$${aggVex.toFixed(1)}M → ${vexInterp}\n`
  block += `CEX Agregado (Charm): ${cexSign}$${aggCex.toFixed(1)}M/dia → ${cexInterp}\n`

  // Volatility Trigger + ZGL per expiration
  const spyNow = marketState.spy.last ?? 0
  const vtLines: string[] = []
  for (const entry of gexDynamic) {
    const { label, gex } = entry
    const vt = gex.volatilityTrigger
    if (vt == null) continue
    const zgl = gex.zeroGammaLevel
    const vtRelation = spyNow > 0 && vt > 0
      ? (spyNow > vt
        ? `ACIMA ✅ (+${((spyNow - vt) / vt * 100).toFixed(2)}%)`
        : `ABAIXO ⚠️ (${((spyNow - vt) / vt * 100).toFixed(2)}%)`)
      : '?'
    const zglStr = zgl != null
      ? `$${zgl.toFixed(2)} (dist ${((spyNow - zgl) / (zgl || 1) * 100).toFixed(2)}%)`
      : 'N/A'
    vtLines.push(`- ${label}: VT=$${vt.toFixed(2)} | SPY ${vtRelation} | ZGL=${zglStr}`)
  }
  if (vtLines.length > 0) {
    block += `\nVolatility Trigger / Zero Gamma Level por expiração:\n${vtLines.join('\n')}\n`
    block += 'SPY acima do VT → long gamma (dealers suprimem vol). SPY abaixo do VT → short gamma (dealers amplificam).\n'
  }

  // Highlight the expiration with highest gammaAnomaly
  const peak = [...gexDynamic].sort((a, b) => b.gammaAnomaly - a.gammaAnomaly)[0]
  if (peak && peak.gammaAnomaly > 0) {
    block += `\n⚡ PICO DE ANOMALIA: ${peak.label} (DTE=${peak.dte}) — gamma ${peak.gex.regime === 'positive' ? 'positivo' : 'NEGATIVO'} de $${peak.gex.totalNetGamma.toFixed(1)}M, flip point ${peak.gex.flipPoint != null ? `$${peak.gex.flipPoint}` : 'N/A'}. Candidato prioritário para análise de DTE.\n`
  }

  // Max Pain — nearest expiration (lowest DTE, most relevant for intraday pin)
  const entryWithMaxPain = gexDynamic.find((e) => e.gex.maxPain != null)
  if (entryWithMaxPain?.gex.maxPain) {
    const mp = entryWithMaxPain.gex.maxPain
    const dirStr = mp.distanceFromSpot >= 0 ? `+$${mp.distanceFromSpot.toFixed(2)}` : `-$${Math.abs(mp.distanceFromSpot).toFixed(2)}`
    const pctStr = `${mp.distancePct >= 0 ? '+' : ''}${mp.distancePct.toFixed(2)}%`
    const pinLabel = mp.pinRisk === 'high'
      ? '⚠️ ALTO — strike gravitacional: SPY tende a colapsar para este nível até expiração'
      : mp.pinRisk === 'moderate'
      ? '⚡ MODERADO — pin risk relevante: atenção a esse strike como suporte/resistência mecânico'
      : '✅ BAIXO — spot distante do max pain; ausência de pin risk significativo'
    block += `\nMax Pain (${entryWithMaxPain.label}): $${mp.maxPainStrike} | Distância do Spot: ${dirStr} (${pctStr}) | Pin Risk: ${pinLabel}\n`
    block += `Interpretação: Em semanas de OPEX, Max Pain + Call Wall convergindo = âncora de gravidade. `
    block += `Max Pain divergindo do spot >1.5% = ausência de pin risk = mercado mais livre para mover.\n`
    if (mp.pinRisk === 'high') {
      block += `[!] ALERTA MAX PAIN: SPY a menos de 0.5% do max pain $${mp.maxPainStrike} — alta probabilidade de pinagem nesse strike até a expiração de ${entryWithMaxPain.label}. Evitar posições que dependem de movimento direcional forte.\n`
    }
  }

  return block
}

/** Builds the regime checklist block (computed server-side). Injected as fact so the AI applies trade_signal consistently. */
function buildRegimeVetoBlock(
  snapshot: AnalyzeBody['marketSnapshot'],
  confidence: Record<string, ConfidenceResult>,
  gexDynamic: GEXDynamic | null,
): string {
  const lines: string[] = ['\n=== CHECKLIST DE REGIME (calculado pelo sistema) ===']
  let passCount = 0
  const totalChecks = 5

  const ivRank = snapshot?.ivRank?.value ?? marketState.ivRank.value
  const hv30 = marketState.ivRank.hv30
  const ivHvRatio = (ivRank != null && hv30 != null && hv30 > 0) ? ivRank / hv30 : null

  if (ivRank != null) {
    const pass = ivRank >= 15
    if (pass) passCount += 1
    lines.push(`${pass ? '[✓]' : '[✗]'} IV Rank: ${ivRank.toFixed(0)}% — ${pass ? 'PASSA (>15%)' : 'VETO (prêmio insuficiente)'}`)
  } else {
    lines.push('[?] IV Rank: indisponível')
  }

  if (ivHvRatio != null) {
    const pass = ivHvRatio >= 0.8
    if (pass) passCount += 1
    lines.push(`${pass ? '[✓]' : '[✗]'} IV/HV30: ${ivHvRatio.toFixed(2)} — ${pass ? 'PASSA (IV ≥ 0.8×HV)' : 'VETO (IV abaixo do HV30; venda de prêmio desfavorável)'}`)
  } else {
    lines.push('[?] IV/HV30: indisponível')
  }

  if (gexDynamic && gexDynamic.length > 0) {
    const allNegative = gexDynamic.every((e) => e.gex.regime === 'negative')
    const pass = !allNegative
    if (pass) passCount += 1
    const regimeLabel = allNegative
      ? `NEGATIVO em todos os ${gexDynamic.length} vencimentos`
      : `pelo menos um vencimento POSITIVO (${gexDynamic.filter((e) => e.gex.regime === 'positive').length}/${gexDynamic.length})`
    lines.push(`${pass ? '[✓]' : '[✗]'} GEX Regime: ${regimeLabel} — ${pass ? 'PASSA' : 'VETO (ambiente de amplificação)'}`)
  } else {
    lines.push('[?] GEX Regime: indisponível')
  }

  const vixChangePct = marketState.vix.changePct ?? (snapshot?.vix as { changePct?: number } | undefined)?.changePct ?? null
  const vixSpike = vixChangePct != null && Math.abs(vixChangePct) > 20
  if (vixChangePct != null) {
    const pass = !vixSpike
    if (pass) passCount += 1
    lines.push(`${pass ? '[✓]' : '[✗]'} VIX variação: ${vixChangePct >= 0 ? '+' : ''}${vixChangePct.toFixed(1)}% — ${pass ? 'PASSA' : 'VETO (spike >20%; aguardar normalização)'}`)
  } else {
    lines.push('[?] VIX variação: indisponível')
  }

  const criticalSources = ['spy', 'vix', 'optionChain'] as const
  const lowCount = criticalSources.filter((k) => (confidence[k]?.score ?? 1) < 0.5).length
  const dataOk = lowCount < 2
  if (dataOk) passCount += 1
  lines.push(`${dataOk ? '[✓]' : '[✗]'} Qualidade dos dados: ${dataOk ? `ALTA (máx 1 fonte crítica com Confiança BAIXA)` : `${lowCount} fontes críticas com Confiança BAIXA — análise inválida`}`)

  const earningsNext2 = (newsSnapshot.earnings ?? []).filter(
    (e) => e.daysToEarnings != null && e.daysToEarnings >= 0 && e.daysToEarnings <= 2,
  )
  if (earningsNext2.length > 0) {
    lines.push(`[!] Earnings componentes SPY nos próximos 2 dias: ${earningsNext2.slice(0, 4).map((e) => e.symbol).join(', ')} — cautela`)
  }

  // Compound VEX + VIX veto (not counted in score — additional hard veto)
  const vexAll = gexDynamic && gexDynamic.length > 0
    ? gexDynamic.reduce((sum, e) => sum + (e.gex.totalVannaExposure ?? 0), 0)
    : null
  const vixLevel = snapshot?.vix?.last ?? marketState.vix.last ?? null
  if (vexAll !== null && vixLevel !== null && vexAll < -5 && vixLevel > 20) {
    lines.push(`[!] VETO COMPOSTO: VEX=${vexAll.toFixed(1)}$M (NEGATIVO) + VIX=${vixLevel.toFixed(1)} (>20) — ambiente de amplificação bearish. VETO de Put Spread curto.`)
  }

  // Volatility Trigger veto + transition zone warning
  // Use lowest-DTE entry's VT (most impactful for intraday regime)
  const vtAll = gexDynamic && gexDynamic.length > 0 ? gexDynamic[0].gex.volatilityTrigger ?? null : null
  const spyLastVT = snapshot?.spy?.last ?? marketState.spy.last ?? null
  if (vtAll !== null && spyLastVT !== null) {
    const distPct = (spyLastVT - vtAll) / vtAll * 100
    if (spyLastVT < vtAll && (vixLevel ?? 0) > 18) {
      lines.push(`[!] VETO VT: SPY=$${spyLastVT.toFixed(2)} < VT=$${vtAll.toFixed(2)} com VIX=${(vixLevel as number).toFixed(1)} (>18) — short gamma environment. Dealers amplificam movimentos. VETO de Put Spread curto.`)
    } else if (Math.abs(distPct) < 0.3) {
      lines.push(`[~] ZONA DE TRANSIÇÃO: SPY a ${Math.abs(distPct).toFixed(2)}% do VT=$${vtAll.toFixed(2)} — aguardar confirmação de direção antes de abrir posição.`)
    }
  }

  // Skew veto — reads snapshot directly (not counted in passCount)
  const skewSnap = getSkewSnapshot()
  const relevantSkew = skewSnap?.dte21 ?? skewSnap?.dte7 ?? skewSnap?.dte0
  if (relevantSkew) {
    const rr25 = relevantSkew.riskReversal25
    const dteLabel = relevantSkew.dte <= 3 ? '0DTE' : relevantSkew.dte <= 10 ? '7D' : '21D'
    if (rr25 > -0.3) {
      lines.push(`[!] VETO SKEW: RR25=${rr25.toFixed(2)}% (${dteLabel}) — skew flat/invertido → puts não pagam prêmio adicional sobre calls. Estrutura desfavorável para Put Spread.`)
    } else if (Math.abs(rr25) < 1.0) {
      lines.push(`[~] INCERTEZA SKEW: |RR25|=${Math.abs(rr25).toFixed(2)}% (${dteLabel}) — skew pouco definido; aguardar maior diferencial put/call.`)
    }
  }

  // OPEX veto — computed from calendar arithmetic (not counted in passCount)
  const opex = getOpexStatus()
  if (opex.isPostOpex) {
    lines.push('[!] VETO PÓS-OPEX: Dia imediatamente após OPEX mensal — GEX resetado, vol pode expandir abruptamente. NÃO abrir novas posições hoje.')
  } else if (opex.daysToMonthlyOpex === 1) {
    lines.push('[~] VÉSPERA DE OPEX: Pin risk elevado — mercado tende a colar no strike de maior OI. Aguardar abertura pós-OPEX para novas posições.')
  } else if (opex.isOpexWeek && opex.daysToMonthlyOpex >= 3) {
    lines.push(`[✓] SEMANA DE OPEX (${opex.daysToMonthlyOpex} dias): GEX tende a comprimir vol — condição estruturalmente favorável para premium selling.`)
  }

  // Regime flip count veto (structural indecision — not counted in passCount but hard veto)
  const flipCount = getRegimeFlipCount()
  if (flipCount >= 2) {
    lines.push(`[!] VETO INSTABILIDADE: GEX flipou ${flipCount}x hoje (positive↔negative) — mercado estruturalmente indeciso. VETO de novas posições direcionais.`)
  }

  lines.push(`Score parcial: ${passCount}/${totalChecks} condições favoráveis`)
  lines.push('NOTA: Se score < 4, trade_signal DEVE ser \'wait\' ou \'avoid\'.')
  lines.push('CRÍTICO: Se QUALQUER linha marcada com [!] estiver ativa acima (VETO COMPOSTO, VETO VT, VETO SKEW, VETO PÓS-OPEX, VETO INSTABILIDADE, ou Earnings próximos), o campo trade_signal DEVE ser \'avoid\' independente do score parcial. Liste o veto em no_trade_reasons.')
  return lines.join('\n')
}

interface RegimeScoreBlockResult {
  block: string
  regimeScorerResult: RegimeScorerResult
  gexVsYesterday: GexComparison | null
}

/** Pre-computes regime_score and related fields, returning a prompt block + the computed values. */
function buildRegimeScoreBlock(gexDynamic: GEXDynamic | null): RegimeScoreBlockResult {
  const regimeScorerResult = computeRegimeScore(gexDynamic)
  const { score, vannaRegime, charmPressure, priceDistribution, regimeFlipCount, surfaceQuality } = regimeScorerResult

  const totalNetGamma = gexDynamic && gexDynamic.length > 0
    ? gexDynamic.reduce((sum, e) => sum + e.gex.totalNetGamma, 0)
    : null
  const gexVsYesterday = totalNetGamma !== null ? getGexVsYesterday(totalNetGamma) : null

  const scoreLabel = score >= 7 ? '✅ FAVORÁVEL' : score >= 5 ? '⚠️ NEUTRO' : '❌ DESFAVORÁVEL'

  let distLine = 'N/A'
  if (priceDistribution) {
    const { p10, p25, p50, p75, p90, expected_range_1sigma, surfaceFitted, skewAdjusted } = priceDistribution
    const method = surfaceFitted ? 'vol surface quadrática' : skewAdjusted ? 'ajuste RR25' : 'normal simétrica'
    distLine = `p10=$${p10} p25=$${p25} p50=$${p50} p75=$${p75} p90=$${p90} | 1σ: ${expected_range_1sigma} | método: ${method}`
  }

  const surfaceLine = surfaceQuality
    ? `Vol Surface: ${surfaceQuality.status} (${surfaceQuality.expirationsFitted} exp, R²_avg=${surfaceQuality.avgR2.toFixed(2)})`
    : 'Vol Surface: unavailable (usando distribuição aproximada)'

  const flipLine = regimeFlipCount >= 2
    ? `⚠️ INSTABILIDADE DE REGIME: GEX flipou ${regimeFlipCount}x hoje — mercado indeciso estruturalmente.`
    : regimeFlipCount === 1
    ? `Regime flipou 1x hoje (mudança de direção detectada).`
    : `Regime estável intraday (0 flips).`

  const block = [
    '\n=== REGIME SCORE (pré-computado pelo backend) ===',
    `Score: ${score}/10 — ${scoreLabel}`,
    `Vanna: ${vannaRegime} | Charm: ${charmPressure} | GEX vs Ontem: ${gexVsYesterday ?? 'N/A'}`,
    `Regime Flips Hoje: ${regimeFlipCount} — ${flipLine}`,
    `Price Distribution (~21D): ${distLine}`,
    surfaceLine,
    `INSTRUÇÃO: NÃO recalcule regime_score — copie o valor ${score} literalmente no campo regime_score.`,
    `Score < 5: trade_signal=avoid | Score 5–6: wait | Score >= 7: analisar e decidir.`,
  ].join('\n')

  return { block, regimeScorerResult, gexVsYesterday }
}

/** Builds Vanna/Charm Exposure block from GEXDynamic (each entry has totalVannaExposure, totalCharmExposure). */
function buildVannaCharmBlock(gexDynamic: GEXDynamic | null): string | null {
  if (!gexDynamic || gexDynamic.length === 0) return null

  let block = '\n=== VANNA/CHARM EXPOSURE (Flows de Dealers por Expiração) ===\n'
  for (const entry of gexDynamic) {
    const vex = entry.gex.totalVannaExposure ?? 0
    const cex = entry.gex.totalCharmExposure ?? 0
    const vexStr = `${vex >= 0 ? '+' : ''}$${vex.toFixed(1)}M`
    const cexStr = `${cex >= 0 ? '+' : ''}$${cex.toFixed(1)}M/dia`
    block += `${entry.label}: VEX ${vexStr} | CEX ${cexStr}\n`
  }
  block +=
    'Interpretação: VEX positivo → se IV comprimir, dealers compram spot (suporte bullish). ' +
    'CEX negativo → decaimento de delta causa selling intraday. Use como confirmação, não sinal primário.\n'
  return block
}

function buildSkewBlock(skew: SkewByDTE): string | null {
  const DTE_LABELS: Record<string, string> = { dte0: '0DTE', dte7: '7D', dte21: '21D', dte45: '45D' }
  const entries = (['dte0', 'dte7', 'dte21', 'dte45'] as const)
    .map((k) => ({ key: k, label: DTE_LABELS[k], entry: skew[k] as SkewEntry | null }))
    .filter((r) => r.entry != null)

  if (entries.length === 0) return null

  let block = '\n=== SKEW DE VOLATILIDADE SPY ===\n'
  for (const { label, entry } of entries) {
    const e = entry!
    const rrSign = e.riskReversal25 >= 0 ? '+' : ''
    const slopeSign = e.putSkewSlope >= 0 ? '+' : ''
    block += `${label}: RR25=${rrSign}${e.riskReversal25.toFixed(2)}% | PutSlope=${slopeSign}${e.putSkewSlope.toFixed(2)}% | IVRatio=${e.ivAtmSkewRatio.toFixed(2)} | ${e.skewLabel}\n`
  }
  block +=
    'Interpretação: RR25 < -2.5% = prêmio elevado (favorável para venda de Put Spread) | ' +
    'RR25 > -0.5% = skew flat/invertido (CAUTELA — puts não pagam prêmio adicional sobre calls).\n'
  return block
}

function buildOpexBlock(): string {
  const opex = getOpexStatus()

  const fmtDate = (d: Date) => {
    const dd = String(d.getUTCDate()).padStart(2, '0')
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
    return `${dd}/${mm}/${d.getUTCFullYear()}`
  }

  let block = '\n=== CONTEXTO OPEX ===\n'

  let monthlyStatus = ''
  if (opex.isPostOpex) {
    monthlyStatus = '⚠️ PÓS-OPEX: GEX resetado — vol pode expandir abruptamente hoje'
  } else if (opex.isOpexDay) {
    monthlyStatus = '⚡ OPEX HOJE: liquidação de posições — slippage elevado, evitar novas entradas'
  } else if (opex.isOpexWeek) {
    monthlyStatus = `⚡ Semana de OPEX: GEX comprime vol, strikes de alta OI atuam como magnetos (pin risk)`
  }

  block += `Próximo OPEX Mensal: ${fmtDate(opex.nextMonthlyOpex)} (em ${opex.daysToMonthlyOpex} dia${opex.daysToMonthlyOpex !== 1 ? 's' : ''})\n`
  if (monthlyStatus) block += `Status: ${monthlyStatus}\n`
  block += `OPEX Semanal: em ${opex.daysToWeeklyOpex} dia${opex.daysToWeeklyOpex !== 1 ? 's' : ''} (sexta ${fmtDate(opex.nextWeeklyOpex)})\n`

  return block
}

function buildGexHistoryBlock(ctx: GEXHistoryContext): string {
  const d1Sign = ctx.gexChangeD1 >= 0 ? '+' : ''
  const d5Sign = ctx.gexChange5d >= 0 ? '+' : ''
  const trendLabels: Record<GEXHistoryContext['gexTrend'], string> = {
    accelerating_positive: 'acúmulo acelerado',
    stable_positive:       'acúmulo moderado',
    declining:             'desacúmulo',
    accelerating_negative: 'desacúmulo acelerado',
  }
  const flipStr = ctx.flipPointTrend === 'unavailable' ? 'n/d' : ctx.flipPointTrend
  const vtStr   = ctx.vtTrend       === 'unavailable' ? 'n/d' : `${ctx.vtTrend} (${ctx.vtChangeD1 >= 0 ? '+' : ''}$${ctx.vtChangeD1.toFixed(0)})`

  let block = '\n=== GEX HISTÓRICO (5 Dias) ===\n'
  block += `Tendência: ${trendLabels[ctx.gexTrend]} | D-1: ${d1Sign}$${ctx.gexChangeD1.toFixed(1)}B`
  if (ctx.daysAvailable >= 5) block += ` | D-5: ${d5Sign}$${ctx.gexChange5d.toFixed(1)}B`
  block += ` (${ctx.daysAvailable}d de dados)\n`
  block += `Flip Point: ${flipStr} | Volatility Trigger: ${vtStr}\n`
  block += `Resumo: ${ctx.historySummary}\n`
  block +=
    'Interpretação: GEX crescendo → dealers acumulam posições estabilizadoras → vol tende a cair. ' +
    'GEX decrescendo → dealers descarregam → vol pode expandir. ' +
    'Use para confirmar/questionar o sinal do GEX spot atual.\n'
  return block
}

function buildVolumeAnomalyBlock(data: VolumeAnomalyData, finra?: FinraDarkPoolSnapshot | null): string {
  const anomalyLabels: Record<VolumeAnomalyData['anomalyLabel'], string> = {
    extreme_put:  'EXTREMO PUTS',
    high_put:     'PUTS ELEVADO',
    neutral:      'neutro',
    high_call:    'CALLS ELEVADO',
    extreme_call: 'EXTREMO CALLS',
  }

  let block = '\n=== FLUXO ANÔMALO DETECTADO (0DTE) ===\n'
  block += `Sizzle 0DTE: ${data.sizzle0dte.toFixed(1)}x (${anomalyLabels[data.anomalyLabel]}) | ATM Straddle: ${data.sizzleAtmStraddle.toFixed(1)}x\n`
  block += `Put/Call Volume Ratio: ${data.putCallVolumeRatio0dte.toFixed(2)} | Puts: ${data.putBuyingPressure} | Calls: ${data.callBuyingPressure} (${data.daysAvailable}d histórico)\n`

  if (data.sizzle0dte > 2.5 && data.anomalyLabel === 'extreme_put') {
    block += '⚠️ VETO FLUXO: Possível evento não precificado — fluxo institucional de proteção detectado. AGUARDAR ou reduzir size em 50%.\n'
  } else if (data.sizzle0dte < 0.5) {
    block += '⚠️ LIQUIDEZ REDUZIDA: Volume 0DTE anormalmente baixo — spreads mais largos. Confirmar bid/ask antes de recomendar entrada.\n'
  }

  // Combinação opcional com Dark Pool (FINRA) — fluxo institucional discreto
  if (finra && finra.offExchangePct != null) {
    block += `Fluxo off-exchange (ATS, semana ${finra.weekOf}): ${
      finra.offExchangePct.toFixed(2)
    }% do volume de SPY em dark pools.\n`
    if (data.sizzle0dte > 1.5 && finra.offExchangePct >= 40) {
      block +=
        '⚡ CONFIRMAÇÃO FLUXO: Sizzle 0DTE elevado + participação ATS ≥40% → fluxo institucional forte em opções E em dark pools. Dar mais peso ao sinal de volume.\n'
    } else if (data.sizzle0dte <= 1.2 && finra.offExchangePct >= 40) {
      block +=
        'Nota: Sizzle 0DTE moderado, mas participação ATS muito alta — possível acumulação discreta em dark pools sem explosão visível no book intraday.\n'
    }
  }

  return block
}

function buildFinraDarkPoolBlock(finra: FinraDarkPoolSnapshot | null): string | null {
  if (!finra) return null

  let block = '\n=== FINRA DARK POOL (ATS SPY) — Fluxo Off-Exchange ===\n'
  block += `Semana de referência: ${finra.weekOf}\n`
  block += `Volume ATS (shares): ${
    finra.totalVolume != null ? finra.totalVolume.toLocaleString('en-US') : 'n/d'
  }\n`
  block += `Participação off-exchange: ${
    finra.offExchangePct != null ? `${finra.offExchangePct.toFixed(2)}%` : 'n/d'
  }\n`
  block += `Nº de ATS reportando SPY: ${finra.venueCount ?? 'n/d'}\n`

  if (finra.offExchangePct != null) {
    if (finra.offExchangePct >= 40) {
      block +=
        '⚡ INTERPRETAÇÃO: Spike de volume em dark pools (≥40% do volume total). Sinal de provável acumulação institucional discreta.\n'
    } else if (finra.offExchangePct <= 20) {
      block +=
        'Nota: Fluxo off-exchange baixo (≤20%). Predomínio de fluxo em bolsa lit — menor sinal de atividade institucional oculta.\n'
    } else {
      block +=
        'Nota: Participação off-exchange em faixa intermediária — use apenas como contexto, não como sinal independente.\n'
    }
  }

  return block
}

function buildCBOEPCRBlock(data: CBOEPCRData): string {
  const labelMap: Record<CBOEPCRData['label'], string> = {
    extreme_fear: 'MEDO EXTREMO — proteção sistêmica ativa',
    fear: 'MEDO — prêmio de put elevado',
    neutral: 'NEUTRO',
    greed: 'GANÂNCIA — prêmio de put baixo',
    extreme_greed: 'GANÂNCIA EXTREMA — complacência',
  }
  const date = new Date(data.capturedAt).toLocaleDateString('pt-BR', { timeZone: 'America/New_York' })
  let block = `\n=== CBOE PUT/CALL RATIO (pregão anterior — ${date}) ===\n`
  block += `Total PCR: ${data.totalPCR} | Equity PCR: ${data.equityPCR} | Index PCR: ${data.indexPCR}\n`
  block += `Sentimento Institucional: ${labelMap[data.label]}\n`
  block += `Interpretação: Equity PCR > 0.8 = proteção comprada = favorável para Put Spread (prêmio elevado). `
  block += `Equity PCR < 0.5 = complacência = cautela com sizing (prêmio de put artificialmente baixo).\n`
  if (data.equityPCR < 0.5) {
    block += `⚠️ VETO CBOE: Equity PCR=${data.equityPCR} — complacência excessiva no mercado amplo. Puts não pagam prêmio adicional justificável.\n`
  } else if (data.equityPCR >= 0.8) {
    block += `✅ CBOE FAVORÁVEL: Equity PCR=${data.equityPCR} — mercado comprando proteção → prêmio de put estruturalmente elevado.\n`
  }
  return block
}

function buildDANBlock(dan: { callDAN: number; putDAN: number; netDAN: number; danBias: string; callDominancePct: number }): string {
  const netSign = dan.netDAN >= 0 ? '+' : ''
  const biasLabels: Record<string, string> = {
    call_dominated: 'CALLS DOMINAM — pressão líquida de COMPRA dos dealers',
    put_dominated:  'PUTS DOMINAM — pressão líquida de VENDA dos dealers',
    neutral:        'NEUTRO — pressão balanceada',
  }
  const biasLabel = biasLabels[dan.danBias] ?? dan.danBias

  let block = '\n=== DELTA-ADJUSTED NOTIONAL (DAN) — Pressão de Hedge dos Dealers ===\n'
  block += `Call DAN: +$${dan.callDAN.toFixed(1)}M | Put DAN: $${dan.putDAN.toFixed(1)}M | Net DAN: ${netSign}$${dan.netDAN.toFixed(1)}M\n`
  block += `Dominância Calls: ${dan.callDominancePct.toFixed(1)}% | Viés: ${biasLabel}\n`
  block += `Interpretação: DAN positivo + GEX positivo = confirmação BULLISH estrutural (dealers compram no hedge). `
  block += `DAN negativo + GEX negativo = dupla confirmação BEARISH (dealers vendem no hedge).\n`
  block += `Contradição (ex: DAN negativo mas GEX positivo) = sinal misto — reduzir confiança na direção e sizing.\n`

  if (dan.danBias === 'put_dominated' && dan.netDAN < -50) {
    block += `⚠️ ALERTA DAN: Net DAN de $${dan.netDAN.toFixed(1)}M — pressão de venda de dealers muito intensa. Evitar calls nuas ou estruturas de baixo delta positivo.\n`
  } else if (dan.danBias === 'call_dominated' && dan.netDAN > 50) {
    block += `✅ DAN BULLISH: Net DAN de +$${dan.netDAN.toFixed(1)}M — dealers estruturalmente compradores. Favorável para Put Spread (perna vendida tem dealer como aliado).\n`
  }

  return block
}

function buildIVConeBlock(cone: IVConeSnapshot): string {
  let block = '\n=== IV CONE — IV vs Volatilidade Histórica ===\n'
  block += `IVx atual: ${cone.ivx != null ? `${cone.ivx.toFixed(1)}%` : 'n/d'}`
  block += ` | Cone: ${cone.coneLabel?.toUpperCase() ?? 'n/d'}\n`

  const fmtRatio = (r: number | null) => r != null ? `${r.toFixed(2)}x` : 'n/d'
  const fmtHv    = (h: number | null) => h != null ? `${h.toFixed(1)}%` : 'n/d'

  block += `HV10: ${fmtHv(cone.hv10)} (IVx/HV10=${fmtRatio(cone.ivVsHv10)}) | `
  block += `HV20: ${fmtHv(cone.hv20)} (IVx/HV20=${fmtRatio(cone.ivVsHv20)}) | `
  block += `HV30: ${fmtHv(cone.hv30)} (IVx/HV30=${fmtRatio(cone.ivVsHv30)}) | `
  block += `HV60: ${fmtHv(cone.hv60)} (IVx/HV60=${fmtRatio(cone.ivVsHv60)})\n`

  if (cone.coneLabel === 'rich') {
    block += `⚠ IV CARA vs HV: IVx está ${cone.ivVsHv30?.toFixed(2)}x acima da HV30. `
    block += `Venda de prêmio ainda tem edge teórico, mas IV pode comprimir — usar sizing conservador.\n`
  } else if (cone.coneLabel === 'cheap') {
    block += `📉 IV BARATA vs HV: IVx abaixo da realizada. Edge para vendedor é menor — preferir estruturas de baixo risco (spreads, não naked).\n`
  } else if (cone.coneLabel === 'fair') {
    block += `✅ IV JUSTA vs HV: IVx alinhada com volatilidade realizada. Venda de prêmio tem pricing equilibrado.\n`
  }

  return block
}

function buildMacroDigestBlock(digest: { text: string; capturedAt: string }): string | null {
  // Skip if digest is older than 3 days
  const age = Date.now() - new Date(digest.capturedAt).getTime()
  if (age > 3 * 24 * 60 * 60 * 1000) return null

  const date = new Date(digest.capturedAt).toLocaleDateString('pt-BR', { timeZone: 'America/New_York' })
  let block = `\n=== DIGEST MACRO (${date}) ===\n`
  // Truncate to 500 chars to keep prompt concise
  block += digest.text.slice(0, 500)
  if (digest.text.length > 500) block += '...'
  block += '\n'
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
  midTermIV?: number | null
  curvature?: number | null
  vix1dProxy?: number | null
  vix1dRatio?: number | null
}): string {
  let block = `\n=== VIX TERM STRUCTURE ===\n`
  block += `Spot: ${ts.spot.toFixed(2)} | Estrutura: ${ts.structure.toUpperCase()}\n`
  block += `Steepness: ${ts.steepness > 0 ? '+' : ''}${ts.steepness}%`
  if (ts.curvature != null) {
    block += ` | Curvatura: ${ts.curvature > 0 ? '+' : ''}${ts.curvature.toFixed(1)}%`
  }
  block += '\n'
  if (ts.midTermIV != null) {
    block += `IV Mid-Term: ${ts.midTermIV.toFixed(1)}%\n`
  }
  if (ts.vix1dProxy != null) {
    block += `VIX1D Proxy: ${ts.vix1dProxy.toFixed(1)}%`
    if (ts.vix1dRatio != null) block += ` (ratio=${ts.vix1dRatio.toFixed(2)}${ts.vix1dRatio > 1.15 ? ' ⚠ STRESS' : ''})`
    block += '\n'
  }
  if (ts.curve.length > 0) {
    block += `Curva IV por DTE: ${ts.curve.map((p) => `${p.dte}d=${p.iv}%`).join(' → ')}\n`
  }
  const interp =
    ts.structure === 'contango'
      ? 'Mercado precifica mais vol futura — DTEs mais longos oferecem melhor theta enquanto vol spot é barata.'
      : ts.structure === 'backwardation'
      ? 'Vol spot > futura — pânico atual. 0-1 DTE pode capturar mean reversion rápida de vol.'
      : ts.structure === 'humped'
      ? `Barriga da curva elevada (curvature=${ts.curvature?.toFixed(1) ?? '?'}%) — evento binário precificado no mid-term (FOMC/CPI). Convexidade adversa para short-vol nesses vencimentos.`
      : 'Curva flat — vol estável em todos os prazos.'
  block += `Interpretação: ${interp}\n`
  return block
}

function buildTechBlock(
  tech: TechnicalData,
  confidence?: Record<string, ConfidenceResult>,
  vwap?: number | null,
): string {
  const bbands = tech.bbands

  const rsiLabel = tech.rsi14 > 70 ? ' [SOBRECOMPRADO]' : tech.rsi14 < 30 ? ' [SOBREVENDIDO]' : ''
  const histSign = tech.macd.histogram >= 0 ? '+' : ''
  const crossLabel = tech.macd.crossover !== 'none' ? ` [CROSSOVER ${tech.macd.crossover.toUpperCase()}]` : ''

  let block = `\n=== INDICADORES TÉCNICOS (SPY 15min)${confTag(confidence?.technicals)} ===\n`
  block += `RSI(14): ${tech.rsi14.toFixed(2)}${rsiLabel}\n`
  block += `MACD: hist=${histSign}${tech.macd.histogram.toFixed(4)} macd=${tech.macd.macd.toFixed(4)} signal=${tech.macd.signal.toFixed(4)}${crossLabel}\n`
  block += `Bollinger(20): upper=${bbands.upper.toFixed(2)} mid=${bbands.middle.toFixed(2)} lower=${bbands.lower.toFixed(2)}\n`
  block += `  → SPY em posição: ${bbands.position.replace(/_/g, ' ').toUpperCase()}\n`
  const spyLast = marketState.spy.last
  if (vwap != null && spyLast != null) {
    const vwapDev = ((spyLast - vwap) / vwap * 100)
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

  // Treasury TGA — liquidez fiscal (TGA drawdown)
  const tgaSnap = getTreasuryTgaSnapshot()
  if (tgaSnap) {
    const deltaStr =
      tgaSnap.delta != null
        ? `${tgaSnap.delta >= 0 ? '+' : ''}${tgaSnap.delta.toLocaleString('en-US')}`
        : 'N/A'
    block += `\n**Treasury TGA (liquidez fiscal):** data=${tgaSnap.asOfDate} saldo=$${
      tgaSnap.closingBalance?.toLocaleString('en-US') ?? 'N/A'
    } Δdia=${deltaStr} (closing - opening).\n`
    block += `Interpretação: TGA caindo (=Δ negativo) injeta liquidez no sistema; TGA subindo drena liquidez.\n`
  }

  // EIA Oil — estoques de petróleo (proxy para inflação futura / expectativas de Fed)
  const eiaSnap = getEiaOilSnapshot()
  if (eiaSnap) {
    const crude = eiaSnap.crudeInventories != null
      ? eiaSnap.crudeInventories.toLocaleString('en-US')
      : 'N/A'
    const change =
      eiaSnap.crudeChange != null
        ? `${eiaSnap.crudeChange >= 0 ? '+' : ''}${eiaSnap.crudeChange.toFixed(2)}`
        : 'N/A'
    block += `\n**EIA Estoques de Petróleo:** semana=${eiaSnap.asOfDate} crude=${crude} (Δ=${change} M bbl). `
    block += `Quedas consecutivas em estoques + demanda forte = pressão inflacionária potencial; alta nos estoques = alívio na pressão de preços.\n`
  }

  return block || 'Sem dados macro disponíveis neste momento.'
}

function buildSecSummaryBlock(
  events: Sec8KEvent[] | null,
  positions: Sec13FPositionSummary[] | null,
): string | null {
  const lines: string[] = []

  if (events && events.length > 0) {
    lines.push('**Eventos SEC 8-K recentes (componentes SPY):**')
    for (const e of events.slice(0, 3)) {
      const date = e.filedAt.slice(0, 10)
      const sym = e.symbol ?? e.cik
      const title = e.title ?? 'Evento 8-K'
      lines.push(`- ${date} — ${sym}: ${title}`)
    }
  }

  if (positions && positions.length > 0) {
    lines.push('**Mudanças 13F em SPY (fundos selecionados):**')
    for (const p of positions.slice(0, 3)) {
      const dir = p.changeVsPrev ?? 'flat'
      lines.push(`- ${p.managerName}: posição em SPY (${dir}) no relatório de ${p.reportDate}`)
    }
  }

  if (lines.length === 0) return null
  return `\n=== CONTEXTO SEC (resumo curto) ===\n${lines.join('\n')}\n`
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

function buildExpectedMoveBlock(snapshot: ExpectedMoveSnapshot | null, spyLast: number): string | null {
  if (!snapshot || Object.keys(snapshot.byExpiry).length === 0) return null
  const lines: string[] = []
  lines.push('\n**Expected Move (1σ)** — cone de probabilidade implícito (Call ATM + Put ATM = straddle), todos os vencimentos disponíveis:')
  for (const [expirationDate, data] of Object.entries(snapshot.byExpiry)) {
    const lower = spyLast - data.expectedMove
    const upper = spyLast + data.expectedMove
    const effStr = data.ivEfficiency != null ? ` | iv_efficiency=${data.ivEfficiency.toFixed(3)}` : ''
    lines.push(
      `- ${expirationDate} (${data.dte} DTE): $${data.expectedMove.toFixed(2)} (strike ATM: $${data.atmStrike})${effStr}. ` +
      `Cone 1σ: $${lower.toFixed(2)} a $${upper.toFixed(2)}. ` +
      `Para Put Spreads, a perna vendida deve ficar **fora** do cone (abaixo de $${lower.toFixed(2)}); se estiver dentro, o risco está mal dimensionado.`,
    )
  }
  return lines.join('\n')
}

/**
 * RVOL block — SPY relative volume proxy for institutional flow.
 * Reads getRVOLSnapshot() directly; returns null when unavailable.
 */
function buildRVOLBlock(): string | null {
  const rvol = getRVOLSnapshot()
  if (!rvol || rvol.avg20dVolume <= 0) return null
  const pct = ((rvol.rvol - 1) * 100).toFixed(0)
  const sign = rvol.rvol >= 1 ? '+' : ''
  const biasLabel =
    rvol.rvolBias === 'accumulation' ? '🟢 ACUMULAÇÃO — fluxo institucional comprador'
    : rvol.rvolBias === 'distribution' ? '🔴 DISTRIBUIÇÃO — fluxo institucional vendedor'
    : '⚪ neutro'
  return (
    `\n**RVOL (Volume Relativo SPY)**: ${rvol.rvol.toFixed(2)}× (${sign}${pct}% vs. média 20d)\n` +
    `- Volume hoje: ${(rvol.todayVolume / 1e6).toFixed(1)}M | Média 20d: ${(rvol.avg20dVolume / 1e6).toFixed(1)}M\n` +
    `- Bias: ${biasLabel}\n` +
    (rvol.rvolBias === 'accumulation'
      ? '- RVOL acima da média com SPY subindo: dealers comprando acima do normal — confirma viés bullish.\n'
      : rvol.rvolBias === 'distribution'
        ? '- RVOL acima da média com SPY caindo: venda com volume elevado — sinal de cautela.\n'
        : '')
  )
}

/** Risk-free rate from FRED DFF in macro snapshot; fallback 5.3%. */
function getRiskFreeRate(): number {
  const dff = newsSnapshot.macro.find((m) => m.seriesId === 'DFF')
  if (dff?.value != null && isFinite(dff.value)) return dff.value / 100
  return 0.053
}

function buildIVByExpirationBlock(): string | null {
  const ts = getVIXTermStructureSnapshot()
  if (!ts || !ts.curve?.length) return null
  const curve = ts.curve
  const iv21 = curve.reduce((best, c) => (Math.abs(c.dte - 21) < Math.abs(best.dte - 21) ? c : best))
  const iv45 = curve.reduce((best, c) => (Math.abs(c.dte - 45) < Math.abs(best.dte - 45) ? c : best))
  let block = '\n**IV por vencimento (term structure)** — volatilidade implícita ATM por DTE:\n'
  block += `Curva: ${curve.map((p) => `${p.dte}d=${p.iv}%`).join(' → ')}\n`
  block += `IV 21 DTE: ${iv21.iv}% | IV 45 DTE: ${iv45.iv}%\n`
  block += 'Para Put Spreads, se a volatilidade implícita do vencimento escolhido estiver baixa, **vetar** a operação e sugerir aguardar um pico de medo no mercado.\n'
  return block
}

/** POP reference for short put 2%, 3%, 4% OTM at all DTEs available in VIX term structure. */
function buildPOPReferenceBlock(spot: number): string | null {
  if (spot <= 0) return null
  const ts = getVIXTermStructureSnapshot()
  if (!ts || !ts.curve?.length) return null
  const curve = ts.curve
  const r = getRiskFreeRate()
  const otmPcts = [0.98, 0.97, 0.96] as const
  const lines: string[] = ['\n**POP de referência (perna vendida put, OTM)** — probabilidade de expirar OTM (N(d2)) por DTE:\n']
  for (const point of curve) {
    const dte = point.dte
    const sigma = point.iv / 100
    const T = dte / 365
    const parts = otmPcts.map((pct) => {
      const K = Math.round(spot * pct * 100) / 100
      const pop = calcProbabilityOTMPut(spot, K, T, r, sigma)
      const pctOtm = Math.round((1 - pct) * 100)
      return `$${K.toFixed(2)} (${pctOtm}% OTM) → ${(pop * 100).toFixed(1)}%`
    })
    lines.push(`${dte} DTE: ${parts.join('; ')}`)
  }
  lines.push('Put Spread: exigir POP ≥ 65–70% na perna vendida; **vetar** se abaixo.\n')
  return lines.join('\n')
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
  expectedMoveBlock?: string | null,
  ivByExpirationBlock?: string | null,
  popReferenceBlock?: string | null,
  regimeVetoBlock?: string | null,
  regimeScoreBlock?: string | null,
  skewBlock?: string | null,
  opexBlock?: string | null,
  gexHistoryBlock?: string | null,
  volAnomalyBlock?: string | null,
  cboePCRBlock?: string | null,
  danBlock?: string | null,
  ivConeBlock?: string | null,
  macroDigestBlock?: string | null,
  secSummaryBlock?: string | null,
): string {
  const spy = snapshot?.spy
  const vix = snapshot?.vix
  const ivRank = snapshot?.ivRank

  let prompt = ''

  if (memoryBlock) {
    prompt += `=== SUAS ANÁLISES ANTERIORES (HOJE) ===\n${memoryBlock}\n\n`
    prompt += `INSTRUÇÃO: Compare sua análise atual com as anteriores. Se mudou de opinião, explique por quê. Se os níveis anteriores foram testados, comente o resultado. Mantenha consistência narrativa.\n\n`
  }

  if (macroDigestBlock) {
    prompt += macroDigestBlock
  }

  if (secSummaryBlock) {
    prompt += secSummaryBlock
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

  // --- IV Cone (HV multi-período) ---
  if (ivConeBlock) {
    prompt += ivConeBlock
  }

  // --- Regime Score (pré-computado — injetar ANTES do veto para que score apareça primeiro) ---
  if (regimeScoreBlock) {
    prompt += regimeScoreBlock
  }

  // --- Checklist de Regime (vetos quantitativos) ---
  if (regimeVetoBlock) {
    prompt += regimeVetoBlock
  }

  // --- Skew de Volatilidade ---
  if (skewBlock) {
    prompt += skewBlock
  }

  // --- Contexto OPEX ---
  if (opexBlock) {
    prompt += opexBlock
  }

  // --- GEX Histórico (5 Dias) ---
  if (gexHistoryBlock) {
    prompt += gexHistoryBlock
  }

  // --- Fluxo Anômalo 0DTE (Sizzle) ---
  if (volAnomalyBlock) {
    prompt += volAnomalyBlock
  }

  // --- GEX (Gamma Exposure) ---
  if (gexMultiBlock) {
    prompt += gexMultiBlock
  }

  // --- Put/Call Ratio (intraday Tradier) ---
  if (putCallRatioBlock) {
    prompt += putCallRatioBlock
  }

  // --- RVOL — Relative Volume (proxy fluxo institucional) ---
  const rvolBlock = buildRVOLBlock()
  if (rvolBlock) {
    prompt += rvolBlock
  }

  // --- CBOE PCR (pregão anterior — fluxo institucional amplo) ---
  if (cboePCRBlock) {
    prompt += cboePCRBlock
  }

  // --- Delta-Adjusted Notional (pressão direcional de hedge dos dealers) ---
  if (danBlock) {
    prompt += danBlock
  }

  // --- Indicadores Técnicos ---
  if (techBlock) {
    prompt += techBlock
  }

  // --- Histórico Intraday ---
  if (priceHistoryBlock) {
    prompt += priceHistoryBlock
  }

  // --- Volume Profile (POC/VAH/VAL) — âncoras de preço por volume real negociado ---
  const volProfile = getAdvancedMetricsSnapshot()?.profile ?? null
  if (volProfile) {
    const spyRef = spy?.last ?? marketState.spy.last ?? null
    const posLabel = spyRef !== null
      ? spyRef > volProfile.vah ? 'acima da VAH (sobrecomprado estrutural)'
        : spyRef < volProfile.val ? 'abaixo da VAL (sobrevendido estrutural)'
        : Math.abs(spyRef - volProfile.poc) / volProfile.poc < 0.002 ? 'no POC (equilíbrio)'
        : spyRef > volProfile.poc ? 'entre POC e VAH'
        : 'entre VAL e POC'
      : null
    prompt += `\n**Volume Profile Intraday** (baseado em volume negociado real):\n`
    prompt += `POC=$${volProfile.poc.toFixed(2)} | VAH=$${volProfile.vah.toFixed(2)} | VAL=$${volProfile.val.toFixed(2)}`
    if (posLabel) prompt += ` | SPY ${posLabel}`
    prompt += `\nINTERPRETAÇÃO: POC=preço de maior aceitação (suporte/resistência mais confiável que GEX walls). `
    prompt += `VAH/VAL=limites do value area (70% do volume). Breakeven da estratégia vendida deve estar fora do value area.\n`
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
    // Liquidity analysis — ATM bid-ask spread for first expiration
    const firstExp = chain[0]
    const spyRef2 = spy?.last ?? 0
    const atmStrikes = firstExp.calls
      .filter((c) => c.bid !== null && c.ask !== null)
      .sort((a, b) => Math.abs(a.strike - spyRef2) - Math.abs(b.strike - spyRef2))
      .slice(0, 3)
    if (atmStrikes.length > 0) {
      const avgSpread = atmStrikes.reduce((s, c) => s + ((c.ask ?? 0) - (c.bid ?? 0)), 0) / atmStrikes.length
      const spreadLabel = avgSpread <= 0.05 ? 'TIGHT (execução favorável)'
        : avgSpread <= 0.15 ? 'NORMAL'
        : avgSpread <= 0.30 ? 'WIDE — considere limit orders'
        : 'MUITO WIDE — risco de execução alto'
      prompt += `\nLiquidez ATM (${firstExp.expirationDate}): spread médio=$${avgSpread.toFixed(2)} — ${spreadLabel}`
      prompt += ` | Slippage estimado=$${(avgSpread / 2).toFixed(2)} por leg\n`
      if (avgSpread > 0.20) {
        prompt += `ALERTA: Spread largo pode eliminar edge da estratégia — calcule crédito líquido após slippage antes de operar.\n`
      }
    }
  }

  if (expectedMoveBlock) {
    prompt += expectedMoveBlock
  }
  if (ivByExpirationBlock) {
    prompt += ivByExpirationBlock
  }
  if (popReferenceBlock) {
    prompt += popReferenceBlock
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

interface ExtractPrecomputed {
  regimeScorerResult: RegimeScorerResult
  gexVsYesterday: GexComparison | null
}

async function extractStructuredOutput(
  fullText: string,
  snapshot: AnalyzeBody['marketSnapshot'],
  chain?: OptionExpiry[],
  precomputed?: ExtractPrecomputed | null,
): Promise<AnalysisStructuredOutput | null> {
  try {
    const precomputedLines = precomputed
      ? [
          '',
          'VALORES PRÉ-CALCULADOS (copie literalmente, sem reinterpretar):',
          `regime_score: ${precomputed.regimeScorerResult.score}`,
          `vanna_regime: "${precomputed.regimeScorerResult.vannaRegime}"`,
          `charm_pressure: "${precomputed.regimeScorerResult.charmPressure}"`,
          `gex_vs_yesterday: ${precomputed.gexVsYesterday ? `"${precomputed.gexVsYesterday}"` : 'null'}`,
          `price_distribution: ${JSON.stringify(precomputed.regimeScorerResult.priceDistribution)}`,
        ].join('\n')
      : ''

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 1000,
        response_format: { type: 'json_schema', json_schema: STRUCTURED_SCHEMA },
        messages: [
          {
            role: 'system',
            content:
              'Extraia dados estruturados de análises de opções. Retorne JSON conforme o schema. ' +
              'Os campos confidence e pop_estimate devem ser sempre números entre 0 e 1 (ex: 0.65 para 65%, 0.70 para 70%). ' +
              'trade_signal: "trade" se condições alinhadas, "wait" se 1 veto, "avoid" se 2+ vetos. regime_score: inteiro 0-10. no_trade_reasons: lista de razões quando não for trade. ' +
              'Para regime_score, vanna_regime, charm_pressure, price_distribution, gex_vs_yesterday: copie os valores pré-calculados exatamente como fornecidos.',
          },
          {
            role: 'user',
            content: [
              'Baseado na análise abaixo, extraia os dados estruturados.',
              '',
              `SPY: ${snapshot?.spy?.last ?? 'N/A'} | VIX: ${snapshot?.vix?.last ?? 'N/A'}`,
              precomputedLines,
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
    const structured = JSON.parse(raw) as AnalysisStructuredOutput
    if (structured.confidence > 1) {
      structured.confidence = Math.min(1, Math.max(0, structured.confidence / 100))
    }
    if (structured.pop_estimate != null && structured.pop_estimate > 1) {
      structured.pop_estimate = Math.min(1, Math.max(0, structured.pop_estimate / 100))
    }
    if (!structured.trade_signal) structured.trade_signal = 'trade'
    if (!Array.isArray(structured.no_trade_reasons)) structured.no_trade_reasons = []
    if (typeof structured.regime_score !== 'number') structured.regime_score = 5
    structured.regime_score = Math.min(10, Math.max(0, Math.round(structured.regime_score)))
    if (structured.data_quality_warning !== null && structured.data_quality_warning !== undefined && typeof structured.data_quality_warning !== 'string') {
      structured.data_quality_warning = null
    }
    // Safety net: always override pre-computed fields with authoritative backend values
    if (precomputed) {
      structured.regime_score = precomputed.regimeScorerResult.score
      structured.vanna_regime = precomputed.regimeScorerResult.vannaRegime
      structured.charm_pressure = precomputed.regimeScorerResult.charmPressure
      structured.price_distribution = precomputed.regimeScorerResult.priceDistribution
      structured.gex_vs_yesterday = precomputed.gexVsYesterday
    }
    // Validate that suggested_strategy legs use strikes present in the option chain
    if (chain && chain.length > 0 && structured.suggested_strategy?.legs?.length) {
      const validStrikes = new Set<number>()
      for (const exp of chain) {
        for (const c of exp.calls) validStrikes.add(c.strike)
        for (const p of exp.puts) validStrikes.add(p.strike)
      }
      const invalidLeg = structured.suggested_strategy.legs.find((leg) => !validStrikes.has(leg.strike))
      if (invalidLeg) {
        console.warn(`[Structured] Strike ${invalidLeg.strike} not in option chain — clearing suggested_strategy`)
        structured.suggested_strategy = null
      }
    }
    return structured
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
): Promise<{ fullResponse: string; toolCallName: string | null; toolCallArgs: string }> {
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

        // Warn if OpenAI stopped due to token limit
        if (choice.finish_reason === 'length') {
          console.warn('[AI] finish_reason=length — resposta truncada pelo limite de tokens')
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  return { fullResponse, toolCallName, toolCallArgs }
}

// ---------------------------------------------------------------------------
// Claude 3.5 Sonnet streaming — same contract as OpenAI path (fullResponse + toolCallName)
// ---------------------------------------------------------------------------

const CLAUDE_MAX_TOKENS = 2500

type SendEventFn = (event: string, data: unknown) => void

interface ClaudeStreamParams {
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }>
  sendEvent: SendEventFn
  /** When false, omit tools (e.g. follow-up after tool result). */
  includeTools?: boolean
}

async function streamClaudeAnalyze(params: ClaudeStreamParams): Promise<{ fullResponse: string; toolCallName: string | null; toolCallArgs: string }> {
  const { system, messages, sendEvent, includeTools = true } = params

  try {
    if (!CONFIG.ANTHROPIC_API_KEY || CONFIG.ANTHROPIC_API_KEY.length < 20) {
      throw new Error('ANTHROPIC_API_KEY não configurada ou inválida')
    }

    const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY })

  const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> = messages.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content }
    return { role: m.role, content: m.content }
  })

  const body: Record<string, unknown> = {
    model: CONFIG.ANTHROPIC_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    system,
    messages: anthropicMessages,
    stream: true,
  }
  if (includeTools) {
    body.tools = [ANTHROPIC_FETCH_CONTEXT_TOOL, ANTHROPIC_FETCH_SEC_FILINGS_TOOL, ANTHROPIC_SEARCH_LIVE_NEWS_TOOL]
    body.tool_choice = { type: 'auto' }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawStream = await anthropic.messages.create(body as any)
  const stream = rawStream as unknown as AsyncIterable<{
    type: string
    content_block?: { type: string; id?: string; name?: string; input?: unknown }
    delta?: { type: string; text?: string; partial_json?: string; stop_reason?: string }
  }>
  let fullResponse = ''
  let toolCallName: string | null = null
  let toolCallArgs = ''
  let currentToolUse: { id: string; name: string; input: string } | null = null

  for await (const event of stream) {
    if (event.type === 'content_block_start' && 'content_block' in event) {
      const block = event.content_block as { type: string; id?: string; name?: string; input?: unknown }
      if (block.type === 'tool_use' && block.id && block.name) {
        currentToolUse = { id: block.id, name: block.name, input: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}) }
      }
    }
    if (event.type === 'content_block_delta' && 'delta' in event) {
      const delta = event.delta as { type: string; text?: string; partial_json?: string }
      if (delta.type === 'text_delta' && delta.text) {
        fullResponse += delta.text
        sendEvent('token', { text: delta.text })
      }
      if (delta.type === 'input_json_delta' && currentToolUse && delta.partial_json) {
        currentToolUse.input += delta.partial_json
      }
    }
    if (event.type === 'content_block_stop' && currentToolUse) {
      toolCallName = currentToolUse.name
      toolCallArgs = currentToolUse.input
      currentToolUse = null
    }
    if (event.type === 'message_delta' && 'delta' in event) {
      const d = event.delta as { stop_reason?: string }
      if (d.stop_reason === 'tool_use') toolCallName = toolCallName ?? 'fetch_24h_context'
    }
  }

  return { fullResponse, toolCallName, toolCallArgs }
  } catch (err) {
    const e = err as Error
    console.error('[Claude] Erro ao instanciar ou executar SDK:', e.message, e.name ? `(${e.name})` : '')
    throw err
  }
}

/** Circuit breaker for Claude (primary). Fallback returns null → caller uses OpenAI. */
const claudeAnalysisBreaker = createBreaker(
  async (params: ClaudeStreamParams): Promise<{ fullResponse: string; toolCallName: string | null; toolCallArgs: string }> => {
    return streamClaudeAnalyze(params)
  },
  'claude-primary',
  { timeout: 65_000, resetTimeout: 120_000 },
)

// ---------------------------------------------------------------------------
// System prompt builder (reused by route and runAnalysisForPayload)
// ---------------------------------------------------------------------------

const STATIC_SYSTEM_PROMPT =
  'REGRAS DE INTEGRIDADE ANALÍTICA (INVIOLÁVEIS): ' +
  '(1) STRIKES REAIS APENAS: Sugira apenas strikes que aparecem explicitamente no option chain do prompt. Se o chain não tiver o strike ideal, mencione o mais próximo disponível. ' +
  '(2) IV DE FONTES CITADAS: Nunca invente valores de IV. Use apenas os dados da term structure e dos greeks do chain fornecidos. ' +
  '(3) CONFLITOS OBRIGATÓRIOS: Se dois indicadores apontam direções opostas (ex: RSI sobrevendido + GEX negativo), apresente AMBOS em risk_factors. Nunca silencie um sinal negativo. ' +
  '(4) PROBABILIDADES MATEMÁTICAS: Todas as PoP devem derivar de delta (proxy) ou N(d2) da tabela POP de referência. Nunca use "aproximadamente X%" sem base matemática. ' +
  '(5) DADOS AUSENTES: Se um bloco de dados não aparece no prompt, declare "dado não disponível" — nunca infira ou extrapole. ' +
  '(6) INCERTEZA EXPLÍCITA: Se confiança do sinal for MÉDIA ou BAIXA, reflita isso no campo confidence (≤0.6) e em risk_factors. ' +
  'Centra a análise em: Gamma Exposure (GEX), decaimento (Theta), exposição à volatilidade (Vega), Volume Profile e contexto macroeconómico. ' +
  'Você é um especialista sênior em opções americanas, com foco em SPY e ETFs de grande liquidez. ' +
  'Suas análises são concisas, objetivas e acionáveis. ' +
  'Use markdown para formatar suas respostas com headers, listas e destaques. ' +
  'Dados marcados [AO VIVO] têm máxima relevância para análise de timing. ' +
  'Dados marcados [RECENTE] são muito confiáveis para decisões táticas. ' +
  'Dados marcados [SNAPSHOT] são contexto estrutural — use-os para direção de tendência, não para decisões de entrada/saída. ' +
  'Use delta para avaliar probabilidade ITM (call ATM ≈ 0.50 ≈ 50% de chance de expirar ITM). ' +
  'Theta: custo de carregamento diário; priorize ancoragem GEX e Vega. ' +
  'Vega: IV Rank e term structure indicam se vol está cara ou barata. ' +
  'Você tem acesso às suas análises anteriores do dia. Use-as para: manter coerência narrativa, reconhecer quando mudou de opinião (e explicar por quê), e avaliar se níveis de suporte/resistência anteriores foram testados com sucesso. ' +
  'GEX (Gamma Exposure) indica níveis de hedging de market makers. ' +
  'Em regime de GEX positivo, MMs compram quedas e vendem altas — o mercado tende a reverter à média. ' +
  'Em regime negativo, MMs amplificam movimentos — espere maior volatilidade direcional. ' +
  'O GEX flip point e o Zero Gamma Level (ZGL) são os níveis mais importantes: acima deles, supressão de volatilidade; abaixo, amplificação. ' +
  'Use o max gamma strike como nível magnético primário. Volume Profile (fluxo de opções) complementa GEX para níveis-chave. ' +
  'O Put/Call Ratio do dia indica o sentimento do fluxo real de opções SPY. ' +
  'P/C > 1.2 (BEARISH): hedgers dominam — cautela com posições longas desprotegidas. ' +
  'P/C < 0.7 (BULLISH): calls dominam — possível complacência, monitore reversão. ' +
  'P/C 0.7–1.2 (NEUTRAL): sem sinal direcional forte no fluxo de opções. ' +
  'VIX Term Structure: contango = DTEs mais longos oferecem theta; backwardation = vol spot alta, considerar Vega e DTEs curtos. ' +
  'Cada seção de dados inclui um score de Confiança (0-1). ' +
  'Confiança ALTA (>=0.8): use para decisões de timing e entrada. ' +
  'Confiança MÉDIA (0.5-0.8): use como contexto direcional. ' +
  'Confiança BAIXA (<0.5): mencione com ressalva, pode estar desatualizado. ' +
  'Nunca baseie uma recomendação de entrada/saída exclusivamente em dados com Confiança BAIXA. ' +
  'Checklist de Veto Quantitativo (APLICAR ANTES DE QUALQUER RECOMENDAÇÃO): ' +
  'VETO se IV Rank < 15%: prêmio insuficiente para venda de volatilidade. ' +
  'VETO se IV/HV30 < 0.8: IV abaixo da volatilidade realizada — venda não tem edge. ' +
  'VETO se GEX negativo em TODOS os DTEs: ambiente de amplificação — não vender spreads. ' +
  'VETO se VIX spike >20% no dia: pânico agudo — aguardar normalização. ' +
  'VETO se dados críticos (spy/vix/optionChain) com Confiança BAIXA: análise inválida. ' +
  'VETO se earnings de componentes SPY nos próximos 2 dias com alto impacto. ' +
  'Se 2+ vetos ativos: trade_signal=\'avoid\', explique os vetos em no_trade_reasons. ' +
  'Se 1 veto ativo: trade_signal=\'wait\', explique e dê condição de entrada. ' +
  '\'Não operar\' é uma posição legítima e muitas vezes a MELHOR decisão. ' +
  'RSI sobrecomprado (>70) + resistência GEX = setup de venda forte. RSI sobrevendido (<30) + suporte GEX = setup de compra forte. ' +
  'MACD crossover bullish + GEX positivo = momentum sustentável. Use indicadores técnicos como confirmação, não como sinal primário. ' +
  'Tens à disposição a ferramenta fetch_24h_context para contexto macro (FRED, BLS, Fear & Greed, eventos, earnings). ' +
  'Invoca-a quando: VIX acima de 20 ou spike (>15%), P/C acima de 1.3 ou abaixo de 0.6, RSI extremo com MACD crossover, evento macro de alto impacto (FOMC, CPI, NFP, PPI) nas próximas 48h, ou quando o utilizador pedir macro/earnings. ' +
  'TERMO CRÍTICO — TERM STRUCTURE DINÂMICA: Você recebe o espectro completo da cadeia de opções (0 a 60 DTE) via expirations dinâmicas reais — NÃO buckets fixos. ' +
  'É estritamente proibido limitar sua análise a DTEs tradicionais pré-definidos. ' +
  'Varra a term structure completa e identifique o DTE exato com maior distorção de prêmio, melhor Risco/Retorno ou proteção via Gamma. ' +
  'Justifique matematicamente a escolha: use gammaAnomaly, flipPoint, e o regime (positivo/negativo) de cada expiration. ' +
  'A expiration com ⚡ (gammaAnomaly alta) é candidata prioritária — analise-a primeiro. ' +
  'Varredura de DTE: Analise TODOS os vencimentos disponíveis no bloco GEX e no Expected Move. ' +
  'Para cada DTE candidato, avalie em sequência: (1) IV do vencimento (term structure) — eliminar se IV < percentil 25% da curva. ' +
  '(2) PoP na perna vendida (delta proxy) — eliminar se PoP < 65% no strike OTM selecionado. ' +
  '(3) Alinhamento GEX — o strike vendido deve ficar além do put wall do DTE exato. ' +
  '(4) Expected Move — o strike vendido deve ficar fora do cone 1σ. ' +
  '(5) Theta/dia relativo ao prêmio recebido — preferir DTEs com theta eficiente. ' +
  'O DTE com MAIOR score nos 5 critérios é a oportunidade clara. Justifique a escolha com números reais dos dados. ' +
  'DTEs curtos (0-7D): válidos em regime GEX positivo + IV backwardation + tendência clara. ' +
  'DTEs médios (14-30D): válidos em contango + IV Rank >30% + cone bem definido. ' +
  'DTEs longos (45-60D): válidos em estrutura de médio prazo sólida + IV barata. ' +
  'Vanna Exposure (VEX): dDelta/dIV agregado dos dealers. VEX positivo alto: quando IV comprime, dealers de-hedge comprando spot → suporte bullish. VEX negativo: IV subindo força venda de spot. Charm Exposure (CEX): dDelta/dTime. CEX negativo alto próximo de expiração: pressão de venda intraday. Use VEX/CEX como confirmação, não como sinal primário. ' +
  'VEX POSITIVO com IV em queda: contexto favorável para Put Spread (perna curta mais segura), NÃO é sinal de entrada LONG. ' +
  'VEX NEGATIVO com VIX > 20: VETO de Put Spread curto — dealers amplificam queda mecanicamente. ' +
  'CEX |>$1M/dia|: Power Hour (14:30–16:00 ET) pode ter drift direcional mecânico — não confundir com tendência real. ' +
  'Vanna/Charm são forças mecânicas de hedge de dealers, não sinais de entrada independentes — sempre confirmar com GEX regime e técnicos. ' +
  'GEX por expiração: use o entry dinâmico (label "MMM-DD (XDTE)") que corresponda ao DTE escolhido; flip point e max gamma desse entry são os níveis de âncora. ' +
  'Expected Move (soma Call ATM + Put ATM = straddle) por vencimento indica o movimento esperado em 1 desvio padrão (~68% de probabilidade). ' +
  'Para Put Spreads, a perna vendida deve ficar fora do cone (strike short abaixo de SPY − Expected Move do vencimento escolhido). ' +
  'Se a perna vendida estiver dentro do cone, **alerte criticamente** que o risco da operação está mal calculado. ' +
  'Se a volatilidade implícita do vencimento escolhido estiver baixa, **vetar** a operação e sugerir aguardar um pico de medo no mercado. ' +
  'Put Spread só tem vantagem matemática com POP ≥ 65–70% na perna vendida; **vetar** se o POP estiver abaixo; use a tabela de POP de referência e o delta ao avaliar strikes. ' +
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
  'Confiança: ALTA/MÉDIA/BAIXA — [justificativa em 1 linha]. ' +
  'Os dados de porcentagem no payload (PoP, Confiança, IV Rank, etc.) já estão em formato absoluto. Utilize-os diretamente acompanhados do sinal %, sem re-multiplicar por 100. ' +
  'Skew de Volatilidade (Risk Reversal 25-delta): RR25 = IV(put 25d) − IV(call 25d), em pontos percentuais. ' +
  'RR25 muito negativo (< -2.5%): puts caras em relação a calls — hedgers comprando proteção; prêmio elevado favorável a vendedores de Put Spread. ' +
  'RR25 próximo de zero (> -0.5%): skew flat — mercado sem viés de proteção; desfavorável para venda de puts. ' +
  'RR25 positivo: skew invertido — calls mais caras que puts; demanda por upside ou short squeeze. ' +
  'PutSkewSlope = IV(put 25d) − IV(put 10d): alto (> 3%) = custo de cauda elevado; preferir spread mais largo. ' +
  'VETO se RR25 > -0.3% no DTE alvo: estrutura de prêmio insuficiente para Put Spread. ' +
  'AGUARDAR se |RR25| < 1.0%: zona de incerteza — esperar sinal de skew mais claro. ' +
  'OPEX Calendar (3ª sexta de cada mês): ' +
  'Semana de OPEX (D-5 a D-1): GEX comprime vol — strikes de alta OI atuam como magnetos (pin risk). Favorável para premium selling com strikes além dos walls. ' +
  'OPEX Day (D-0): liquidação forçada — evitar novas posições; slippage elevado em spreads curtos. ' +
  'Dia Pós-OPEX (D+1, segunda-feira): GEX zerado — vol pode expandir sem amortecimento dos MMs. VETO de Put Spread. ' +
  'Véspera de OPEX (D-1): pin risk máximo — mercado tende a colar no strike de maior OI até fechamento de quinta. ' +
  'Use o contexto OPEX para ajustar expectativa de volatilidade realizada (HV): na semana de OPEX, HV tende a ser subestimada pela compressão mecânica de GEX. ' +
  'GEX Histórico (5 dias): GEX crescendo ($B) → dealers acumulando posições estabilizadoras → vol tende a cair (favorável para premium selling). ' +
  'GEX decrescendo → dealers descarregando → vol tende a subir → cautela com Put Spread vendido. ' +
  'Flip Point migrando consistentemente em uma direção por 3+ dias = tendência estrutural de nível de magnetismo. ' +
  'Use GEX histórico para confirmar ou questionar o sinal do GEX spot atual — divergência entre spot e tendência histórica = sinal de atenção. ' +
  'Sizzle 0DTE: ratio vol hoje / vol médio 5d para opções 0DTE SPY. ' +
  'Sizzle > 2.5 + extreme_put = fluxo institucional de proteção → possível evento não precificado → AGUARDAR ou reduzir size 50%. ' +
  'Sizzle < 0.5 = liquidez reduzida → spreads mais largos → confirmar bid/ask antes de recomendar entrada. ' +
  'Bloco Sizzle ausente = vol 0DTE normal (0.6x–1.5x) — sem anomalia; não mencionar. ' +
  'Bloco Técnico (RSI/MACD/BBands): quando ausente do prompt, a análise é estrutural (GEX + IV + Expected Move + Skew + OPEX). ' +
  'NÃO solicite dados técnicos via tool call quando o bloco técnico estiver ausente. ' +
  'RSI e MACD são irrelevantes para Put Spread de 21–45 DTE sem regime de alta vol (VIX>25), RSI extremo (<35 ou >70), ou pós-OPEX. ' +
  'FERRAMENTA search_live_news — Acione quando: (1) variação de preço ≥ 0.4% em 15min não explicada por VIX, GEX ou P/C; ' +
  '(2) RVOL > 2.0 sem catalisador estrutural identificado nos dados internos; ' +
  '(3) regime_score caiu ≥ 3 pontos sem mudança em GEX, vanna ou charm. ' +
  'Formule a query incluindo o preço atual do SPY, a variação percentual e o timeframe. ' +
  'Exemplo: "SPY drop 0.5% in 20 minutes at $580 reason catalyst news"'

/**
 * Returns true if the tech block (RSI/MACD/BBands) should be included in the prompt.
 *
 * Excluded for structural premium-selling analyses (21–45 DTE) where these
 * short-term indicators add noise rather than signal. Included when:
 *  - VIX > 25 (high-vol regime: price action matters more)
 *  - Post-OPEX day (mechanical GEX reset → price action more relevant)
 *  - RSI extreme (< 35 or > 70): agent needs to know about the extreme
 */
function shouldIncludeTechBlock(): boolean {
  const vix = marketState.vix.last
  if (vix != null && vix > 25) return true
  if (getOpexStatus().isPostOpex) return true
  const rsi = getTechnicalSnapshot()?.rsi14 ?? null
  if (rsi != null && (rsi < 35 || rsi > 70)) return true
  return false
}

function buildSystemPrompt(marketStatusNote: string): string {
  return marketStatusNote + STATIC_SYSTEM_PROMPT
}

// ---------------------------------------------------------------------------
// runAnalysisForPayload — non-streaming analysis for scheduled signal (reused by POST /api/analyze logic)
// ---------------------------------------------------------------------------

export interface RunAnalysisOptions {
  snapshot?: AnalyzeBody['marketSnapshot']
  optionChain?: OptionExpiry[]
  context?: ContextData
  freshness?: FreshnessBlock
}

export async function runAnalysisForPayload(
  options: RunAnalysisOptions = {},
): Promise<{ fullText: string; structured: AnalysisStructuredOutput | null }> {
  const body = options as { marketSnapshot?: RunAnalysisOptions['snapshot']; optionChain?: OptionExpiry[]; context?: ContextData; freshness?: FreshnessBlock }
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

  const msToIso = (ms: number): string | undefined =>
    ms > 0 ? new Date(ms).toISOString() : undefined

  const freshness: FreshnessBlock = body.freshness ?? {
    spy: msToIso(marketState.spy.lastUpdated),
    vix: msToIso(marketState.vix.lastUpdated),
    ivRank: msToIso(marketState.ivRank.lastUpdated),
    optionChain: msToIso(getOptionChainCapturedAt()),
    fearGreed: newsSnapshot.fearGreed?.lastUpdated ? msToIso(newsSnapshot.fearGreed.lastUpdated) : undefined,
    macro: msToIso(newsSnapshot.macroTs),
    bls: msToIso(newsSnapshot.blsTs),
    macroEvents: msToIso(newsSnapshot.macroEventsTs),
    earnings: msToIso(newsSnapshot.earningsTs),
  }

  const optionChain = body.optionChain ?? getOptionChainSnapshot() ?? undefined

  const advancedSnapshot = getAdvancedMetricsSnapshot()
  const gexMultiBlock = advancedSnapshot?.gexDynamic && advancedSnapshot.gexDynamic.length > 0
    ? buildGexMultiDTEBlock(advancedSnapshot.gexDynamic)
    : null
  const pcBlock = advancedSnapshot?.putCallRatio
    ? buildPutCallRatioBlock(advancedSnapshot.putCallRatio)
    : null

  const techSnapshot = getTechnicalSnapshot()
  const breakerStatuses = getBreakerStatuses()
  const tradierStatus = Object.entries(breakerStatuses)
    .filter(([k]) => k.startsWith('tradier'))
    .map(([, v]) => v)
    .reduce(
      (worst, s) => (s === 'OPEN' ? 'OPEN' : worst === 'OPEN' ? 'OPEN' : s === 'HALF_OPEN' ? 'HALF_OPEN' : worst),
      'CLOSED' as string,
    )
  const confidence: Record<string, ConfidenceResult> = {
    spy: calculateConfidence('spy', freshness.spy, undefined),
    vix: calculateConfidence('vix', freshness.vix, breakerStatuses['vix-finnhub']),
    ivRank: calculateConfidence('ivRank', freshness.ivRank, undefined),
    fearGreed: calculateConfidence('fearGreed', freshness.fearGreed, breakerStatuses['cnn']),
    macro: calculateConfidence('macro', freshness.macro, breakerStatuses['fred']),
    bls: calculateConfidence('bls', freshness.bls, breakerStatuses['bls']),
    macroEvents: calculateConfidence('macroEvents', freshness.macroEvents, breakerStatuses['finnhub']),
    headlines: calculateConfidence('headlines', null, undefined),
    earnings: calculateConfidence('earnings', freshness.earnings, undefined),
    optionChain: calculateConfidence('optionChain', freshness.optionChain, tradierStatus),
    technicals: calculateConfidence('technicals', techSnapshot?.capturedAt ?? null, breakerStatuses['alphavantage']),
  }

  const techBlock = (techSnapshot && shouldIncludeTechBlock())
    ? buildTechBlock(techSnapshot, confidence, getLastVwap())
    : null
  const priceHistoryBlock = buildPriceHistoryBlock(marketState.spy.priceHistory)
  const expectedMoveSnapshot = getExpectedMoveSnapshot()
  const expectedMoveBlock = buildExpectedMoveBlock(expectedMoveSnapshot, snapshot?.spy?.last ?? 0)
  const ivByExpirationBlock = buildIVByExpirationBlock()
  const popReferenceBlock = buildPOPReferenceBlock(snapshot?.spy?.last ?? 0)
  const regimeVetoBlock = buildRegimeVetoBlock(snapshot, confidence, advancedSnapshot?.gexDynamic ?? null)
  const regimeScoreBlockResult = buildRegimeScoreBlock(advancedSnapshot?.gexDynamic ?? null)
  const skewSnapshotForPrompt = getSkewSnapshot()
  const skewBlock = skewSnapshotForPrompt ? buildSkewBlock(skewSnapshotForPrompt) : null
  const opexBlock = buildOpexBlock()
  const gexHistory = await loadGEXHistory(5)
  const gexHistoryCtx = computeGEXHistoryContext(gexHistory)
  const gexHistoryBlock = gexHistoryCtx ? buildGexHistoryBlock(gexHistoryCtx) : null
  const volHistory = await loadVolumeHistory(5)
  const todayVolSnap = volHistory.length > 0 ? volHistory[volHistory.length - 1] : null
  const volAnomalyData = (todayVolSnap && volHistory.length >= 2)
    ? computeVolumeAnomaly(todayVolSnap, volHistory.slice(0, -1))
    : null
  const finraSnapMain = getFinraDarkPoolSnapshot()
  const volAnomalyBlock = (volAnomalyData && (volAnomalyData.sizzle0dte > 1.5 || volAnomalyData.sizzle0dte < 0.6))
    ? buildVolumeAnomalyBlock(volAnomalyData, finraSnapMain)
    : null
  const finraBlockMain = finraSnapMain ? buildFinraDarkPoolBlock(finraSnapMain) : null
  // Resumo SEC curto — usa o mesmo serviço do macro digest, mas apenas se já estiver em cache
  let secSummaryBlock: string | null = null
  try {
    const { fetchRecent8KForSPYComponents, fetchRecent13FForSelectedFunds } = await import('../data/secEdgarService')
    const [recent8k, recent13f] = await Promise.allSettled([
      fetchRecent8KForSPYComponents(3),
      fetchRecent13FForSelectedFunds(3),
    ])
    const events = recent8k.status === 'fulfilled' ? recent8k.value : null
    const positions = recent13f.status === 'fulfilled' ? recent13f.value : null
    secSummaryBlock = buildSecSummaryBlock(events, positions)
  } catch {
    secSummaryBlock = null
  }
  const cboePCRData = await getLastCBOEPCR()
  const cboePCRBlock = cboePCRData ? buildCBOEPCRBlock(cboePCRData) : null
  const danBlockScheduled = advancedSnapshot?.dan ? buildDANBlock(advancedSnapshot.dan) : null
  const ivConeSnapshotScheduled = getIVConeSnapshot()
  const ivConeBlockScheduled = ivConeSnapshotScheduled ? buildIVConeBlock(ivConeSnapshotScheduled) : null
  const macroDigestData = getLastMacroDigest()
  const macroDigestBlockScheduled = macroDigestData ? buildMacroDigestBlock(macroDigestData) : null

  const userContent = buildPrompt(
    snapshot,
    optionChain,
    freshness,
    undefined, // no memory for scheduled run
    gexMultiBlock,
    pcBlock,
    confidence,
    techBlock,
    priceHistoryBlock || null,
    expectedMoveBlock,
    ivByExpirationBlock,
    popReferenceBlock,
    regimeVetoBlock,
    regimeScoreBlockResult.block,
    skewBlock,
    opexBlock,
    gexHistoryBlock,
    volAnomalyBlock,
    cboePCRBlock,
    danBlockScheduled,
    ivConeBlockScheduled,
    macroDigestBlockScheduled,
    secSummaryBlock,
  )

  const marketStatusNote = isMarketOpen()
    ? ''
    : 'ATENÇÃO: O mercado está FECHADO no momento (fim de semana ou fora do horário de negociação NYSE). ' +
      'Todos os dados disponíveis são da última captura antes do fechamento — não há cotações ao vivo. ' +
      'Comece a análise mencionando isso explicitamente. ' +
      'Enquadre qualquer recomendação para a próxima abertura de mercado; não sugira entradas ou saídas imediatas.\n\n'
  const systemPrompt = buildSystemPrompt(marketStatusNote)

  const noop = () => {}
  const useClaudePrimary = Boolean(CONFIG.ANTHROPIC_API_KEY)

  let firstResponse = ''
  let toolCallName: string | null = null
  let toolCallArgs = ''
  let usedClaude = false

  if (useClaudePrimary) {
    const claudeResult = (await claudeAnalysisBreaker.fire({
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      sendEvent: noop,
    })) as { fullResponse: string; toolCallName: string | null; toolCallArgs: string } | null
    if (claudeResult != null) {
      usedClaude = true
      firstResponse = claudeResult.fullResponse
      toolCallName = claudeResult.toolCallName
      toolCallArgs = claudeResult.toolCallArgs
    }
  }

  if (!usedClaude) {
    const firstRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        stream: true,
        max_tokens: 2500,
        tools: [FETCH_CONTEXT_TOOL, FETCH_SEC_FILINGS_TOOL, SEARCH_LIVE_NEWS_TOOL],
        tool_choice: 'auto',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
    })
    if (firstRes.ok && firstRes.body) {
      const openaiFirst = await streamTokens(firstRes, noop)
      firstResponse = openaiFirst.fullResponse
      toolCallName = openaiFirst.toolCallName
      toolCallArgs = openaiFirst.toolCallArgs
    }
  }

  let fullResponse = firstResponse

  if (toolCallName === 'fetch_24h_context') {
    const macroBlock = buildMacroContextBlock(body.context, freshness, confidence)
    if (usedClaude) {
      const claudeFollowUp = await streamClaudeAnalyze({
        system: systemPrompt,
        messages: [
          { role: 'user', content: userContent },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_macro', name: 'fetch_24h_context', input: {} }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_macro', content: macroBlock }],
          },
        ],
        sendEvent: noop,
        includeTools: false,
      })
      fullResponse = claudeFollowUp.fullResponse
    } else if (CONFIG.OPENAI_API_KEY) {
      const followUpMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_macro', type: 'function', function: { name: 'fetch_24h_context', arguments: '{}' } },
          ],
        } as any,
        { role: 'tool', tool_call_id: 'call_macro', content: macroBlock } as any,
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
          max_tokens: 2500,
          messages: followUpMessages,
        }),
      })
      if (secondRes.ok && secondRes.body) {
        const { fullResponse: secondResponse } = await streamTokens(secondRes, noop)
        fullResponse = secondResponse
      }
    }
  }

  if (toolCallName === 'fetch_sec_filings') {
    const { fetchRecent8KForSPYComponents, fetchRecent13FForSelectedFunds } = await import('../data/secEdgarService')
    const [recent8k, recent13f] = await Promise.allSettled([
      fetchRecent8KForSPYComponents(3),
      fetchRecent13FForSelectedFunds(3),
    ])

    let secBlock = '\n=== CONTEXTO SEC (8-K / 13F) ===\n'
    if (recent8k.status === 'fulfilled' && recent8k.value.length > 0) {
      secBlock += '8-K recentes de componentes SPY:\n'
      for (const e of recent8k.value.slice(0, 3)) {
        const date = e.filedAt.slice(0, 10)
        const sym = e.symbol ?? e.cik
        const title = e.title ?? 'Evento 8-K'
        secBlock += `- ${date} — ${sym}: ${title}\n`
      }
    }
    if (recent13f.status === 'fulfilled' && recent13f.value.length > 0) {
      secBlock += '\n13F recentes (posição em SPY para fundos selecionados):\n'
      for (const p of recent13f.value.slice(0, 3)) {
        const dir = p.changeVsPrev ?? 'flat'
        secBlock += `- ${p.managerName}: posição em SPY (${dir}) no relatório de ${p.reportDate}\n`
      }
    }

    const followUpMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_sec',
            type: 'function',
            function: { name: 'fetch_sec_filings', arguments: '{}' },
          },
        ],
      } as any,
      { role: 'tool', tool_call_id: 'call_sec', content: secBlock } as any,
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
        max_tokens: 2500,
        messages: followUpMessages,
      }),
    })
    if (secondRes.ok && secondRes.body) {
      const { fullResponse: secondResponse } = await streamTokens(secondRes, noop)
      fullResponse = secondResponse
    }
  }

  if (toolCallName === 'search_live_news') {
    let query = 'SPY market movement today'
    let reason = 'anomalia detectada'
    try {
      const parsed = JSON.parse(toolCallArgs || '{}') as { query?: string; reason?: string }
      if (parsed.query) query = parsed.query
      if (parsed.reason) reason = parsed.reason
    } catch {
      console.warn('[search_live_news] Falha ao parsear toolCallArgs, usando query genérica')
    }

    const tavilyResults = await searchLiveNews(query)
    const digest = await buildNewsDigest(tavilyResults, reason)
    const mostRecentDate = tavilyResults.find((r) => r.published_date)?.published_date ?? null
    const newsConf = calculateConfidence('tavily', mostRecentDate)
    const newsBlock = digest
      ? `\n=== NOTÍCIAS AO VIVO (busca contextualizada) ===\n[Confiança: ${newsConf.score} ${newsConf.label}]\n${digest}\n`
      : '\n=== NOTÍCIAS AO VIVO ===\nSem notícias de impacto encontradas para este movimento.\n'

    if (usedClaude) {
      const claudeFollowUp = await streamClaudeAnalyze({
        system: systemPrompt,
        messages: [
          { role: 'user', content: userContent },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_news', name: 'search_live_news', input: { query, reason } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_news', content: newsBlock }],
          },
        ],
        sendEvent: noop,
        includeTools: false,
      })
      fullResponse = claudeFollowUp.fullResponse
    } else if (CONFIG.OPENAI_API_KEY) {
      const followUpMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_news', type: 'function', function: { name: 'search_live_news', arguments: toolCallArgs || '{}' } },
          ],
        } as any,
        { role: 'tool', tool_call_id: 'call_news', content: newsBlock } as any,
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
          max_tokens: 2500,
          messages: followUpMessages,
        }),
      })
      if (secondRes.ok && secondRes.body) {
        const { fullResponse: secondResponse } = await streamTokens(secondRes, noop)
        fullResponse = secondResponse
      }
    }
  }

  const structured = await extractStructuredOutput(fullResponse, snapshot, optionChain, {
    regimeScorerResult: regimeScoreBlockResult.regimeScorerResult,
    gexVsYesterday: regimeScoreBlockResult.gexVsYesterday,
  })
  return { fullText: fullResponse, structured }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerOpenAI(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: AnalyzeBody }>('/api/analyze', { preHandler: [analysisRateLimit] }, async (request, reply) => {
    // Validar ANTHROPIC_API_KEY se Claude estiver habilitado
    if (CONFIG.ANTHROPIC_API_KEY && CONFIG.ANTHROPIC_API_KEY.length < 20) {
      request.log.error('[ANALYZE] ANTHROPIC_API_KEY inválida ou muito curta')
      reply.code(500).send({ error: 'Configuração de IA inválida' })
      return
    }

    let res: ServerResponse | null = null
    let sendEvent: (event: string, data: unknown) => void = () => {}

    try {
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

    res = reply.raw as ServerResponse
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.setHeader('Access-Control-Allow-Origin', CONFIG.CORS_ORIGIN)
    res.flushHeaders()
    // Immediate ping so proxies with short read-timeout don't kill the connection
    // before the first GPT-4o token arrives
    res.write('event: ping\ndata: starting\n\n')

    const userId = (request as any).user?.id ?? 'unknown'
    const advancedSnapshot = getAdvancedMetricsSnapshot()
    // Derive dominant GEX regime from dynamic entries (majority wins)
    const gexDynEntries = advancedSnapshot?.gexDynamic ?? []
    const positiveCount = gexDynEntries.filter((e) => e.gex.regime === 'positive').length
    const dominantRegime = gexDynEntries.length > 0
      ? (positiveCount >= gexDynEntries.length / 2 ? 'positive' : 'negative')
      : undefined
    const memoryBlock = await buildMemoryBlock(userId, {
      ivRank: snapshot?.ivRank?.value ?? 0,
      vix: snapshot?.vix?.last ?? 0,
      gexRegime: dominantRegime,
    })
    const gexMultiBlock = advancedSnapshot?.gexDynamic && advancedSnapshot.gexDynamic.length > 0
      ? buildGexMultiDTEBlock(advancedSnapshot.gexDynamic)
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

    const techBlock = (techSnapshot && shouldIncludeTechBlock())
      ? buildTechBlock(techSnapshot, confidence, getLastVwap())
      : null

    const priceHistoryBlock = buildPriceHistoryBlock(marketState.spy.priceHistory)
    const expectedMoveSnapshot = getExpectedMoveSnapshot()
    const expectedMoveBlock = buildExpectedMoveBlock(
      expectedMoveSnapshot,
      snapshot?.spy?.last ?? 0,
    )
    const ivByExpirationBlock = buildIVByExpirationBlock()
    const popReferenceBlock = buildPOPReferenceBlock(snapshot?.spy?.last ?? 0)
    const regimeVetoBlock = buildRegimeVetoBlock(snapshot, confidence, advancedSnapshot?.gexDynamic ?? null)
    const regimeScoreBlockResult = buildRegimeScoreBlock(advancedSnapshot?.gexDynamic ?? null)
    const skewSnapshotForPrompt = getSkewSnapshot()
    const skewBlock = skewSnapshotForPrompt ? buildSkewBlock(skewSnapshotForPrompt) : null
    const opexBlock = buildOpexBlock()
    const gexHistory = await loadGEXHistory(5)
    const gexHistoryCtx = computeGEXHistoryContext(gexHistory)
    const gexHistoryBlock = gexHistoryCtx ? buildGexHistoryBlock(gexHistoryCtx) : null
    const volHistory = await loadVolumeHistory(5)
    const todayVolSnap = volHistory.length > 0 ? volHistory[volHistory.length - 1] : null
    const volAnomalyData = (todayVolSnap && volHistory.length >= 2)
      ? computeVolumeAnomaly(todayVolSnap, volHistory.slice(0, -1))
      : null
    const volAnomalyBlock = (volAnomalyData && (volAnomalyData.sizzle0dte > 1.5 || volAnomalyData.sizzle0dte < 0.6))
      ? buildVolumeAnomalyBlock(volAnomalyData)
      : null
    const cboePCRData = await getLastCBOEPCR()
    const cboePCRBlock = cboePCRData ? buildCBOEPCRBlock(cboePCRData) : null
    const danBlockMain = advancedSnapshot?.dan ? buildDANBlock(advancedSnapshot.dan) : null
    const ivConeSnapshotMain = getIVConeSnapshot()
    const ivConeBlockMain = ivConeSnapshotMain ? buildIVConeBlock(ivConeSnapshotMain) : null
    const macroDigestDataMain = getLastMacroDigest()
    const macroDigestBlockMain = macroDigestDataMain ? buildMacroDigestBlock(macroDigestDataMain) : null
    let secSummaryBlockMain: string | null = null
    try {
      const { fetchRecent8KForSPYComponents, fetchRecent13FForSelectedFunds } = await import('../data/secEdgarService')
      const [recent8kMain, recent13fMain] = await Promise.allSettled([
        fetchRecent8KForSPYComponents(3),
        fetchRecent13FForSelectedFunds(3),
      ])
      const eventsMain = recent8kMain.status === 'fulfilled' ? recent8kMain.value : null
      const positionsMain = recent13fMain.status === 'fulfilled' ? recent13fMain.value : null
      secSummaryBlockMain = buildSecSummaryBlock(eventsMain, positionsMain)
    } catch {
      secSummaryBlockMain = null
    }

    const userContent = buildPrompt(
      snapshot,
      body.optionChain,
      freshness,
      memoryBlock || undefined,
      gexMultiBlock,
      pcBlock,
      confidence,
      techBlock,
      priceHistoryBlock || null,
      expectedMoveBlock,
      ivByExpirationBlock,
      popReferenceBlock,
      regimeVetoBlock,
      regimeScoreBlockResult.block,
      skewBlock,
      opexBlock,
      gexHistoryBlock,
      volAnomalyBlock,
      cboePCRBlock,
      danBlockMain,
      ivConeBlockMain,
      macroDigestBlockMain,
      secSummaryBlockMain,
    )
    const useClaudePrimary = Boolean(CONFIG.ANTHROPIC_API_KEY)
    if (!CONFIG.ANTHROPIC_API_KEY) {
      console.error('[CRITICAL] ANTHROPIC_API_KEY is missing — todas as análises serão roteadas para OpenAI')
    }
    console.log(`[ANALYZE] user=${userId} primary=${useClaudePrimary ? 'claude' : 'gpt-4o'} tokens_max=1200`)

    sendEvent = (event: string, data: unknown) => {
      if (res?.writable) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const marketStatusNote = isMarketOpen()
      ? ''
      : 'ATENÇÃO: O mercado está FECHADO no momento (fim de semana ou fora do horário de negociação NYSE). ' +
        'Todos os dados disponíveis são da última captura antes do fechamento — não há cotações ao vivo. ' +
        'Comece a análise mencionando isso explicitamente. ' +
        'Enquadre qualquer recomendação para a próxima abertura de mercado; não sugira entradas ou saídas imediatas.\n\n'

    const systemPrompt = buildSystemPrompt(marketStatusNote)

    const baseMessages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ]

      let firstResponse = ''
      let toolCallName: string | null = null
      let toolCallArgs = ''
      let usedClaude = false

      if (useClaudePrimary) {
        const claudeResult = (await claudeAnalysisBreaker.fire({
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }],
          sendEvent,
        })) as { fullResponse: string; toolCallName: string | null; toolCallArgs: string } | null
        if (claudeResult != null) {
          usedClaude = true
          firstResponse = claudeResult.fullResponse
          toolCallName = claudeResult.toolCallName
          toolCallArgs = claudeResult.toolCallArgs
        }
      }

      if (!usedClaude) {
        console.warn('[FALLBACK TRIGGERED] Claude retornou null (falha ou breaker aberto). Roteando para OpenAI...')
        const firstRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o',
            stream: true,
            max_tokens: 2500,
            tools: [FETCH_CONTEXT_TOOL, FETCH_SEC_FILINGS_TOOL, SEARCH_LIVE_NEWS_TOOL],
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
        const openaiFirst = await streamTokens(firstRes, sendEvent)
        firstResponse = openaiFirst.fullResponse
        toolCallName = openaiFirst.toolCallName
        toolCallArgs = openaiFirst.toolCallArgs
      }

      let fullResponse = firstResponse!

      if (toolCallName === 'fetch_24h_context') {
        console.log(`[ANALYZE] user=${userId} tool_call=fetch_24h_context → injecting macro context`)
        const macroBlock = buildMacroContextBlock(body.context, freshness, confidence)

        if (usedClaude) {
          const claudeFollowUp = await streamClaudeAnalyze({
            system: systemPrompt,
            messages: [
              { role: 'user', content: userContent },
              {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'call_macro', name: 'fetch_24h_context', input: {} }],
              },
              {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'call_macro', content: macroBlock }],
              },
            ],
            sendEvent,
            includeTools: false,
          })
          fullResponse = claudeFollowUp.fullResponse
        } else {
          const followUpMessages = [
            ...baseMessages,
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'call_macro', type: 'function', function: { name: 'fetch_24h_context', arguments: '{}' } },
              ],
            } as any,
            { role: 'tool', tool_call_id: 'call_macro', content: macroBlock } as any,
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
              max_tokens: 2500,
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
        }
      } else if (toolCallName === 'fetch_sec_filings') {
        console.log(`[ANALYZE] user=${userId} tool_call=fetch_sec_filings → injecting SEC context`)
        const { fetchRecent8KForSPYComponents, fetchRecent13FForSelectedFunds } = await import('../data/secEdgarService')
        const [recent8k, recent13f] = await Promise.allSettled([
          fetchRecent8KForSPYComponents(3),
          fetchRecent13FForSelectedFunds(3),
        ])

        let secBlock = '\n=== CONTEXTO SEC (8-K / 13F) ===\n'
        if (recent8k.status === 'fulfilled' && recent8k.value.length > 0) {
          secBlock += '8-K recentes de componentes SPY:\n'
          for (const e of recent8k.value.slice(0, 3)) {
            const date = e.filedAt.slice(0, 10)
            const sym = e.symbol ?? e.cik
            const title = e.title ?? 'Evento 8-K'
            secBlock += `- ${date} — ${sym}: ${title}\n`
          }
        }
        if (recent13f.status === 'fulfilled' && recent13f.value.length > 0) {
          secBlock += '\n13F recentes (posição em SPY para fundos selecionados):\n'
          for (const p of recent13f.value.slice(0, 3)) {
            const dir = p.changeVsPrev ?? 'flat'
            secBlock += `- ${p.managerName}: posição em SPY (${dir}) no relatório de ${p.reportDate}\n`
          }
        }

        const followUpMessages = [
          ...baseMessages,
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_sec', type: 'function', function: { name: 'fetch_sec_filings', arguments: '{}' } },
            ],
          } as any,
          { role: 'tool', tool_call_id: 'call_sec', content: secBlock } as any,
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
            max_tokens: 2500,
            messages: followUpMessages,
          }),
        })
        if (!secondRes.ok) {
          const text = await secondRes.text()
          sendEvent('error', { message: `OpenAI error (follow-up SEC): ${secondRes.status} — ${text}` })
          res.end()
          return
        }
        const { fullResponse: secondResponse } = await streamTokens(secondRes, sendEvent)
        fullResponse = secondResponse
      } else if (toolCallName === 'search_live_news') {
        console.log(`[ANALYZE] user=${userId} tool_call=search_live_news → fetching live news`)

        let query = 'SPY market movement today'
        let reason = 'anomalia detectada'
        try {
          const parsed = JSON.parse(toolCallArgs || '{}') as { query?: string; reason?: string }
          if (parsed.query) query = parsed.query
          if (parsed.reason) reason = parsed.reason
        } catch {
          console.warn('[search_live_news] Falha ao parsear toolCallArgs, usando query genérica')
        }

        sendEvent('token', { text: `\n[Buscando notícias: ${reason}...]\n` })

        const tavilyResults = await searchLiveNews(query)
        const digest = await buildNewsDigest(tavilyResults, reason)
        const mostRecentDate = tavilyResults.find((r) => r.published_date)?.published_date ?? null
        const newsConf = calculateConfidence('tavily', mostRecentDate)
        const newsBlock = digest
          ? `\n=== NOTÍCIAS AO VIVO (busca contextualizada) ===\n[Confiança: ${newsConf.score} ${newsConf.label}]\n${digest}\n`
          : '\n=== NOTÍCIAS AO VIVO ===\nSem notícias de impacto encontradas para este movimento.\n'

        if (usedClaude) {
          const claudeFollowUp = await streamClaudeAnalyze({
            system: systemPrompt,
            messages: [
              { role: 'user', content: userContent },
              {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'call_news', name: 'search_live_news', input: { query, reason } }],
              },
              {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'call_news', content: newsBlock }],
              },
            ],
            sendEvent,
            includeTools: false,
          })
          fullResponse = claudeFollowUp.fullResponse
        } else {
          const followUpMessages = [
            ...baseMessages,
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'call_news', type: 'function', function: { name: 'search_live_news', arguments: toolCallArgs || '{}' } },
              ],
            } as any,
            { role: 'tool', tool_call_id: 'call_news', content: newsBlock } as any,
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
              max_tokens: 2500,
              messages: followUpMessages,
            }),
          })
          if (!secondRes.ok) {
            const text = await secondRes.text()
            sendEvent('error', { message: `OpenAI error (news follow-up): ${secondRes.status} — ${text}` })
            res.end()
            return
          }
          const { fullResponse: secondResponse } = await streamTokens(secondRes, sendEvent)
          fullResponse = secondResponse
        }
      } else {
        console.log(`[ANALYZE] user=${userId} tool_call=none → base context only`)
      }

      // Extract structured output via JSON Schema enforcement
      const structured = await extractStructuredOutput(fullResponse, snapshot, body.optionChain, {
        regimeScorerResult: regimeScoreBlockResult.regimeScorerResult,
        gexVsYesterday: regimeScoreBlockResult.gexVsYesterday,
      })
      if (structured) {
        sendEvent('structured', structured)
        registerAlertsFromAnalysis(userId, structured)
      }
      sendEvent('done', { provider: usedClaude ? 'Anthropic' : 'OpenAI Fallback' })
      saveAnalysis(userId, fullResponse, {
        spyPrice: snapshot?.spy?.last ?? 0,
        vix: snapshot?.vix?.last ?? 0,
        ivRank: snapshot?.ivRank?.value ?? 0,
      }, structured ?? undefined).catch(() => {})
      res.end()
    } catch (err) {
      const error = err as Error
      request.log.error({ err: error, stack: error.stack }, '[ANALYZE] Erro fatal na análise')
      try {
        if (res?.writable && !res.writableEnded) {
          sendEvent('error', {
            message: error.message,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
          })
          res.end()
        } else if (!reply.sent) {
          reply.code(500).send({ error: 'Erro interno na IA', details: error.message })
        }
      } catch (e) {
        request.log.error(e, '[ANALYZE] Erro ao enviar resposta de erro')
      }
    }

    reply.hijack()
  })

  // ---------------------------------------------------------------------------
  // POST /api/chat-followup — follow-up questions on current analysis (gpt-4o-mini, no rate limit)
  // ---------------------------------------------------------------------------

  interface ChatFollowupBody {
    question: string
    analysisId?: string
    structuredOutput: AnalysisStructuredOutput
    chatHistory: Array<{ role: 'user' | 'assistant'; content: string }>
  }

  fastify.post<{ Body: ChatFollowupBody }>('/api/chat-followup', async (request, reply) => {
    const body = request.body ?? {}
    const { question, structuredOutput: so, chatHistory = [] } = body
    if (!question?.trim() || !so) {
      reply.code(400).send({ error: 'question and structuredOutput are required' })
      return
    }

    const keyLevels = so.key_levels
    const levelsStr = [
      ...(keyLevels.support ?? []),
      ...(keyLevels.resistance ?? []),
      keyLevels.gex_flip,
    ].filter(Boolean).join(', ')

    const systemContent =
      'Você é o mesmo especialista em opções SPY que gerou a análise anterior. ' +
      'Responda perguntas de follow-up de forma concisa (máx 150 palavras). ' +
      `Análise atual: bias=${so.bias}, estratégia="${so.suggested_strategy?.name ?? 'N/A'}", ` +
      `níveis-chave=${levelsStr || 'N/A'}, confiança=${so.confidence}`

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemContent },
      ...chatHistory.slice(-6).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: question.trim() },
    ]

    const res = reply.raw as ServerResponse
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.setHeader('Access-Control-Allow-Origin', CONFIG.CORS_ORIGIN)
    res.flushHeaders()
    res.write('event: ping\ndata: starting\n\n')

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
          model: 'gpt-4o-mini',
          stream: true,
          max_tokens: 200,
          messages,
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
          if (raw === '[DONE]') continue
          try {
            const chunk = JSON.parse(raw) as { choices?: Array<{ delta?: { content?: string } }> }
            const text = chunk.choices?.[0]?.delta?.content
            if (text) sendEvent('token', { text })
          } catch {
            // skip
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
    res.setHeader('Access-Control-Allow-Origin', CONFIG.CORS_ORIGIN)
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
          max_tokens: 800,
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

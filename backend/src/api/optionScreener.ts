// backend/src/api/optionScreener.ts

import type { FastifyInstance } from 'fastify'
import OpenAI from 'openai'
import { getTradierClient } from '../lib/tradierClient'
import { CONFIG } from '../config'
import { requireAuth } from '../middleware/authMiddleware'
import { cacheGet, cacheSet } from '../lib/cacheStore'
import { calculatePutCallRatio } from '../data/putCallRatio'
import { calculateMaxPain } from '../lib/maxPainCalculator'
import type { MaxPainInput } from '../lib/maxPainCalculator'
import { calculateIVPercentile } from '../lib/ivPercentileCalculator'
import { getEventsForSymbol } from '../lib/eventsCalendar'
import { marketState } from '../data/marketState'
import { isMarketOpen } from '../lib/time'
import {
  findATMOption,
  buildCandidate,
  DEFAULT_FILTER_CONFIG,
  CLOSED_MARKET_FILTER_CONFIG,
} from '../lib/optionScreenerFilters'
import type { FilterConfig } from '../lib/optionScreenerFilters'
import {
  ALL_TICKERS,
  PRESET_TICKERS,
  PRESET_IVR_THRESHOLD,
  DELTA_RANGES,
} from '../types/optionScreener'
import type {
  OptionCandidate,
  OptionDeepDive,
  OptionStrategy,
  IVSkew,
  ScanRequest,
  AnalyzeRequest,
  OptionScreenerScanResult,
} from '../types/optionScreener'

const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY })

const SCAN_CACHE_TTL_OPEN   = 5  * 60 * 1000  // 5 min during market hours
const SCAN_CACHE_TTL_CLOSED = 60 * 60 * 1000  // 60 min after hours (data stale)

/**
 * Resolve the best expiration for option screening: prefers the date closest
 * to 30 DTE within the 21–60 DTE window, where monthlies have meaningful OI.
 * Falls back to the nearest expiration >= 21 DTE if nothing is in range.
 * NOTE: intentionally NOT using resolveScreenerExpiration, which targets 0DTE.
 */
async function resolveScreenerExpiration(symbol: string): Promise<string | null> {
  const expirations = await getTradierClient().getExpirations(symbol)
  if (expirations.length === 0) return null

  const now = Date.now()
  const withDTE = expirations.map((exp) => {
    const dte = Math.round((new Date(exp + 'T12:00:00Z').getTime() - now) / 86_400_000)
    return { exp, dte }
  })

  // Prefer expirations in the 21–60 DTE sweet spot, sorted by proximity to 30 DTE
  const inRange = withDTE
    .filter(({ dte }) => dte >= 21 && dte <= 60)
    .sort((a, b) => Math.abs(a.dte - 30) - Math.abs(b.dte - 30))

  if (inRange.length > 0) return inRange[0].exp

  // Fallback: nearest expiration with at least 21 DTE
  const fallback = withDTE.filter(({ dte }) => dte >= 21).sort((a, b) => a.dte - b.dte)
  return fallback[0]?.exp ?? null
}

function scanCacheKey(tickers: string[]): string {
  return `option_screener_scan:${[...tickers].sort().join(',')}`
}

// ---------------------------------------------------------------------------
// Phase 1 helpers
// ---------------------------------------------------------------------------

async function scanTicker(symbol: string, minIVR: number, marketOpen: boolean): Promise<OptionCandidate | null> {
  try {
    const client = getTradierClient()
    const quotes = await client.getQuotes([symbol])
    if (!quotes || quotes.length === 0) { console.log(`[Screener] ${symbol}: no quote`); return null }
    const quote = quotes[0]
    if (!quote.last || quote.last < (marketOpen ? 20 : 15)) { console.log(`[Screener] ${symbol}: price too low (${quote.last})`); return null }

    const expiration = await resolveScreenerExpiration(symbol)
    if (!expiration) { console.log(`[Screener] ${symbol}: no expiration`); return null }

    const options = await client.getOptionChain(symbol, expiration)
    if (!options || options.length === 0) { console.log(`[Screener] ${symbol}: no options for ${expiration}`); return null }

    const calls = options.filter((o) => o.option_type === 'call')
    const atmCall = findATMOption(calls, quote.last)
    if (!atmCall) { console.log(`[Screener] ${symbol}: no ATM call`); return null }

    // IVR: use polled value for SPY, chain smv_vol as proxy for others
    const chainIV = (atmCall.greeks?.smv_vol ?? 0) * 100
    const ivRank = symbol === 'SPY'
      ? (marketState.ivRank.value ?? chainIV)
      : chainIV

    const underlyingVol = quote.volume ?? 0
    const avg20dVol = (quote as any).average_volume ?? underlyingVol
    const spread = atmCall.ask - atmCall.bid
    const midpoint = (atmCall.ask + atmCall.bid) / 2

    const baseConfig = marketOpen ? DEFAULT_FILTER_CONFIG : CLOSED_MARKET_FILTER_CONFIG
    const filterConfig: FilterConfig = { ...baseConfig, minIVR: Math.min(minIVR, baseConfig.minIVR) }

    const diagReasons: string[] = []
    if (quote.last < filterConfig.minPrice) diagReasons.push(`price=${quote.last}<${filterConfig.minPrice}`)
    if (underlyingVol < filterConfig.minUnderlyingVolume) diagReasons.push(`uvol=${underlyingVol}<${filterConfig.minUnderlyingVolume}`)
    if (ivRank < filterConfig.minIVR || ivRank > filterConfig.maxIVR) diagReasons.push(`ivr=${ivRank.toFixed(1)} not in [${filterConfig.minIVR},${filterConfig.maxIVR}]`)
    if (atmCall.open_interest < filterConfig.minOI) diagReasons.push(`oi=${atmCall.open_interest}<${filterConfig.minOI}`)
    if (atmCall.volume < filterConfig.minOptionVolume) diagReasons.push(`vol=${atmCall.volume}<${filterConfig.minOptionVolume}`)
    if (spread < 0) diagReasons.push(`spread<0`)
    if (spread > filterConfig.maxBidAskAbsolute) diagReasons.push(`spread=$${spread.toFixed(2)}>$${filterConfig.maxBidAskAbsolute}`)
    if (midpoint > 0 && spread / midpoint > filterConfig.maxBidAskPct) diagReasons.push(`spreadPct=${(spread/midpoint*100).toFixed(1)}%>${filterConfig.maxBidAskPct*100}%`)

    if (diagReasons.length > 0) {
      console.log(`[Screener] ${symbol}: FAIL — ${diagReasons.join(', ')} | smv_vol=${atmCall.greeks?.smv_vol ?? 'null'} strike=${atmCall.strike} bid=${atmCall.bid} ask=${atmCall.ask}`)
      return null
    }

    console.log(`[Screener] ${symbol}: PASS — ivr=${ivRank.toFixed(1)} spread=$${spread.toFixed(2)} oi=${atmCall.open_interest} uvol=${underlyingVol}`)
    return buildCandidate(symbol, quote.last, ivRank, atmCall, underlyingVol, avg20dVol, expiration, 'tastytrade')
  } catch (err) {
    console.log(`[Screener] ${symbol}: exception — ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Phase 2 helpers
// ---------------------------------------------------------------------------

function calculateIVSkew(options: { option_type: string; greeks?: { delta?: number; mid_iv?: number } }[]): IVSkew | null {
  const calls = options.filter((o) => o.option_type === 'call')
  const puts  = options.filter((o) => o.option_type === 'put')

  const otmCalls = calls.filter((o) => o.greeks?.delta !== undefined && o.greeks.delta < 0.45 && o.greeks.delta > 0.15)
  const otmPuts  = puts.filter((o)  => o.greeks?.delta !== undefined && Math.abs(o.greeks.delta!) < 0.45 && Math.abs(o.greeks.delta!) > 0.15)

  if (otmCalls.length === 0 || otmPuts.length === 0) return null

  const avgCallIV = otmCalls.reduce((s, o) => s + (o.greeks?.mid_iv ?? 0), 0) / otmCalls.length * 100
  const avgPutIV  = otmPuts.reduce((s, o)  => s + (o.greeks?.mid_iv ?? 0), 0) / otmPuts.length * 100

  return {
    callIV: Math.round(avgCallIV * 10) / 10,
    putIV:  Math.round(avgPutIV  * 10) / 10,
    skew:   Math.round((avgPutIV - avgCallIV) * 10) / 10,
  }
}

function buildDeepDivePrompt(deepDive: OptionDeepDive, deltaProfile: AnalyzeRequest['deltaProfile']): string {
  const dr = DELTA_RANGES[deltaProfile]
  const mp = deepDive.maxPain
  const ev = deepDive.events

  const eventsBlock = [
    ev.earningsWithinDTE  ? `⚠️ EARNINGS within DTE: ${ev.nextEarnings}` : `Earnings: ${ev.nextEarnings ?? 'None scheduled'}`,
    ev.exDivWithin5Days   ? `⚠️ EX-DIVIDEND in ≤5 days: ${ev.exDividendDate}` : `Ex-dividend: ${ev.exDividendDate ?? 'None soon'}`,
    ev.upcomingMacroEvents.length > 0 ? `Macro events: ${ev.upcomingMacroEvents.join(', ')}` : 'No major macro events',
  ].join('\n')

  return `You are a quantitative options strategist. Suggest the single best option strategy for ${deepDive.symbol}.

## Market Context
Current Price: $${deepDive.price}
IV Rank: ${deepDive.ivRank}${deepDive.ivPercentile !== null ? ` · IVP ${deepDive.ivPercentile}%` : ''}
Max Pain: ${mp ? `$${mp.maxPainStrike} (${mp.distancePct > 0 ? '+' : ''}${mp.distancePct.toFixed(2)}% from spot, pin risk: ${mp.pinRisk})` : 'N/A'}
Put/Call Ratio: ${deepDive.putCallRatio?.toFixed(2) ?? 'N/A'}
GEX Regime: ${deepDive.gexRegime ?? 'Unknown'}
IV Skew: ${deepDive.ivSkew ? `Call IV ${deepDive.ivSkew.callIV}% · Put IV ${deepDive.ivSkew.putIV}% · Skew ${deepDive.ivSkew.skew > 0 ? '+' : ''}${deepDive.ivSkew.skew}` : 'N/A'}

## Events
${eventsBlock}

## Constraints
- Delta range for primary strike: ${dr.min} to ${dr.max} (${deltaProfile} profile)
- DTE: prefer 21–45 days. Avoid expiries containing earnings.
- If IVR > 40: prefer premium-selling strategies (CSP, CC, vertical spread)
- If IVR < 20: prefer premium-buying strategies (long call/put)

## Output (JSON only, no markdown)
Respond with a single JSON object matching exactly this schema:
{
  "type": "cash_secured_put"|"covered_call"|"bull_put_spread"|"bear_call_spread"|"iron_condor"|"long_call"|"long_put",
  "symbol": string,
  "strikes": number[],
  "expiration": "YYYY-MM-DD",
  "dte": number,
  "credit": number|null,
  "debit": number|null,
  "delta": number,
  "popEstimate": number,
  "maxProfit": number,
  "maxLoss": number|null,
  "breakevens": number[],
  "rationale": string (2-3 sentences in pt-BR)
}`
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerOptionScreener(app: FastifyInstance): Promise<void> {
  // Phase 1 — Scan
  app.post<{ Body: ScanRequest }>(
    '/api/option-screener/scan',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { preset, deltaProfile = 'moderate' } = request.body ?? {}

      const marketOpen = isMarketOpen()

      // When market is closed and no preset is selected, limit universe to broad ETFs
      // to avoid scanning 37+ symbols and hitting Tradier timeouts.
      const resolvedPreset = preset ?? (marketOpen ? undefined : 'broad_etfs')
      const tickers = resolvedPreset ? PRESET_TICKERS[resolvedPreset] : ALL_TICKERS
      const minIVR  = resolvedPreset
        ? PRESET_IVR_THRESHOLD[resolvedPreset]
        : (marketOpen ? DEFAULT_FILTER_CONFIG.minIVR : CLOSED_MARKET_FILTER_CONFIG.minIVR)

      const cKey = scanCacheKey(tickers)
      const cached = await cacheGet<OptionScreenerScanResult>(cKey)
      if (cached) return reply.send({ ...cached, cacheHit: true })

      // Scan in parallel batches; smaller batch after hours to reduce rate-limit pressure
      const BATCH = marketOpen ? 10 : 5
      const results: OptionCandidate[] = []

      for (let i = 0; i < tickers.length; i += BATCH) {
        const batch = tickers.slice(i, i + BATCH)
        const settled = await Promise.allSettled(batch.map((sym) => scanTicker(sym, minIVR, marketOpen)))
        for (const r of settled) {
          if (r.status === 'fulfilled' && r.value !== null) {
            results.push(r.value)
          }
        }
      }

      const candidates = results
        .sort((a, b) => b.liquidityScore - a.liquidityScore)
        .slice(0, 5)

      const scanResult: OptionScreenerScanResult = {
        candidates,
        scannedAt: Date.now(),
        totalScanned: tickers.length,
        passedFilters: results.length,
        cacheHit: false,
        ...(!preset && resolvedPreset ? { autoPreset: resolvedPreset } : {}),
      }

      const cacheTtl = marketOpen ? SCAN_CACHE_TTL_OPEN : SCAN_CACHE_TTL_CLOSED
      await cacheSet(cKey, scanResult, cacheTtl, 'tradier')
      return reply.send(scanResult)
    },
  )

  // Phase 2 — Deep Dive + AI Strategy (SSE streaming)
  app.post<{ Body: AnalyzeRequest }>(
    '/api/option-screener/analyze',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { symbol, deltaProfile = 'moderate' } = request.body ?? {}
      if (!symbol || typeof symbol !== 'string' || !/^[A-Z]{1,5}(-[A-Z])?$/.test(symbol.trim().toUpperCase())) {
        return reply.status(400).send({ error: 'symbol inválido' })
      }
      const sym = symbol.toUpperCase()

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })

      function sendEvent(event: string, data: unknown): void {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      try {
        const client = getTradierClient()

        const expiration = await resolveScreenerExpiration(sym)
        if (!expiration) throw new Error('No expiration found')

        const [quotes, options] = await Promise.all([
          client.getQuotes([sym]),
          client.getOptionChain(sym, expiration),
        ])

        const quote = quotes?.[0]
        if (!quote?.last) throw new Error('No quote data')
        const spot = quote.last

        // Max Pain
        const strikeMap = new Map<number, { callOI: number; putOI: number }>()
        for (const opt of options) {
          const entry = strikeMap.get(opt.strike) ?? { callOI: 0, putOI: 0 }
          if (opt.option_type === 'call') entry.callOI += opt.open_interest
          else entry.putOI += opt.open_interest
          strikeMap.set(opt.strike, entry)
        }
        const painInputs: MaxPainInput[] = []
        strikeMap.forEach((v, strike) => painInputs.push({ strike, ...v }))
        const maxPain = painInputs.length > 0 ? calculateMaxPain(painInputs, spot) : null

        // IVR + IVP
        const calls = options.filter((o) => o.option_type === 'call')
        const atmCall = findATMOption(calls, spot)
        const chainIV = (atmCall?.greeks?.smv_vol ?? 0) * 100
        const ivRank = sym === 'SPY' ? (marketState.ivRank.value ?? chainIV) : chainIV
        const ivPercentile = await calculateIVPercentile(sym, chainIV).catch(() => null)

        // P/C Ratio
        const pcrResult = await calculatePutCallRatio(sym).catch(() => null)
        const putCallRatio = (() => {
          if (!pcrResult) return null
          const totalPut  = (pcrResult.putVolume  ?? 0) + (pcrResult.putOI  ?? 0)
          const totalCall = (pcrResult.callVolume ?? 0) + (pcrResult.callOI ?? 0)
          return totalCall > 0 ? totalPut / totalCall : null
        })()

        // GEX regime proxy
        const totalCallOI = options.filter((o) => o.option_type === 'call').reduce((s, o) => s + o.open_interest, 0)
        const totalPutOI  = options.filter((o) => o.option_type === 'put').reduce((s, o) => s + o.open_interest, 0)
        const gexRegime: 'positive' | 'negative' = totalCallOI > totalPutOI ? 'positive' : 'negative'

        // IV Skew
        const ivSkew = calculateIVSkew(options)

        // Events
        const events = await getEventsForSymbol(sym, 60)

        const deepDive: OptionDeepDive = {
          symbol: sym,
          price: spot,
          ivRank,
          ivPercentile,
          maxPain,
          putCallRatio,
          gexRegime,
          ivSkew,
          events,
        }

        sendEvent('metrics', deepDive)

        // Stream AI strategy
        const prompt = buildDeepDivePrompt(deepDive, deltaProfile)
        const stream = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          stream: true,
          temperature: 0.2,
        })

        let fullText = ''
        for await (const chunk of stream) {
          const token = chunk.choices[0]?.delta?.content ?? ''
          if (token) {
            fullText += token
            sendEvent('token', token)
          }
        }

        // Parse structured strategy from AI response
        try {
          const strategy = JSON.parse(fullText) as OptionStrategy
          sendEvent('strategy', strategy)
        } catch {
          // If AI didn't return valid JSON, send raw text as rationale
          const fallback = {
            type: 'cash_secured_put' as const,
            symbol: sym,
            strikes: [],
            expiration,
            dte: 30,
            credit: null,
            debit: null,
            delta: 0,
            popEstimate: 0,
            maxProfit: 0,
            maxLoss: null,
            breakevens: [],
            rationale: fullText,
          } satisfies OptionStrategy
          sendEvent('strategy', fallback)
        }

        sendEvent('done', null)
      } catch (err) {
        sendEvent('error', { message: err instanceof Error ? err.message : 'Erro desconhecido' })
      } finally {
        reply.raw.end()
      }
    },
  )
}

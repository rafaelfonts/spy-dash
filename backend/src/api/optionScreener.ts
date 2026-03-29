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
  passesFilters,
} from '../lib/optionScreenerFilters'
import type { FilterConfig } from '../lib/optionScreenerFilters'
import {
  ALL_TICKERS,
  PRESET_TICKERS,
  PRESET_IVR_THRESHOLD,
  DELTA_RANGES,
  ETF_TICKERS,
} from '../types/optionScreener'
import type {
  OptionCandidate,
  OptionDeepDive,
  OptionStrategy,
  IVSkew,
  ScanRequest,
  AnalyzeRequest,
  OptionScreenerScanResult,
  DeepDiveVolMetrics,
} from '../types/optionScreener'
import { getUniverseIVRank } from '../data/ivRankUniversePoller'
import { getDailyContext } from '../data/equityDailyBarsCache'
import { calculateIRP, calculateRR25, calculateTSS, calculateRVP } from '../lib/volMetrics'

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

    // IVR: prefer polled Tastytrade value (true IV Rank 0–100), fallback to chain smv_vol (raw IV %, not rank)
    const chainIV = (atmCall.greeks?.smv_vol ?? 0) * 100
    const universeIVR = getUniverseIVRank(symbol)
    const ivRank = universeIVR?.value
      ?? (symbol === 'SPY' ? marketState.ivRank.value : null)
      ?? chainIV
    const ivRankSource: 'tastytrade' | 'chain_fallback' = universeIVR ? 'tastytrade' : 'chain_fallback'

    const underlyingVol = quote.volume ?? 0
    const avg20dVol = (quote as any).average_volume ?? underlyingVol
    const spread = atmCall.ask - atmCall.bid

    const baseConfig = marketOpen ? DEFAULT_FILTER_CONFIG : CLOSED_MARKET_FILTER_CONFIG
    const filterConfig: FilterConfig = { ...baseConfig, minIVR: Math.min(minIVR, baseConfig.minIVR) }

    const tickerType: 'etf' | 'single_stock' = ETF_TICKERS.has(symbol) ? 'etf' : 'single_stock'
    const filterConfigFinal: FilterConfig = { ...filterConfig, tickerType }
    const filterResult = passesFilters(atmCall, underlyingVol, quote.last, ivRank, filterConfigFinal)

    if (!filterResult.passes) {
      console.log(`[Screener] ${symbol}: FAIL | ivRankSource=${ivRankSource} ivr=${ivRank.toFixed(1)} spread=$${spread.toFixed(2)} oi=${atmCall.open_interest} uvol=${underlyingVol} smv_vol=${atmCall.greeks?.smv_vol ?? 'null'}`)
      return null
    }

    console.log(`[Screener] ${symbol}: PASS — ivr=${ivRank.toFixed(1)} (${ivRankSource}) spread=$${spread.toFixed(2)} oi=${atmCall.open_interest} uvol=${underlyingVol}`)
    return buildCandidate(symbol, quote.last, ivRank, atmCall, underlyingVol, avg20dVol, expiration, ivRankSource)
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
  // Normalize put deltas: Tastytrade returns positive (absolute convention), Black-Scholes returns negative.
  // Use Math.abs() to handle both conventions — filter for |delta| in [0.15, 0.45].
  const otmPuts  = puts.filter((o) => {
    const d = o.greeks?.delta
    if (d === undefined || d === null) return false
    const absDelta = Math.abs(d)
    return absDelta > 0.15 && absDelta < 0.45
  })

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

  const vm = deepDive.volMetrics
  const volMetricsBlock = vm ? [
    `IV Risk Premium: ${vm.irp !== null ? (vm.irp > 0 ? '+' : '') + vm.irp.toFixed(1) + 'pp' : 'N/A'}${vm.irp !== null ? (vm.irp > 0 ? ' (vol premium favorável ao vendedor)' : ' (vol premium desfavorável — comprador favorecido)') : ''}`,
    `25Δ Risk Reversal: ${vm.rr25 !== null ? vm.rr25.toFixed(1) + 'pp' : 'N/A'}${vm.rr25 !== null ? (vm.rr25 < -3 ? ' (put skew elevado — bearish implícito)' : vm.rr25 > 1 ? ' (call skew — bullish implícito)' : ' (skew neutro)') : ''}`,
    `Term Structure: ${vm.tss !== null ? (vm.tss >= 0 ? '+' : '') + (vm.tss * 100).toFixed(1) + '% ' + (vm.tss >= 0 ? 'contango' : '[!] backwardation') : 'N/A'}`,
    `Realized Vol Percentile: ${vm.rvp !== null ? vm.rvp + '° percentil' + (vm.rvp < 30 ? ' (compressão — favorável short vega)' : vm.rvp > 70 ? ' (expansão — favorável long vega)' : '') : 'N/A'}`,
  ].join('\n') : ''

  return `You are a quantitative options strategist. Suggest the single best option strategy for ${deepDive.symbol}.

## Market Context
Current Price: $${deepDive.price}
IV Rank: ${deepDive.ivRank}${deepDive.ivPercentile !== null ? ` · IVP ${deepDive.ivPercentile}%` : ''}
Max Pain: ${mp ? `$${mp.maxPainStrike} (${mp.distancePct > 0 ? '+' : ''}${mp.distancePct.toFixed(2)}% from spot, pin risk: ${mp.pinRisk})` : 'N/A'}
Put/Call Ratio: ${deepDive.putCallRatio?.toFixed(2) ?? 'N/A'}
GEX Regime: ${deepDive.gexRegime ?? 'Unknown'}
IV Skew: ${deepDive.ivSkew ? `Call IV ${deepDive.ivSkew.callIV}% · Put IV ${deepDive.ivSkew.putIV}% · Skew ${deepDive.ivSkew.skew > 0 ? '+' : ''}${deepDive.ivSkew.skew}` : 'N/A'}
${volMetricsBlock ? '\n## Vol Metrics\n' + volMetricsBlock : ''}
## Events
${eventsBlock}

## Constraints
- Delta range for primary strike: ${dr.min} to ${dr.max} (${deltaProfile} profile)
- DTE: prefer 21–45 days. Avoid expiries containing earnings.
- If IVR > 40: prefer premium-selling strategies (CSP, CC, vertical spread)
- If IVR < 20: prefer premium-buying strategies (long call/put)
- Use IRP and RVP to confirm/reject premium-selling strategy: positive IRP + low RVP percentile (<30) strongly favors selling vol

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

        // Vol Metrics (institutional: IRP, RR25, TSS, RVP)
        // Fetch a second expiration ~60 DTE for Term Structure Slope
        const expirations2 = await getTradierClient().getExpirations(sym).catch(() => [])
        const now2 = Date.now()
        const longExp = expirations2
          .map((e) => ({ e, dte: Math.round((new Date(e + 'T12:00:00Z').getTime() - now2) / 86_400_000) }))
          .filter(({ dte }) => dte >= 55 && dte <= 90)
          .sort((a, b) => Math.abs(a.dte - 60) - Math.abs(b.dte - 60))[0]

        let ivLong: number | null = null
        if (longExp) {
          const longOptions = await getTradierClient().getOptionChain(sym, longExp.e).catch(() => null)
          if (longOptions) {
            const longCalls = longOptions.filter((o) => o.option_type === 'call')
            const longATM = findATMOption(longCalls, spot)
            ivLong = longATM?.greeks?.smv_vol != null ? longATM.greeks.smv_vol * 100 : null
          }
        }

        // IVR from universe poller or fallback
        const universeIVRForMetrics = getUniverseIVRank(sym)
        const hv30ForMetrics = universeIVRForMetrics?.hv30 ?? null
        const ivAtmForMetrics = (atmCall?.greeks?.smv_vol ?? 0) * 100 || null

        // Daily bars for RVP
        const dailyCtx = getDailyContext(sym)
        const closes = dailyCtx?.bars?.map((b) => b.close) ?? []

        const volMetrics: DeepDiveVolMetrics = {
          irp: calculateIRP(ivAtmForMetrics, hv30ForMetrics),
          rr25: calculateRR25(options),
          tss: calculateTSS(ivAtmForMetrics, ivLong),
          rvp: calculateRVP(closes),
          termStructureInverted: (() => {
            const tss = calculateTSS(ivAtmForMetrics, ivLong)
            return tss !== null && tss < -0.03
          })(),
        }

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
          volMetrics,
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

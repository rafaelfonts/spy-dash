/**
 * Portfolio Tracker Service — Motor de Gestão de Ciclo de Vida.
 * Runs once per day (16:00 ET), fetches OPEN positions, enriches with DTE and profit %,
 * calls Claude Gestor de Risco, and sends alerts to Discord.
 */

import { createClient } from '@supabase/supabase-js'
import { sendEmbed, DISCORD_COLORS } from '../lib/discordClient'
import { getTradierClient } from '../lib/tradierClient'
import { redis } from '../lib/cacheStore'
import {
  buildPortfolioPayload,
  callGestorRisco,
} from './portfolioLifecycleAgent'
import { marketState } from './marketState'
import { getOptionChainSnapshot } from './optionChain'
import { buildSurfaceFromChain, getSmileIV } from '../lib/volSurface'
import {
  calcDelta, calcGamma, calcTheta, calcVega, calcVanna, calcCharm, calcOptionPrice,
} from '../lib/blackScholes'
import { getAdvancedMetricsSnapshot } from './advancedMetricsState'
import type {
  EnrichedPosition,
  GestorRiscoAlert,
  InsertPositionPayload,
  PortfolioPositionRow,
  SpreadGreeks,
  PortfolioGreeks,
} from '../types/portfolio'

// ---------------------------------------------------------------------------
// Supabase client (service role)
// ---------------------------------------------------------------------------

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

// ---------------------------------------------------------------------------
// ET helpers (business days and date)
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

/**
 * Count calendar days (not business days) between from and to.
 * Uses simple millisecond difference — weekend days are included.
 * to is exclusive so "today to expiration" gives the correct DTE.
 */
function diasCorridosEntre(from: Date, to: Date): number {
  const diff = to.getTime() - from.getTime()
  return diff <= 0 ? 0 : Math.ceil(diff / (24 * 60 * 60 * 1000))
}

/** Parse expiration_date (YYYY-MM-DD) to Date at start of day in ET. */
function parseExpirationET(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  const et = new Date(y!, m! - 1, d!)
  return new Date(et.toLocaleString('en-US', { timeZone: 'America/New_York' }))
}

// ---------------------------------------------------------------------------
// Fetch and enrich positions
// ---------------------------------------------------------------------------

async function getOpenPositions(): Promise<PortfolioPositionRow[]> {
  const { data, error } = await supabase
    .from('portfolio_positions')
    .select('*')
    .eq('status', 'OPEN')

  if (error) {
    console.error('[PortfolioTracker] Supabase error:', error.message)
    return []
  }
  return (data ?? []) as PortfolioPositionRow[]
}

/**
 * Insert a new OPEN position into portfolio_positions.
 * Used by POST /api/portfolio/positions.
 */
export async function insertPortfolioPosition(
  payload: InsertPositionPayload,
): Promise<PortfolioPositionRow | null> {
  const openDate = payload.open_date ?? getTodayDateET()
  const row = {
    symbol: payload.symbol.trim(),
    strategy_type: payload.strategy_type ?? 'PUT_SPREAD',
    open_date: openDate,
    expiration_date: payload.expiration_date,
    short_strike: payload.short_strike,
    long_strike: payload.long_strike,
    short_option_symbol: payload.short_option_symbol.trim(),
    long_option_symbol: payload.long_option_symbol.trim(),
    credit_received: payload.credit_received,
    status: 'OPEN' as const,
    comments: payload.comments ?? null,
  }
  const { data, error } = await supabase
    .from('portfolio_positions')
    .insert(row)
    .select()
    .single()

  if (error) {
    console.error('[PortfolioTracker] Insert error:', error.message)
    return null
  }
  return data as PortfolioPositionRow
}

/**
 * Delete a position by id (e.g. wrong entry). Used by DELETE /api/portfolio/positions/:id.
 */
export async function deletePortfolioPosition(id: string): Promise<boolean> {
  const { error } = await supabase
    .from('portfolio_positions')
    .delete()
    .eq('id', id)

  if (error) {
    console.error('[PortfolioTracker] Delete error:', error.message)
    return false
  }
  return true
}

async function enrichPositions(rows: PortfolioPositionRow[]): Promise<EnrichedPosition[]> {
  const tradier = getTradierClient()
  const allSymbols = [...new Set(rows.flatMap((r) => [r.short_option_symbol, r.long_option_symbol]))]
  let quotesBySymbol: Record<string, { bid: number; ask: number; last: number }> = {}

  try {
    const quotes = await tradier.getQuotes(allSymbols)
    for (const q of quotes) {
      quotesBySymbol[q.symbol] = {
        bid: q.bid ?? q.last ?? 0,
        ask: q.ask ?? q.last ?? 0,
        last: q.last ?? 0,
      }
    }
  } catch (err) {
    console.warn('[PortfolioTracker] Tradier getQuotes failed:', (err as Error).message)
    return []
  }

  const todayET = getETNow()
  const enriched: EnrichedPosition[] = []

  for (const row of rows) {
    const expDate = parseExpirationET(row.expiration_date)
    const dteCurrent = diasCorridosEntre(todayET, expDate)

    const short = quotesBySymbol[row.short_option_symbol]
    const long = quotesBySymbol[row.long_option_symbol]
    if (!short || !long) {
      console.warn(`[PortfolioTracker] Quote missing for position ${row.id}, skipping`)
      continue
    }
    const shortAsk = short.ask || short.last
    const longBid = long.bid || long.last

    const currentDebit = shortAsk - longBid
    const creditReceived = row.credit_received
    const profitPct = creditReceived > 0
      ? ((creditReceived - currentDebit) / creditReceived) * 100
      : 0

    const strategyLabel =
      row.strategy_type === 'CALL_SPREAD'
        ? `Call Spread ${row.short_strike}/${row.long_strike}`
        : `Put Spread ${row.short_strike}/${row.long_strike}`
    const strategy = strategyLabel
    enriched.push({
      id: row.id,
      strategy,
      dte_current: dteCurrent,
      profit_percentage: Math.round(profitPct * 10) / 10,
      profit_loss_dollars: Math.round((creditReceived - currentDebit) * 100 * 100) / 100,
      credit_received: creditReceived,
      current_cost_to_close: Math.round(currentDebit * 100) / 100,
      comments: row.comments ?? undefined,
    })
  }

  return enriched
}

// ---------------------------------------------------------------------------
// In-memory snapshot for dashboard (updated by cycle or by refresh)
// ---------------------------------------------------------------------------

export interface PortfolioSnapshot {
  positions: EnrichedPosition[]
  capturedAt: number
}

let lastEnrichedSnapshot: PortfolioSnapshot | null = null
let refreshCooldownUntil = 0
const REFRESH_COOLDOWN_MS = 60_000

function setSnapshot(positions: EnrichedPosition[]): void {
  lastEnrichedSnapshot = { positions, capturedAt: Date.now() }
}

/** Returns last enriched snapshot (from daily cycle or manual refresh). */
export function getPortfolioSnapshot(): PortfolioSnapshot | null {
  return lastEnrichedSnapshot
}

/**
 * Remove a position from the in-memory snapshot by id (e.g. after DELETE).
 * Keeps GET /api/portfolio in sync without a full refresh.
 */
export function removePositionFromSnapshot(id: string): void {
  if (!lastEnrichedSnapshot) return
  const filtered = lastEnrichedSnapshot.positions.filter((p) => p.id !== id)
  lastEnrichedSnapshot = { positions: filtered, capturedAt: lastEnrichedSnapshot.capturedAt }
}

/**
 * Refresh snapshot on demand: fetch OPEN positions, enrich via Tradier, update cache.
 * Cooldown 60s to avoid Tradier abuse.
 */
export async function refreshPortfolioSnapshot(): Promise<PortfolioSnapshot | null> {
  if (Date.now() < refreshCooldownUntil) {
    return lastEnrichedSnapshot
  }
  refreshCooldownUntil = Date.now() + REFRESH_COOLDOWN_MS
  const rows = await getOpenPositions()
  if (rows.length === 0) {
    setSnapshot([])
    return lastEnrichedSnapshot
  }
  const enriched = await enrichPositions(rows)
  setSnapshot(enriched)
  return lastEnrichedSnapshot
}

// ---------------------------------------------------------------------------
// Cycle: fetch → enrich → Claude → Discord
// ---------------------------------------------------------------------------

const LOCK_TTL_SEC = 300
const LOCK_KEY_PREFIX = 'lock:portfolio_tracker:'

export async function runPortfolioTrackerCycle(): Promise<void> {
  const dateET = getTodayDateET()
  const lockKey = LOCK_KEY_PREFIX + dateET

  const acquired = await redis.set(lockKey, '1', 'EX', LOCK_TTL_SEC, 'NX')
  if (!acquired) {
    console.log('[PortfolioTracker] Lock not acquired — another instance may be running')
    return
  }

  const rows = await getOpenPositions()
  if (rows.length === 0) {
    setSnapshot([])
    console.log('[PortfolioTracker] No OPEN positions, skipping cycle')
    return
  }

  const enriched = await enrichPositions(rows)
  setSnapshot(enriched)
  if (enriched.length === 0) {
    console.warn('[PortfolioTracker] No positions could be enriched (Tradier missing?), skipping Claude')
    return
  }

  const payload = buildPortfolioPayload(enriched)
  let response: { alerts: GestorRiscoAlert[] }
  try {
    response = await callGestorRisco(payload)
  } catch (err) {
    console.error('[PortfolioTracker] Claude GestorRisco failed:', (err as Error).message)
    return
  }

  for (const alert of response.alerts) {
    const isProfit = alert.recommendation === 'FECHAR_LUCRO'
    const isTime = alert.recommendation === 'FECHAR_TEMPO' || alert.recommendation === 'ROLAR'
    const isHold = alert.recommendation === 'MANTER'

    const color = isProfit ? DISCORD_COLORS.portfolioProfit
      : isTime ? DISCORD_COLORS.portfolioTime
      : DISCORD_COLORS.portfolioHold

    const icon = isProfit ? '💰' : isTime ? '⏰' : '✅'

    await sendEmbed('carteira', {
      title: `${icon} ${alert.recommendation} — ${alert.position_id ?? 'N/A'}`,
      description: alert.message,
      color,
      fields: [
        { name: 'Posição', value: alert.position_id ?? '—', inline: true },
        { name: 'Recomendação', value: alert.recommendation, inline: true },
      ],
      footer: { text: 'Motor de Ciclo de Vida 16:00 ET' },
      timestamp: new Date().toISOString(),
    })
  }

  console.log(`[PortfolioTracker] Cycle done: ${enriched.length} positions, ${response.alerts.length} alerts`)
}

// ---------------------------------------------------------------------------
// Scheduler: once per day at 16:00 ET
// ---------------------------------------------------------------------------

export function startPortfolioTrackerScheduler(): void {
  setInterval(() => {
    const et = getETNow()
    const dow = et.getDay()
    if (dow === 0 || dow === 6) return

    const h = et.getHours()
    const m = et.getMinutes()
    if (h === 16 && m === 0) {
      runPortfolioTrackerCycle().catch((err) =>
        console.error('[PortfolioTracker] Scheduler error:', err),
      )
    }
  }, 60_000)

  console.log('[PortfolioTracker] Scheduler started (check every 60s, run at 16:00 ET)')
}

// ---------------------------------------------------------------------------
// Portfolio Greeks + VaR computation (on-demand, called by GET /api/portfolio/greeks)
// ---------------------------------------------------------------------------

const RISK_FREE_RATE = 0.053  // 5.3% — updated periodically

/**
 * Reprice a put spread at a given spot scenario using BS.
 * Returns P&L: credit_received - max(0, shortValue - longValue).
 */
function repriceSpread(
  scenarioSpot: number,
  shortStrike: number,
  longStrike: number,
  dteYears: number,
  shortIV: number,
  longIV: number,
  creditReceived: number,
  type: 'call' | 'put',
): number {
  const shortVal = calcOptionPrice(scenarioSpot, shortStrike, dteYears, RISK_FREE_RATE, shortIV, type)
  const longVal  = calcOptionPrice(scenarioSpot, longStrike,  dteYears, RISK_FREE_RATE, longIV,  type)
  const spreadVal = Math.max(0, shortVal - longVal)
  return creditReceived - spreadVal
}

/**
 * Computes portfolio-level Greeks and VaR scenarios for all OPEN positions.
 * Uses the vol surface (5.1) to get strike-specific IV when available.
 * Falls back to ATM IV from marketState.ivRank.value / 100 when surface unavailable.
 */
export async function computePortfolioGreeks(): Promise<PortfolioGreeks | null> {
  const spy = marketState.spy.last
  if (!spy || spy <= 0) return null

  const rows = await getOpenPositions()
  if (rows.length === 0) {
    return {
      totalDelta: 0, totalGamma: 0, totalTheta: 0, totalVega: 0,
      positions: [],
      varScenarios: { oneStdDown: 0, twoStdDown: 0, oneStdUp: 0, twoStdUp: 0 },
      spy,
      capturedAt: new Date().toISOString(),
    }
  }

  // Build vol surface once for all positions
  const chain = getOptionChainSnapshot()
  const smiles = chain && chain.length > 0 ? buildSurfaceFromChain(chain, spy) : []
  const fallbackIV = (marketState.ivRank.value ?? 20) / 100  // IVR as rough ATM proxy

  // Get price distribution scenarios from the regime scorer (already computed each tick)
  const advSnap = getAdvancedMetricsSnapshot()
  const dist = advSnap?.regimePreview?.priceDistribution ?? null

  const positions: SpreadGreeks[] = []
  let totalDelta = 0, totalGamma = 0, totalTheta = 0, totalVega = 0

  // VaR: cumulative P&L at each scenario across all positions
  let pnl1Down = 0, pnl2Down = 0, pnl1Up = 0, pnl2Up = 0

  const todayET = getETNow()

  for (const row of rows) {
    const expDate = parseExpirationET(row.expiration_date)
    const dteDays = diasCorridosEntre(todayET, expDate)
    const dteYears = Math.max(dteDays / 365, 0.5 / 365)  // min 0.5 day

    const optionType: 'call' | 'put' = row.strategy_type === 'CALL_SPREAD' ? 'call' : 'put'

    // IV from surface if available; otherwise fall back
    const shortIV = smiles.length > 0
      ? getSmileIV(spy, row.short_strike, dteYears, smiles, fallbackIV)
      : fallbackIV
    const longIV = smiles.length > 0
      ? getSmileIV(spy, row.long_strike, dteYears, smiles, fallbackIV)
      : fallbackIV

    // Greeks — short spread = SOLD short_strike + BOUGHT long_strike
    // Convention: "−" for the sold leg, "+" for the bought leg
    const shortDelta = calcDelta(spy, row.short_strike, dteYears, RISK_FREE_RATE, shortIV, optionType)
    const longDelta  = calcDelta(spy, row.long_strike,  dteYears, RISK_FREE_RATE, longIV,  optionType)
    const shortGamma = calcGamma(spy, row.short_strike, dteYears, RISK_FREE_RATE, shortIV)
    const longGamma  = calcGamma(spy, row.long_strike,  dteYears, RISK_FREE_RATE, longIV)
    const shortTheta = calcTheta(spy, row.short_strike, dteYears, RISK_FREE_RATE, shortIV, optionType)
    const longTheta  = calcTheta(spy, row.long_strike,  dteYears, RISK_FREE_RATE, longIV,  optionType)
    const shortVega  = calcVega( spy, row.short_strike, dteYears, RISK_FREE_RATE, shortIV)
    const longVega   = calcVega( spy, row.long_strike,  dteYears, RISK_FREE_RATE, longIV)
    const shortVanna = calcVanna(spy, row.short_strike, dteYears, RISK_FREE_RATE, shortIV)
    const longVanna  = calcVanna(spy, row.long_strike,  dteYears, RISK_FREE_RATE, longIV)
    const shortCharm = calcCharm(spy, row.short_strike, dteYears, RISK_FREE_RATE, shortIV)
    const longCharm  = calcCharm(spy, row.long_strike,  dteYears, RISK_FREE_RATE, longIV)

    // Net = −shortLeg + longLeg  (multiplier 100 for $ per spread contract)
    const netDelta = (-shortDelta + longDelta) * 100
    const netGamma = (-shortGamma + longGamma) * 100
    const netTheta = (-shortTheta + longTheta) * 100  // $/day — positive for short spread
    const netVega  = (-shortVega  + longVega)  * 100
    const netVanna = (-shortVanna + longVanna) * 100
    const netCharm = (-shortCharm + longCharm) * 100

    const spreadWidth = Math.abs(row.short_strike - row.long_strike)
    const maxRisk     = (spreadWidth - row.credit_received) * 100
    const breakeven   = optionType === 'put'
      ? row.short_strike - row.credit_received
      : row.short_strike + row.credit_received

    totalDelta += netDelta
    totalGamma += netGamma
    totalTheta += netTheta
    totalVega  += netVega

    // VaR scenarios — reprice at p10/p25/p75/p90 (or ±2%/±4% if dist unavailable)
    const s2Down = dist?.p10 ?? spy * 0.96
    const s1Down = dist?.p25 ?? spy * 0.98
    const s1Up   = dist?.p75 ?? spy * 1.02
    const s2Up   = dist?.p90 ?? spy * 1.04

    pnl2Down += repriceSpread(s2Down, row.short_strike, row.long_strike, dteYears, shortIV, longIV, row.credit_received, optionType)
    pnl1Down += repriceSpread(s1Down, row.short_strike, row.long_strike, dteYears, shortIV, longIV, row.credit_received, optionType)
    pnl1Up   += repriceSpread(s1Up,   row.short_strike, row.long_strike, dteYears, shortIV, longIV, row.credit_received, optionType)
    pnl2Up   += repriceSpread(s2Up,   row.short_strike, row.long_strike, dteYears, shortIV, longIV, row.credit_received, optionType)

    const strategyLabel = optionType === 'put'
      ? `Put Spread ${row.short_strike}/${row.long_strike}`
      : `Call Spread ${row.short_strike}/${row.long_strike}`

    positions.push({
      positionId: row.id,
      strategy: strategyLabel,
      netDelta: parseFloat(netDelta.toFixed(4)),
      netGamma: parseFloat(netGamma.toFixed(6)),
      netTheta: parseFloat(netTheta.toFixed(4)),
      netVega:  parseFloat(netVega.toFixed(4)),
      netVanna: parseFloat(netVanna.toFixed(6)),
      netCharm: parseFloat(netCharm.toFixed(6)),
      maxRisk:  parseFloat(maxRisk.toFixed(2)),
      breakeven: parseFloat(breakeven.toFixed(2)),
    })
  }

  return {
    totalDelta: parseFloat(totalDelta.toFixed(4)),
    totalGamma: parseFloat(totalGamma.toFixed(6)),
    totalTheta: parseFloat(totalTheta.toFixed(4)),
    totalVega:  parseFloat(totalVega.toFixed(4)),
    positions,
    varScenarios: {
      oneStdDown:  parseFloat((pnl1Down * 100).toFixed(2)),
      twoStdDown:  parseFloat((pnl2Down * 100).toFixed(2)),
      oneStdUp:    parseFloat((pnl1Up   * 100).toFixed(2)),
      twoStdUp:    parseFloat((pnl2Up   * 100).toFixed(2)),
    },
    spy,
    capturedAt: new Date().toISOString(),
  }
}

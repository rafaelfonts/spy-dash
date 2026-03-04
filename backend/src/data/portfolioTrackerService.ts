/**
 * Portfolio Tracker Service — Motor de Gestão de Ciclo de Vida.
 * Runs once per day (16:00 ET), fetches OPEN positions, enriches with DTE and profit %,
 * calls Claude Gestor de Risco, and sends alerts to Discord.
 */

import { createClient } from '@supabase/supabase-js'
import { getTradierClient } from '../lib/tradierClient'
import { redis } from '../lib/cacheStore'
import {
  buildPortfolioPayload,
  callGestorRisco,
} from './portfolioLifecycleAgent'
import type {
  EnrichedPosition,
  GestorRiscoAlert,
  PortfolioPositionRow,
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
 * Count business days (exclude Saturday/Sunday) between from and to in ET.
 * from and to are treated as ET calendar dates; to is exclusive for the count
 * so that "today to expiration" gives DTE as days until expiration.
 */
function diasUteisEntre(from: Date, to: Date): number {
  const fromTime = from.getTime()
  const toTime = to.getTime()
  if (toTime <= fromTime) return 0
  let count = 0
  const oneDay = 24 * 60 * 60 * 1000
  let d = new Date(fromTime)
  while (d.getTime() < toTime) {
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6) count++
    d = new Date(d.getTime() + oneDay)
  }
  return count
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
    const dteCurrent = diasUteisEntre(todayET, expDate)

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

    const strategy = `Put Spread ${row.short_strike}/${row.long_strike}`
    enriched.push({
      id: row.id,
      strategy,
      dte_current: dteCurrent,
      profit_percentage: Math.round(profitPct * 10) / 10,
      credit_received: creditReceived,
      current_cost_to_close: Math.round(currentDebit * 100) / 100,
    })
  }

  return enriched
}

// ---------------------------------------------------------------------------
// Discord alert (embeds with color)
// ---------------------------------------------------------------------------

const DISCORD_COLOR_50PCT = 65280   // green
const DISCORD_COLOR_21DTE = 16776960 // yellow

export async function sendPortfolioAlertToDiscord(
  alert: { recommendation: string; message: string },
  type: '50pct' | '21dte',
): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL
  if (!webhookUrl) return

  const title = type === '50pct' ? 'Alerta 50% Lucro' : 'Alerta 21 DTE'
  const color = type === '50pct' ? DISCORD_COLOR_50PCT : DISCORD_COLOR_21DTE

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{ title, color, description: alert.message }],
    }),
  })

  if (!res.ok) {
    throw new Error(`Discord webhook HTTP ${res.status}`)
  }
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
    console.log('[PortfolioTracker] No OPEN positions, skipping cycle')
    return
  }

  const enriched = await enrichPositions(rows)
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
    const rec = alert.recommendation
    if (rec === 'FECHAR_LUCRO') {
      sendPortfolioAlertToDiscord(alert, '50pct').catch((err) =>
        console.error('[Discord] Alerta portfolio 50%:', err),
      )
    } else if (rec === 'FECHAR_TEMPO' || rec === 'ROLAR') {
      sendPortfolioAlertToDiscord(alert, '21dte').catch((err) =>
        console.error('[Discord] Alerta portfolio 21 DTE:', err),
      )
    }
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

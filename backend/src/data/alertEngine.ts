import type { AnalysisStructuredOutput } from '../types/market'
import { broadcastToUser } from '../api/sse'
import { redis, cacheGet, cacheSet } from '../lib/cacheStore'
import { sendEmbed, DISCORD_COLORS } from '../lib/discordClient'
import { createClient } from '@supabase/supabase-js'

const PROXIMITY_WARN = 0.002   // 0.2% — nível próximo (approaching)
const PROXIMITY_TEST = 0.0005  // 0.05% — nível sendo testado (testing)
const DEBOUNCE_MS = 60_000     // 60s entre alertas do mesmo nível
const MAX_ALERTS_PER_USER = 10

// Discord #feed — lock Redis evita duplicação em multi-instância (Fly.io 2 máquinas)
const DISCORD_DEBOUNCE_MS_APPROACHING = 10 * 60 * 1000  // 10 min
const DISCORD_DEBOUNCE_MS_TESTING = 15 * 60 * 1000     // 15 min

async function maybeSendAlertToDiscord(alert: {
  level: number
  type: 'support' | 'resistance' | 'gex_flip'
  alertType: 'approaching' | 'testing'
  price: number
}): Promise<void> {
  const lockKey = `lock:discord_alert:${alert.level}:${alert.type}`
  const lockTTL = Math.ceil(
    (alert.alertType === 'testing' ? DISCORD_DEBOUNCE_MS_TESTING : DISCORD_DEBOUNCE_MS_APPROACHING) / 1000,
  )
  const acquired = await redis.set(lockKey, '1', 'EX', lockTTL, 'NX')
  if (!acquired) return

  const isTesting = alert.alertType === 'testing'
  const typeLabel = { support: 'Suporte', resistance: 'Resistência', gex_flip: 'GEX Flip' }
  const statusLabel = isTesting ? '🔴 SENDO TESTADO' : '🟡 APROXIMANDO'
  const color = isTesting ? DISCORD_COLORS.alertTesting : DISCORD_COLORS.alertApproaching
  const distancePct = (Math.abs(alert.price - alert.level) / alert.level * 100).toFixed(2)

  await sendEmbed('feed', {
    title: `${statusLabel} — ${typeLabel[alert.type]} $${alert.level}`,
    description: [
      `**SPY:** $${alert.price.toFixed(2)}`,
      `**Nível:** $${alert.level} (${typeLabel[alert.type]})`,
      `**Distância:** ${distancePct}%`,
    ].join('\n'),
    color,
    footer: { text: 'SPY Dash · Alert Engine' },
    timestamp: new Date().toISOString(),
  })
}

export interface ActiveAlert {
  userId: string
  level: number
  type: 'support' | 'resistance' | 'gex_flip'
  registeredAt: number
  lastFiredAt: number | null
}

const alertsByUser = new Map<string, ActiveAlert[]>()

export function registerAlertsFromAnalysis(
  userId: string,
  structured: AnalysisStructuredOutput,
): void {
  const levels: Omit<ActiveAlert, 'userId' | 'registeredAt' | 'lastFiredAt'>[] = []

  for (const s of structured.key_levels.support.slice(0, 3)) {
    levels.push({ level: s, type: 'support' })
  }
  for (const r of structured.key_levels.resistance.slice(0, 3)) {
    levels.push({ level: r, type: 'resistance' })
  }
  if (structured.key_levels.gex_flip != null) {
    levels.push({ level: structured.key_levels.gex_flip, type: 'gex_flip' })
  }

  const now = Date.now()
  const alerts: ActiveAlert[] = levels.slice(0, MAX_ALERTS_PER_USER).map((l) => ({
    ...l,
    userId,
    registeredAt: now,
    lastFiredAt: null,
  }))

  // New analysis replaces all previous alerts for this user
  alertsByUser.set(userId, alerts)
}

export function checkAlerts(price: number): void {
  if (!isMarketHours()) return

  const now = Date.now()
  for (const [userId, alerts] of alertsByUser.entries()) {
    for (const alert of alerts) {
      if (alert.lastFiredAt !== null && now - alert.lastFiredAt < DEBOUNCE_MS) continue

      const priceDiff = Math.abs(price - alert.level) / alert.level

      let alertType: 'approaching' | 'testing' | null = null
      if (priceDiff <= PROXIMITY_TEST) {
        alertType = 'testing'
      } else if (priceDiff <= PROXIMITY_WARN) {
        alertType = 'approaching'
      }

      if (alertType) {
        alert.lastFiredAt = now
        broadcastToUser(userId, 'alert', {
          level: alert.level,
          type: alert.type,
          alertType,
          price,
          timestamp: now,
        })
        maybeSendAlertToDiscord({
          level: alert.level,
          type: alert.type,
          alertType,
          price,
        }).catch(() => {})
      }
    }
  }
}

function isMarketHours(): boolean {
  const now = new Date()
  const utcH = now.getUTCHours()
  const utcM = now.getUTCMinutes()
  const day = now.getUTCDay()
  if (day === 0 || day === 6) return false  // weekend
  const minutes = utcH * 60 + utcM
  return minutes >= 13 * 60 + 30 && minutes < 20 * 60  // NYSE 09:30–16:00 ET
}

// ── Equity Watchlist Alerts ──────────────────────────────────────────────────

const EQUITY_ALERT_DEBOUNCE_MS = 5 * 60 * 1000 // 300s
const equityAlertDebounce = new Map<string, number>() // `userId:symbol` → lastFiredAt

interface WatchlistRow {
  user_id: string
  symbol: string
  alert_price: number | null
  alert_direction: 'above' | 'below' | null
}

async function getWatchlistEntries(): Promise<WatchlistRow[]> {
  const cached = await cacheGet<WatchlistRow[]>('equity:watchlist:all')
  if (cached) return cached

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
  const { data } = await supabase
    .from('equity_watchlist')
    .select('user_id, symbol, alert_price, alert_direction')
    .not('alert_price', 'is', null)

  const entries = (data ?? []) as WatchlistRow[]
  // Cache por 60s — invalidado por POST/DELETE na watchlist
  await cacheSet('equity:watchlist:all', entries, 60_000, 'alertEngine')
  return entries
}

export async function checkEquityAlerts(
  candidates: Array<{ symbol: string; price: number }>,
): Promise<void> {
  if (candidates.length === 0) return

  let entries: WatchlistRow[]
  try {
    entries = await getWatchlistEntries()
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.alert_price || !entry.alert_direction) continue

    const candidate = candidates.find((c) => c.symbol === entry.symbol)
    if (!candidate) continue

    const triggered =
      (entry.alert_direction === 'above' && candidate.price >= entry.alert_price) ||
      (entry.alert_direction === 'below' && candidate.price <= entry.alert_price)

    if (!triggered) continue

    const key = `${entry.user_id}:${entry.symbol}`
    const lastFired = equityAlertDebounce.get(key) ?? 0
    if (Date.now() - lastFired < EQUITY_ALERT_DEBOUNCE_MS) continue

    equityAlertDebounce.set(key, Date.now())

    const direction = entry.alert_direction === 'above' ? '↑' : '↓'
    broadcastToUser(entry.user_id, 'equity-alert', {
      symbol: entry.symbol,
      price: candidate.price,
      alert_price: entry.alert_price,
      direction: entry.alert_direction,
    })

    // Phase 4 will add webhookAcoes to CONFIG.discord; until then fallback to feed
    sendEmbed('acoes', {
      title: `🔔 Alerta: ${entry.symbol} ${direction} $${entry.alert_price}`,
      description: `Preço atual: **$${candidate.price.toFixed(2)}**\nNível configurado: $${entry.alert_price} ${direction}`,
      color: 0xFFAA00,
      timestamp: new Date().toISOString(),
    }).catch(() => {})
  }
}

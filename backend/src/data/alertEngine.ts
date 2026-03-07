import type { AnalysisStructuredOutput } from '../types/market'
import { broadcastToUser } from '../api/sse'
import { redis } from '../lib/cacheStore'
import { sendEmbed, DISCORD_COLORS } from '../lib/discordClient'

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

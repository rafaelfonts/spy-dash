/**
 * Scheduled Trade Signal — runs the same IA analysis at fixed times (10:30 ET, 15:00 ET).
 * One global run per slot; result cached in Redis and broadcast via SSE to all clients.
 */

import { emitter } from './marketState'
import { cacheGet, cacheSet, redis } from '../lib/cacheStore'
import { sendEmbed, DISCORD_COLORS } from '../lib/discordClient'
import { runAnalysisForPayload } from '../api/openai'
import type { AnalysisStructuredOutput } from '../types/market'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRADE_SIGNAL_CACHE_KEY = 'cache:trade_signal:latest'
const TRADE_SIGNAL_TTL_MS = 14 * 60 * 60 * 1000  // 14h
const LOCK_TTL_S = 300

/** (hour, minute) in ET for scheduled runs */
const SCHEDULED_SLOTS: Array<{ h: number; m: number; label: string }> = [
  { h: 10, m: 30, label: '10:30' },
  { h: 15, m: 0, label: '15:00' },
]

// ---------------------------------------------------------------------------
// ET time helpers (same logic as preMarketBriefing)
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

// ---------------------------------------------------------------------------
// Payload type for SSE and Redis
// ---------------------------------------------------------------------------

export interface TradeSignalPayload {
  trade_signal: 'trade' | 'wait' | 'avoid'
  regime_score: number
  no_trade_reasons: string[]
  bias: AnalysisStructuredOutput['bias']
  key_levels: AnalysisStructuredOutput['key_levels']
  timestamp: number
  summary?: string
}

function structuredToPayload(structured: AnalysisStructuredOutput): TradeSignalPayload {
  return {
    trade_signal: structured.trade_signal,
    regime_score: structured.regime_score,
    no_trade_reasons: structured.no_trade_reasons ?? [],
    bias: structured.bias,
    key_levels: structured.key_levels,
    timestamp: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Discord — envio para #sinais (fire-and-forget)
// ---------------------------------------------------------------------------

async function sendSignalToDiscord(
  result: TradeSignalPayload,
  slot: '10:30' | '15:00',
): Promise<void> {
  const colorMap = {
    trade: DISCORD_COLORS.signalProceed,
    wait: DISCORD_COLORS.signalWait,
    avoid: DISCORD_COLORS.signalAvoid,
  }
  const iconMap = { trade: '🟢', wait: '🟡', avoid: '🔴' }
  const labelMap = { trade: 'OPERAR', wait: 'AGUARDAR', avoid: 'NÃO OPERAR' }

  const signal = result.trade_signal ?? 'wait'
  const color = colorMap[signal] ?? DISCORD_COLORS.signalWait
  const icon = iconMap[signal] ?? '🟡'
  const label = labelMap[signal] ?? signal.toUpperCase()

  const lines: string[] = [
    `**Decisão:** ${icon} ${label}`,
    `**Regime Score:** ${result.regime_score ?? 'N/A'}/10`,
    `**Bias:** ${result.bias ?? 'N/A'}`,
  ]

  if (result.no_trade_reasons?.length) {
    lines.push(`**Razões de veto:** ${result.no_trade_reasons.join(' · ')}`)
  }

  if (result.key_levels) {
    const kl = result.key_levels
    const kvParts = [
      kl.support?.length ? `Suporte $${kl.support.join(', ')}` : null,
      kl.resistance?.length ? `Resist. $${kl.resistance.join(', ')}` : null,
      kl.gex_flip != null ? `GEX Flip $${kl.gex_flip}` : null,
    ].filter(Boolean).join(' · ')
    if (kvParts) lines.push(`**Níveis:** ${kvParts}`)
  }

  await sendEmbed('sinais', {
    title: `🎯 Sinal ${slot} ET — ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/New_York' })}`,
    description: lines.join('\n'),
    color,
    footer: { text: 'SPY Dash · Sinal Agendado' },
    timestamp: new Date().toISOString(),
  })
}

// ---------------------------------------------------------------------------
// Core: run one scheduled analysis and broadcast
// ---------------------------------------------------------------------------

export async function runScheduledSignalAnalysis(slotLabel: string): Promise<void> {
  const today = getTodayDateET()
  const lockKey = `lock:scheduled_signal:${today}:${slotLabel}`

  const acquired = await redis.set(lockKey, '1', 'EX', LOCK_TTL_S, 'NX')
  if (!acquired) {
    console.log(`[ScheduledSignal] Lock ${slotLabel} não adquirido — outra instância está rodando`)
    return
  }

  console.log(`[ScheduledSignal] Iniciando análise agendada (${slotLabel} ET)...`)

  try {
    const { fullText, structured } = await runAnalysisForPayload({})

    if (!structured) {
      console.warn('[ScheduledSignal] Structured output vazio — não enviando sinal')
      return
    }

    const payload: TradeSignalPayload = structuredToPayload(structured)

    await cacheSet(TRADE_SIGNAL_CACHE_KEY, payload, TRADE_SIGNAL_TTL_MS, 'scheduled_signal')
    emitter.emit('trade_signal_update', payload)
    await sendSignalToDiscord(payload, slotLabel as '10:30' | '15:00')
    console.log(`[ScheduledSignal] ${slotLabel} ET concluído: trade_signal=${payload.trade_signal} regime_score=${payload.regime_score}`)
  } catch (err) {
    console.error('[ScheduledSignal] Erro na análise agendada:', (err as Error).message)
  } finally {
    await redis.del(lockKey).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Restore / read last signal from Redis (for SSE connection snapshot)
// ---------------------------------------------------------------------------

export async function getLastScheduledSignal(): Promise<TradeSignalPayload | null> {
  return cacheGet<TradeSignalPayload>(TRADE_SIGNAL_CACHE_KEY)
}

// ---------------------------------------------------------------------------
// Scheduler — every 60s check if it's 10:30 or 15:00 ET (weekdays)
// ---------------------------------------------------------------------------

export function startScheduledSignalScheduler(): void {
  setInterval(() => {
    const et = getETNow()
    const dow = et.getDay()
    if (dow === 0 || dow === 6) return

    const h = et.getHours()
    const m = et.getMinutes()

    for (const slot of SCHEDULED_SLOTS) {
      if (h === slot.h && m === slot.m) {
        runScheduledSignalAnalysis(slot.label).catch((err) =>
          console.error('[ScheduledSignal] Scheduler erro:', err),
        )
        break
      }
    }
  }, 60_000)

  console.log('[ScheduledSignal] Scheduler iniciado (10:30 e 15:00 ET, dias úteis)')
}

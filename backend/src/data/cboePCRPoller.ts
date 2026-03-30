/**
 * CBOE Put/Call Ratio — fetch diário após fechamento (16:35 ET).
 * Usa o endpoint JSON do CDN CBOE (não scraping HTML — a página é um SPA React).
 * Publica no #feed (Discord) e via SSE. Cache Redis 14h, restaurado no startup.
 */

import { emitter } from './marketState'
import { cacheGet, cacheSet, redis } from '../lib/cacheStore'
import { sendEmbed, DISCORD_COLORS } from '../lib/discordClient'

const CACHE_KEY = 'cboe_pcr_daily'
const CBOE_CDN_BASE = 'https://cdn.cboe.com/data/us/options/market_statistics/daily'
const TTL_MS = 14 * 60 * 60 * 1000  // 14h

export interface CBOEPCRData {
  totalPCR: number
  equityPCR: number
  indexPCR: number
  label: 'extreme_fear' | 'fear' | 'neutral' | 'greed' | 'extreme_greed'
  capturedAt: string
}

function parseEquityLabel(equityPCR: number): CBOEPCRData['label'] {
  if (equityPCR > 1.0) return 'extreme_fear'
  if (equityPCR > 0.8) return 'fear'
  if (equityPCR >= 0.6) return 'neutral'
  if (equityPCR >= 0.45) return 'greed'
  return 'extreme_greed'
}

/** Retorna YYYY-MM-DD de uma Date em timezone ET */
function toETDateString(date: Date): string {
  // en-CA usa formato ISO YYYY-MM-DD
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

/** Tenta buscar dados do CDN CBOE para uma data específica. Retorna null se 403/erro. */
async function fetchForDate(dateStr: string): Promise<CBOEPCRData | null> {
  const url = `${CBOE_CDN_BASE}/${dateStr}_daily_options`
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) return null

  const json = await res.json() as { ratios?: Array<{ name: string; value: string }> }
  const ratios = json.ratios ?? []

  const findRatio = (keyword: string): number =>
    parseFloat(ratios.find((r) => r.name.includes(keyword))?.value ?? '')

  const totalPCR  = findRatio('TOTAL PUT/CALL')
  const equityPCR = findRatio('EQUITY PUT/CALL')
  const indexPCR  = findRatio('INDEX PUT/CALL')

  if (isNaN(totalPCR) || isNaN(equityPCR) || isNaN(indexPCR)) return null

  return {
    totalPCR,
    equityPCR,
    indexPCR,
    label: parseEquityLabel(equityPCR),
    capturedAt: new Date().toISOString(),
  }
}

/** Busca o PCR do dia útil mais recente disponível (tenta até 5 dias para trás). */
export async function fetchCBOEPCR(): Promise<CBOEPCRData | null> {
  const today = new Date()
  for (let daysBack = 0; daysBack <= 5; daysBack++) {
    const d = new Date(today)
    d.setDate(d.getDate() - daysBack)
    const weekday = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' })
    if (weekday === 'Sat' || weekday === 'Sun') continue

    const dateStr = toETDateString(d)
    try {
      const result = await fetchForDate(dateStr)
      if (result) {
        console.log(`[CBOE PCR] Dados obtidos para ${dateStr}`)
        return result
      }
    } catch (err) {
      console.warn(`[CBOE PCR] Falha em ${dateStr}:`, (err as Error).message)
    }
  }
  console.warn('[CBOE PCR] Nenhum dado disponível nos últimos 5 dias úteis')
  return null
}

export async function publishCBOEPCR(data: CBOEPCRData): Promise<void> {
  await cacheSet(CACHE_KEY, data, TTL_MS, 'cboe_pcr')
  emitter.emit('cboe_pcr', data)

  const labelEmoji: Record<CBOEPCRData['label'], string> = {
    extreme_fear: '🔴 Medo Extremo — proteção sistêmica comprada',
    fear: '🟠 Medo — prêmio de put elevado',
    neutral: '🟡 Neutro',
    greed: '🟢 Ganância — prêmio de put baixo',
    extreme_greed: '🟢🟢 Ganância Extrema — complacência',
  }

  const description = [
    `**Total PCR:** ${data.totalPCR}`,
    `**Equity PCR:** ${data.equityPCR}  ← principal indicador`,
    `**Index PCR:** ${data.indexPCR}`,
    ``,
    `**Sentimento:** ${labelEmoji[data.label]}`,
    ``,
    `> Equity PCR > 0.8 = medo → favorável para Put Spread (prêmio alto)`,
    `> Equity PCR < 0.5 = complacência → cautela com sizing`,
  ].join('\n')

  await sendEmbed('feed', {
    title: `📊 CBOE Put/Call Ratio — ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/New_York' })}`,
    description,
    color: DISCORD_COLORS.cboePCR,
    footer: { text: 'Fonte: CBOE · Publicado após fechamento do mercado' },
    timestamp: new Date().toISOString(),
  })
}

export async function getLastCBOEPCR(): Promise<CBOEPCRData | null> {
  return cacheGet<CBOEPCRData>(CACHE_KEY)
}

const SCHEDULED_HHMM = '16:35'
const CHECK_INTERVAL_MS = 60_000
const LOCK_TTL = 14 * 60 * 60  // 14h em segundos

export function startCBOEPCRScheduler(): void {
  setInterval(async () => {
    const now = new Date()
    const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const day = etTime.getDay()
    if (day === 0 || day === 6) return

    const hhmm = `${etTime.getHours()}:${String(etTime.getMinutes()).padStart(2, '0')}`

    if (hhmm === SCHEDULED_HHMM) {
      const dateET = `${etTime.getFullYear()}-${String(etTime.getMonth() + 1).padStart(2, '0')}-${String(etTime.getDate()).padStart(2, '0')}`
      const lockKey = `lock:cboe_pcr:${dateET}`
      const acquired = await redis.set(lockKey, '1', 'EX', LOCK_TTL, 'NX')
      if (!acquired) {
        console.log(`[CBOE PCR] Lock já adquirido para ${dateET} — fetch ignorado`)
        return
      }

      const data = await fetchCBOEPCR()
      if (data) await publishCBOEPCR(data)
    }
  }, CHECK_INTERVAL_MS)

  // Poll inicial 30s após startup — popula cache quando TTL expirou mas dado já está disponível
  setTimeout(() => {
    fetchCBOEPCR()
      .then((data) => { if (data) publishCBOEPCR(data) })
      .catch((err) => console.warn('[CBOE PCR] Poll inicial:', (err as Error).message))
  }, 30_000)

  console.log('[CBOE PCR] Scheduler iniciado — disparo 16:35 ET em dias úteis')
}

/**
 * CBOE Put/Call Ratio — scrape diário após fechamento (16:35 ET).
 * Publica no #feed (Discord) e via SSE. Cache Redis 14h, restaurado no startup.
 */

import { emitter } from './marketState'
import { cacheGet, cacheSet } from '../lib/cacheStore'
import { sendEmbed, DISCORD_COLORS } from '../lib/discordClient'

const CACHE_KEY = 'cboe_pcr_daily'
const CBOE_URL = 'https://www.cboe.com/us/options/market_statistics/daily/'
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

export async function fetchCBOEPCR(): Promise<CBOEPCRData | null> {
  try {
    const res = await fetch(CBOE_URL, { signal: AbortSignal.timeout(10000) })
    const html = await res.text()

    const rows = html.match(/P\/C Ratio[\s\S]*?(\d+\.\d+)[\s\S]*?(\d+\.\d+)[\s\S]*?(\d+\.\d+)/)
    if (rows) {
      const totalPCR = parseFloat(rows[1])
      const equityPCR = parseFloat(rows[2])
      const indexPCR = parseFloat(rows[3])
      return {
        totalPCR,
        equityPCR,
        indexPCR,
        label: parseEquityLabel(equityPCR),
        capturedAt: new Date().toISOString(),
      }
    }

    const allRatios = [...html.matchAll(/>\s*(\d\.\d{2})\s*</g)].map((m) => parseFloat(m[1]))
    if (allRatios.length < 3) return null
    const [totalPCR, equityPCR, indexPCR] = allRatios
    return {
      totalPCR,
      equityPCR,
      indexPCR,
      label: parseEquityLabel(equityPCR),
      capturedAt: new Date().toISOString(),
    }
  } catch (err) {
    console.warn('[CBOE PCR] Falha no fetch:', (err as Error).message)
    return null
  }
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
const firedToday = new Set<string>()

export function startCBOEPCRScheduler(): void {
  setInterval(async () => {
    const now = new Date()
    const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const day = etTime.getDay()
    if (day === 0 || day === 6) return

    const hhmm = `${etTime.getHours()}:${String(etTime.getMinutes()).padStart(2, '0')}`
    const key = `cboe_pcr:${etTime.toDateString()}`

    if (hhmm === SCHEDULED_HHMM && !firedToday.has(key)) {
      firedToday.add(key)
      const data = await fetchCBOEPCR()
      if (data) await publishCBOEPCR(data)
    }

    if (hhmm === '0:01') firedToday.clear()
  }, CHECK_INTERVAL_MS)

  console.log('[CBOE PCR] Scheduler iniciado — disparo 16:35 ET em dias úteis')
}

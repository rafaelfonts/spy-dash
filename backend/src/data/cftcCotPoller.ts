import { CONFIG } from '../config'
import { cacheGet, cacheSet } from '../lib/cacheStore'
import { createBreaker } from '../lib/circuitBreaker'
import type { CftcCotSnapshot, CftcCotRecord } from '../types/market'
import { publishCftcCot } from './cftcCotState'

const CACHE_KEY = 'cftc_cot_snapshot'
const TTL_7D_MS = 7 * 24 * 60 * 60 * 1000

// Poll semanal — sexta-feira, 10:05 ET (aprox. após publicação oficial).
const CHECK_INTERVAL_MS = 60 * 1000

// Base genérica da Public Reporting Environment. O caminho e parâmetros exatos
// podem ser ajustados conforme a documentação oficial do CFTC.
const CFTC_PRE_BASE =
  CONFIG.CFTC_PRE_BASE_URL ?? 'https://publicreporting.cftc.gov/odata/COT';

interface RawCftcRow {
  report_date: string
  market_and_exchange_names?: string
  trader_category?: string
  net_pos_all?: number | null
}

const fetchBreaker = createBreaker(
  async (url: string) => {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SPYDash/1.0' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json() as Promise<any>
  },
  'cftc',
  { resetTimeout: 60 * 60 * 1000 },
)

async function fetchLatestCot(): Promise<CftcCotSnapshot | null> {
  // Endpoint genérico: delegamos ao usuário ajustar query exata se necessário.
  // Exemplo: filtrar por mercados que contenham "S&P" ou "VIX" e pegar a semana mais recente.
  const url = `${CFTC_PRE_BASE}`
  const raw = (await fetchBreaker.fire(url)) as any | null
  if (!raw) return null

  const rows: RawCftcRow[] = Array.isArray(raw.value ?? raw.rows ?? raw)
    ? (raw.value ?? raw.rows ?? raw)
    : []

  if (rows.length === 0) {
    console.warn('[CftcCotPoller] Nenhum registro retornado do CFTC PRE')
    return null
  }

  // Ordena por data desc e pega a semana mais recente.
  rows.sort((a, b) => (a.report_date > b.report_date ? -1 : a.report_date < b.report_date ? 1 : 0))
  const weekOf = rows[0].report_date

  const relevant = rows.filter((r) => {
    const name = (r.market_and_exchange_names ?? '').toUpperCase()
    return name.includes('S&P') || name.includes('VIX')
  })

  const records: CftcCotRecord[] = relevant.map((r) => ({
    asOfDate: r.report_date,
    marketName: r.market_and_exchange_names ?? 'Unknown',
    traderCategory: r.trader_category ?? 'Unknown',
    netContracts: typeof r.net_pos_all === 'number' ? r.net_pos_all : null,
    netPercentile: null,
  }))

  if (records.length === 0) {
    console.warn('[CftcCotPoller] Nenhum mercado S&P/VIX encontrado nos dados COT')
  }

  return {
    fetchedAt: new Date().toISOString(),
    weekOf,
    records,
  }
}

async function pollOnce(): Promise<void> {
  const cached = await cacheGet<CftcCotSnapshot>(CACHE_KEY)
  if (cached) {
    publishCftcCot(cached)
    return
  }

  try {
    const snap = await fetchLatestCot()
    if (!snap) return
    await cacheSet(CACHE_KEY, snap, TTL_7D_MS, 'cftc')
    publishCftcCot(snap)
    console.log(
      `[CftcCotPoller] Atualizado COT semana ${snap.weekOf} — ${snap.records.length} registros relevantes`,
    )
  } catch (err) {
    console.warn('[CftcCotPoller] Erro ao buscar COT:', (err as Error).message)
  }
}

export function startCftcCotPoller(): void {
  console.log('[CftcCotPoller] Iniciando scheduler semanal (sexta, 10:05 ET aprox.)')

  // Primeira tentativa imediata para já ter dados em novos deploys.
  pollOnce().catch(() => {})

  setInterval(() => {
    const nowEt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const day = nowEt.getDay() // 0=Dom, 5=Sex
    const hour = nowEt.getHours()
    const minute = nowEt.getMinutes()

    if (day === 5 && hour === 10 && minute >= 5 && minute < 15) {
      pollOnce().catch(() => {})
    }
  }, CHECK_INTERVAL_MS)
}


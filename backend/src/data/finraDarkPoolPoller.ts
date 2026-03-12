import { CONFIG } from '../config'
import { cacheGet, cacheSet } from '../lib/cacheStore'
import type { FinraDarkPoolSnapshot } from '../types/market'
import { publishFinraDarkPool } from './finraDarkPoolState'

const CACHE_KEY = 'finra_darkpool_spy'
const TTL_14D_MS = 14 * 24 * 60 * 60 * 1000

// Checagem a cada 60s; dispara fetch efetivo 1x/semana (segunda, 08:00–08:10 ET).
const CHECK_INTERVAL_MS = 60 * 1000

// Endpoint genérico de exemplo — deve ser ajustado conforme o contrato oficial da FINRA.
// A lógica interna é defensiva para não quebrar caso o formato varie.
const FINRA_BASE =
  process.env.FINRA_BASE_URL ??
  'https://api.finra.org/data/otctransparency/otcEquity'; // placeholder seguro

interface FinraRow {
  weekStartDate?: string
  issueSymbol?: string
  totalWeeklyShareQuantity?: number
  atsIssueWeeklyShareQuantity?: number
  mpid?: string
}

async function fetchLatestFinraDarkPool(): Promise<FinraDarkPoolSnapshot | null> {
  if (!CONFIG.FINRA_API_KEY) {
    console.warn('[FinraDarkPoolPoller] FINRA_API_KEY não configurada — pulando poller')
    return null
  }

  const url = new URL(FINRA_BASE)
  // Parâmetros aproximados: filtrar SPY e pegar dados mais recentes.
  url.searchParams.set('limit', '5000')
  url.searchParams.set('sort', '-weekStartDate')
  url.searchParams.set('issueSymbol', 'SPY')

  const res = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'SPYDash/1.0',
      Authorization: `Bearer ${CONFIG.FINRA_API_KEY}`,
      Accept: 'application/json',
    },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`FINRA HTTP ${res.status}: ${text.slice(0, 160)}`)
  }

  const json: any = await res.json()
  const rows: FinraRow[] = Array.isArray(json.data ?? json) ? (json.data ?? json) : []
  if (rows.length === 0) {
    console.warn('[FinraDarkPoolPoller] Nenhuma linha retornada para SPY')
    return null
  }

  // Considera apenas a semana mais recente.
  const latestWeek = rows[0].weekStartDate ?? null
  if (!latestWeek) {
    console.warn('[FinraDarkPoolPoller] weekStartDate ausente — não é possível determinar semana')
    return null
  }

  const weekRows = rows.filter((r) => r.weekStartDate === latestWeek)

  let atsVolume = 0
  let totalVolume = 0
  const venues = new Set<string>()

  for (const r of weekRows) {
    const ats = r.atsIssueWeeklyShareQuantity ?? 0
    const tot = r.totalWeeklyShareQuantity ?? 0
    atsVolume += ats
    totalVolume += tot
    if (r.mpid) venues.add(r.mpid)
  }

  if (atsVolume === 0 && totalVolume === 0) {
    console.warn('[FinraDarkPoolPoller] Volume zero para SPY na semana mais recente')
  }

  const offExchangePct =
    totalVolume > 0 ? Number(((atsVolume / totalVolume) * 100).toFixed(2)) : null

  const snapshot: FinraDarkPoolSnapshot = {
    weekOf: latestWeek,
    totalVolume: atsVolume || null,
    offExchangePct,
    venueCount: venues.size || null,
    fetchedAt: new Date().toISOString(),
  }

  return snapshot
}

async function pollOnce(): Promise<void> {
  const cached = await cacheGet<FinraDarkPoolSnapshot>(CACHE_KEY)
  if (cached) {
    publishFinraDarkPool(cached)
    return
  }

  try {
    const snap = await fetchLatestFinraDarkPool()
    if (!snap) return
    await cacheSet(CACHE_KEY, snap, TTL_14D_MS, 'finra')
    publishFinraDarkPool(snap)
    console.log(
      `[FinraDarkPoolPoller] Semana ${snap.weekOf}: ATS=${snap.totalVolume?.toLocaleString(
        'en-US',
      ) ?? 'n/d'} | off-exchange=${snap.offExchangePct ?? 'n/d'}% | venues=${
        snap.venueCount ?? 'n/d'
      }`,
    )
  } catch (err) {
    console.warn('[FinraDarkPoolPoller] Erro ao buscar dados FINRA:', (err as Error).message)
  }
}

export function startFinraDarkPoolPoller(): void {
  console.log('[FinraDarkPoolPoller] Iniciando scheduler semanal (segunda, 08:00 ET aprox.)')

  // Execução imediata no boot para preencher snapshot se cache existir/for fresco.
  pollOnce().catch(() => {})

  setInterval(() => {
    const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const day = etNow.getDay() // 0=Dom, 1=Seg, ...
    const hour = etNow.getHours()
    const minute = etNow.getMinutes()

    if (day === 1 && hour === 8 && minute >= 0 && minute < 10) {
      pollOnce().catch(() => {})
    }
  }, CHECK_INTERVAL_MS)
}


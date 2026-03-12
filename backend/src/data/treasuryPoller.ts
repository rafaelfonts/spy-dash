import { CONFIG } from '../config'
import { cacheGet, cacheSet } from '../lib/cacheStore'
import type { TreasuryTgaSnapshot } from '../types/market'
import { publishTreasuryTga } from './treasuryState'

const CACHE_KEY = 'treasury_tga_snapshot'
const TTL_24H_MS = 24 * 60 * 60 * 1000

// Checagem a cada 60s; executa fetch real 1x/dia por volta de 08:00 ET.
const CHECK_INTERVAL_MS = 60 * 1000

const TREASURY_BASE =
  'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts/dts_table_1';

interface TreasuryRow {
  record_date: string
  operating_cash_balance?: string
  open_today_bal?: string
}

async function fetchLatestTga(): Promise<TreasuryTgaSnapshot | null> {
  // Dataset dts_table_1 contém Operating Cash Balance (TGA).
  // Pega o dia mais recente disponível.
  const url = new URL(TREASURY_BASE)
  url.searchParams.set('page[size]', '1')
  url.searchParams.set('sort', '-record_date')

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'SPYDash/1.0' },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Treasury DTS HTTP ${res.status}: ${text.slice(0, 120)}`)
  }

  const json: any = await res.json()
  const rows: TreasuryRow[] = Array.isArray(json.data) ? json.data : []
  if (rows.length === 0) {
    console.warn('[TreasuryPoller] Nenhuma linha em dts_table_1')
    return null
  }

  const row = rows[0]
  const asOfDate = row.record_date
  const opening = row.open_today_bal ? Number(row.open_today_bal) : null
  const closing = row.operating_cash_balance ? Number(row.operating_cash_balance) : null
  const delta =
    opening !== null && closing !== null
      ? closing - opening
      : null

  return {
    asOfDate,
    openingBalance: opening,
    closingBalance: closing,
    delta,
    fetchedAt: new Date().toISOString(),
  }
}

async function pollOnce(): Promise<void> {
  const cached = await cacheGet<TreasuryTgaSnapshot>(CACHE_KEY)
  if (cached) {
    publishTreasuryTga(cached)
    return
  }

  try {
    const snap = await fetchLatestTga()
    if (!snap) return
    await cacheSet(CACHE_KEY, snap, TTL_24H_MS, 'treasury')
    publishTreasuryTga(snap)
    console.log(
      `[TreasuryPoller] TGA ${snap.asOfDate}: close=${snap.closingBalance} delta=${snap.delta}`,
    )
  } catch (err) {
    console.warn('[TreasuryPoller] Erro ao buscar TGA:', (err as Error).message)
  }
}

export function startTreasuryPoller(): void {
  console.log('[TreasuryPoller] Iniciando scheduler diário (08:00 ET)')

  // Primeira leitura imediata em novos deploys.
  pollOnce().catch(() => {})

  setInterval(() => {
    const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const hour = etNow.getHours()
    const minute = etNow.getMinutes()

    if (hour === 8 && minute < 10) {
      pollOnce().catch(() => {})
    }
  }, CHECK_INTERVAL_MS)
}


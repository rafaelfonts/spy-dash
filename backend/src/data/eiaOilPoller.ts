import { CONFIG } from '../config'
import { cacheGet, cacheSet } from '../lib/cacheStore'
import { createBreaker } from '../lib/circuitBreaker'
import type { EiaOilSnapshot } from '../types/market'
import { publishEiaOil } from './eiaOilState'

const CACHE_KEY = 'eia_oil_snapshot'
const TTL_7D_MS = 7 * 24 * 60 * 60 * 1000

// EIA libera estoques semanalmente (normalmente quarta-feira 10:30 ET).
// Scheduler: checa a cada 60s e dispara fetch entre 10:30–10:40 ET às quartas.
const CHECK_INTERVAL_MS = 60 * 1000

const EIA_BASE = 'https://api.eia.gov/v2/petroleum/sti/data'

const fetchBreaker = createBreaker(
  async (urlStr: string): Promise<unknown> => {
    const res = await fetch(urlStr, {
      headers: { 'User-Agent': 'SPYDash/1.0' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json() as Promise<unknown>
  },
  'eia',
  { resetTimeout: 60 * 60 * 1000, volumeThreshold: 1 },
)

async function fetchLatestEia(): Promise<EiaOilSnapshot | null> {
  if (!CONFIG.EIA_API_KEY) {
    console.warn('[EiaOilPoller] EIA_API_KEY não configurada — pulando')
    return null
  }

  // Série genérica de estoques comerciais de crude nos EUA.
  // O código exato de série pode ser ajustado depois; aqui usamos parâmetros amplos.
  const url = new URL(EIA_BASE)
  url.searchParams.set('api_key', CONFIG.EIA_API_KEY)
  url.searchParams.set('frequency', 'weekly')
  url.searchParams.set('sort[0][column]', 'period')
  url.searchParams.set('sort[0][direction]', 'desc')
  url.searchParams.set('offset', '0')
  url.searchParams.set('length', '1')

  const rawData = (await fetchBreaker.fire(url.toString())) as any | null
  if (!rawData) return null

  const rows: any[] = Array.isArray(rawData.response?.data) ? rawData.response.data : []
  if (rows.length === 0) {
    console.warn('[EiaOilPoller] Nenhuma linha em EIA petroleum/sti')
    return null
  }

  const row = rows[0]
  const asOfDate: string = row.period

  // Os campos exatos variam por série; aqui tratamos de forma defensiva.
  const crudeInventories =
    typeof row.value === 'number'
      ? row.value
      : typeof row.crude_inventory === 'number'
        ? row.crude_inventory
        : null

  const gasolineInventories =
    typeof row.gasoline_inventory === 'number' ? row.gasoline_inventory : null

  const crudeChange =
    typeof row.change === 'number'
      ? row.change
      : typeof row.crude_change === 'number'
        ? row.crude_change
        : null

  return {
    asOfDate,
    crudeInventories,
    gasolineInventories,
    crudeChange,
    fetchedAt: new Date().toISOString(),
  }
}

async function pollOnce(): Promise<void> {
  const cached = await cacheGet<EiaOilSnapshot>(CACHE_KEY)
  if (cached) {
    publishEiaOil(cached)
    return
  }

  try {
    const snap = await fetchLatestEia()
    if (!snap) return
    await cacheSet(CACHE_KEY, snap, TTL_7D_MS, 'eia')
    publishEiaOil(snap)
    console.log(
      `[EiaOilPoller] Estoques ${snap.asOfDate}: crude=${snap.crudeInventories} change=${snap.crudeChange}`,
    )
  } catch (err) {
    console.warn('[EiaOilPoller] Erro ao buscar EIA:', (err as Error).message)
  }
}

export function startEiaOilPoller(): void {
  console.log('[EiaOilPoller] Iniciando scheduler semanal (quarta, 10:30 ET aprox.)')

  // Primeira leitura imediata para novos deploys.
  pollOnce().catch(() => {})

  setInterval(() => {
    const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const day = etNow.getDay() // 0=Dom, 3=Qua
    const hour = etNow.getHours()
    const minute = etNow.getMinutes()

    if (day === 3 && hour === 10 && minute >= 30 && minute < 40) {
      pollOnce().catch(() => {})
    }
  }, CHECK_INTERVAL_MS)
}


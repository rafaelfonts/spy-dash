import { CONFIG } from '../config'
import { emitter, newsSnapshot } from './marketState'
import type { MacroDataItem, BlsApiResponse } from '../types/market'
import { BlsResponseSchema } from '../types/market'
import { createBreaker } from '../lib/circuitBreaker'
import { cacheGet, cacheSet } from '../lib/cacheStore'

const POLL_INTERVAL = 24 * 60 * 60 * 1000 // 24 hours
const CACHE_KEY = 'bls_macro'
const CACHE_TTL = 95_040_000 // POLL_INTERVAL * 1.1
const BLS_API_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data/'

interface BlsSeries {
  seriesId: string
  name: string
  unit: string
}

const SERIES: BlsSeries[] = [
  { seriesId: 'LNS14000000',   name: 'Unemployment Rate',    unit: '%'   },
  { seriesId: 'CES0000000001', name: 'Nonfarm Payrolls',      unit: 'K'   },
  { seriesId: 'CES0500000003', name: 'Avg Hourly Earnings',   unit: '$/h' },
  { seriesId: 'WPSFD4',        name: 'PPI Final Demand',      unit: 'idx' },
]

// Last successfully validated items — used as fallback when API fails or schema changes
let lastValidBlsItems: MacroDataItem[] | null = null

function parseValue(str: string): number | null {
  if (!str || str === '-') return null
  const n = parseFloat(str)
  return isFinite(n) ? n : null
}

function periodToDate(year: string, period: string): string {
  // period is 'M01'–'M12'; convert to 'YYYY-MM-01'
  const month = period.replace('M', '').padStart(2, '0')
  return `${year}-${month}-01`
}

const fetchBreaker = createBreaker(
  async (body: object) => {
    const res = await fetch(BLS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SPYDash/1.0',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json() as Promise<unknown>
  },
  'bls',
  { resetTimeout: 3_600_000 }, // BLS is stable; wait 1h before retrying
)

async function pollBls(): Promise<void> {
  if (!CONFIG.BLS_API_KEY) {
    console.warn('[BlsPoller] BLS_API_KEY not set — skipping BLS poll')
    return
  }

  const cached = await cacheGet<{ items: MacroDataItem[]; ts: number }>(CACHE_KEY)
  if (cached) {
    newsSnapshot.bls = cached.items
    newsSnapshot.blsTs = cached.ts
    emitter.emit('newsfeed', { type: 'bls', items: cached.items, ts: cached.ts })
    return
  }

  const now = new Date()
  const body = {
    seriesid: SERIES.map((s) => s.seriesId),
    startyear: (now.getFullYear() - 1).toString(),
    endyear: now.getFullYear().toString(),
    registrationkey: CONFIG.BLS_API_KEY,
  }

  const raw = (await fetchBreaker.fire(body)) as BlsApiResponse | null

  if (!raw) {
    // CB fallback: circuit is OPEN or fetch failed
    if (lastValidBlsItems !== null) {
      newsSnapshot.bls = lastValidBlsItems
      emitter.emit('newsfeed', {
        type: 'bls',
        items: lastValidBlsItems,
        ts: Date.now(),
        _stale: true,
      })
      console.warn('[BlsPoller] Usando dados em cache (último válido)')
    }
    return
  }

  const parsed = BlsResponseSchema.safeParse(raw)
  if (!parsed.success) {
    console.error('[BlsPoller] Schema inválido:', parsed.error.format())
    console.error('[BlsPoller] Payload recebido:', JSON.stringify(raw).slice(0, 500))
    if (lastValidBlsItems !== null) {
      newsSnapshot.bls = lastValidBlsItems
      emitter.emit('newsfeed', {
        type: 'bls',
        items: lastValidBlsItems,
        ts: Date.now(),
        _stale: true,
      })
    }
    return
  }

  const json = parsed.data
  if (json.status !== 'REQUEST_SUCCEEDED') {
    const msgs = json.message?.join(', ') ?? 'Unknown BLS error'
    console.error(`[BlsPoller] API error: ${msgs}`)

    if (lastValidBlsItems !== null) {
      newsSnapshot.bls = lastValidBlsItems
      emitter.emit('newsfeed', {
        type: 'bls',
        items: lastValidBlsItems,
        ts: Date.now(),
        _stale: true,
      })
      console.warn('[BlsPoller] Usando dados em cache (último válido)')
    }
    return
  }

  const seriesResults = json.Results?.series ?? []
  const items: MacroDataItem[] = []

  for (const meta of SERIES) {
    const result = seriesResults.find((s) => s.seriesID === meta.seriesId)

    if (!result || result.data.length === 0) {
      items.push({
        seriesId: meta.seriesId,
        name: meta.name,
        value: null,
        previousValue: null,
        date: '',
        unit: meta.unit,
      })
      continue
    }

    // BLS returns data sorted newest first
    const latest = result.data[0]
    const previous = result.data[1]

    items.push({
      seriesId: meta.seriesId,
      name: meta.name,
      value: parseValue(latest.value),
      previousValue: previous ? parseValue(previous.value) : null,
      date: periodToDate(latest.year, latest.period),
      unit: meta.unit,
    })
  }

  lastValidBlsItems = items
  newsSnapshot.bls = items
  newsSnapshot.blsTs = Date.now()
  await cacheSet(CACHE_KEY, { items, ts: newsSnapshot.blsTs }, CACHE_TTL, 'bls')
  emitter.emit('newsfeed', { type: 'bls', items, ts: newsSnapshot.blsTs })
  console.log(`[BlsPoller] Updated: ${items.filter((i) => i.value !== null).length}/${items.length} series`)
}

export function startBlsPoller(): void {
  pollBls().catch(console.error)
  setInterval(() => pollBls().catch(console.error), POLL_INTERVAL)
}

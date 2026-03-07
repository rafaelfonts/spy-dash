import { CONFIG } from '../config'
import { emitter, newsSnapshot } from './marketState'
import type { MacroDataItem } from '../types/market'
import { FredResponseSchema } from '../types/market'
import { createBreaker } from '../lib/circuitBreaker'
import { cacheGet, cacheSet } from '../lib/cacheStore'

const POLL_INTERVAL = 24 * 60 * 60 * 1000 // 24 hours
const CACHE_KEY = 'fred_macro'
const CACHE_TTL = 95_040_000 // POLL_INTERVAL * 1.1
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations'

interface FredSeries {
  seriesId: string
  name: string
  unit: string
}

const SERIES: FredSeries[] = [
  { seriesId: 'CPIAUCSL',  name: 'CPI (All Items)',     unit: '% YoY' },
  { seriesId: 'CPILFESL',  name: 'Core CPI',            unit: '% YoY' },
  { seriesId: 'PCEPI',     name: 'PCE Deflator',         unit: '% YoY' },
  { seriesId: 'DFF',       name: 'Fed Funds Rate',       unit: '%'     },
  { seriesId: 'T10Y2Y',    name: 'Yield Curve (10Y-2Y)', unit: '%'     },
  { seriesId: 'T5Y2Y',     name: 'Yield Spread 5Y-2Y',   unit: '%'     },  // melhor preditor de recessão em 12 meses
  { seriesId: 'DGS3MO',    name: 'Treasury Yield 3M',    unit: '%'     },  // taxa base de curto prazo
]

// Last successfully fetched+validated full items array — used as fallback on total poll failure
let lastValidFredItems: MacroDataItem[] | null = null

function parseValue(str: string): number | null {
  if (!str || str === '.') return null
  const n = parseFloat(str)
  return isFinite(n) ? n : null
}

async function fetchSeries(series: FredSeries): Promise<MacroDataItem> {
  const url = new URL(FRED_BASE)
  url.searchParams.set('series_id', series.seriesId)
  url.searchParams.set('api_key', CONFIG.FRED_API_KEY)
  url.searchParams.set('file_type', 'json')
  url.searchParams.set('sort_order', 'desc')
  url.searchParams.set('limit', '2')

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'SPYDash/1.0' },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`FRED ${series.seriesId} HTTP ${res.status}: ${text.slice(0, 100)}`)
  }

  const json: unknown = await res.json()

  // Validate the series response with Zod for early detection of API format changes
  const parsed = FredResponseSchema.safeParse(json)
  if (!parsed.success) {
    console.error(`[FredPoller] ${series.seriesId} schema inválido:`, parsed.error.format())
    console.error(`[FredPoller] ${series.seriesId} payload:`, JSON.stringify(json).slice(0, 300))
    // Return null-valued item; poller continues with remaining series
    return {
      seriesId: series.seriesId,
      name: series.name,
      value: null,
      previousValue: null,
      date: '',
      unit: series.unit,
    }
  }

  // obs[0] = most recent (desc order), obs[1] = previous
  const obs = parsed.data.observations
  const latest = obs[0]
  const previous = obs[1]

  return {
    seriesId: series.seriesId,
    name: series.name,
    value: latest ? parseValue(latest.value) : null,
    previousValue: previous ? parseValue(previous.value) : null,
    date: latest?.date ?? '',
    unit: series.unit,
  }
}

// CB wraps individual series fetches — 5 per cycle gives fast signal within a single poll
const fredBreaker = createBreaker(fetchSeries, 'fred', {
  resetTimeout: 3_600_000, // FRED is stable; wait 1h before retrying
})

async function pollFred(): Promise<void> {
  if (!CONFIG.FRED_API_KEY) {
    console.warn('[FredPoller] FRED_API_KEY not set — skipping macro data poll')
    return
  }

  const cached = await cacheGet<{ items: MacroDataItem[]; ts: number }>(CACHE_KEY)
  if (cached) {
    newsSnapshot.macro = cached.items
    newsSnapshot.macroTs = cached.ts
    emitter.emit('newsfeed', { type: 'macro', items: cached.items, ts: cached.ts })
    return
  }

  try {
    // With CB fallback=null, allSettled always gets fulfilled results (null or MacroDataItem)
    const results = await Promise.allSettled(SERIES.map((s) => fredBreaker.fire(s)))

    const items: MacroDataItem[] = []
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'fulfilled') {
        if (result.value === null) {
          // CB fallback: circuit is OPEN or fetch failed for this series
          items.push({
            seriesId: SERIES[i].seriesId,
            name: SERIES[i].name,
            value: null,
            previousValue: null,
            date: '',
            unit: SERIES[i].unit,
          })
        } else {
          items.push(result.value as MacroDataItem)
        }
      } else {
        console.error(`[FredPoller] ${SERIES[i].seriesId} error:`, result.reason)
        items.push({
          seriesId: SERIES[i].seriesId,
          name: SERIES[i].name,
          value: null,
          previousValue: null,
          date: '',
          unit: SERIES[i].unit,
        })
      }
    }

    lastValidFredItems = items
    newsSnapshot.macro = items
    newsSnapshot.macroTs = Date.now()
    await cacheSet(CACHE_KEY, { items, ts: newsSnapshot.macroTs }, CACHE_TTL, 'fred')
    emitter.emit('newsfeed', { type: 'macro', items, ts: newsSnapshot.macroTs })
    console.log(`[FredPoller] Updated: ${items.filter((i) => i.value !== null).length}/${items.length} series`)
  } catch (err) {
    // Catastrophic failure (e.g. network down) — fall back to last valid data
    console.error('[FredPoller] Error:', (err as Error).message)

    if (lastValidFredItems !== null) {
      newsSnapshot.macro = lastValidFredItems
      emitter.emit('newsfeed', {
        type: 'macro',
        items: lastValidFredItems,
        ts: Date.now(),
        _stale: true,
      })
      console.warn('[FredPoller] Usando dados em cache (último válido)')
    }
  }
}

export function startFredPoller(): void {
  pollFred().catch(console.error)
  setInterval(() => pollFred().catch(console.error), POLL_INTERVAL)
}

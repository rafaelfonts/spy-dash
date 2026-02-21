import { CONFIG } from '../config'
import { emitter, newsSnapshot } from './marketState'
import type { MacroDataItem } from '../types/market'

const POLL_INTERVAL = 24 * 60 * 60 * 1000 // 24 hours
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
]

interface FredObservation {
  date: string
  value: string
}

interface FredResponse {
  observations: FredObservation[]
}

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

  const json = (await res.json()) as FredResponse
  const obs = json.observations ?? []

  // obs[0] = most recent (desc order), obs[1] = previous
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

async function pollFred(): Promise<void> {
  if (!CONFIG.FRED_API_KEY) {
    console.warn('[FredPoller] FRED_API_KEY not set — skipping macro data poll')
    return
  }
  try {
    const results = await Promise.allSettled(SERIES.map(fetchSeries))

    const items: MacroDataItem[] = []
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'fulfilled') {
        items.push(result.value)
      } else {
        console.error(`[FredPoller] ${SERIES[i].seriesId} error:`, result.reason)
        // Push a placeholder so the UI knows the series exists but has no data
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

    newsSnapshot.macro = items

    emitter.emit('newsfeed', { type: 'macro', items, ts: Date.now() })
    console.log(`[FredPoller] Updated: ${items.filter((i) => i.value !== null).length}/${items.length} series`)
  } catch (err) {
    console.error('[FredPoller] Error:', (err as Error).message)
  }
}

export function startFredPoller(): void {
  pollFred().catch(console.error)
  setInterval(() => pollFred().catch(console.error), POLL_INTERVAL)
}

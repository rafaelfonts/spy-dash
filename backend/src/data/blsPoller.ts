import { CONFIG } from '../config'
import { emitter, newsSnapshot } from './marketState'
import type { MacroDataItem } from '../types/market'

const POLL_INTERVAL = 24 * 60 * 60 * 1000 // 24 hours
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

interface BlsObservation {
  year: string
  period: string
  value: string
  footnotes: unknown[]
}

interface BlsSeriesResult {
  seriesID: string
  data: BlsObservation[]
}

interface BlsResponse {
  status: string
  Results?: {
    series: BlsSeriesResult[]
  }
  message?: string[]
}

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

async function pollBls(): Promise<void> {
  if (!CONFIG.BLS_API_KEY) {
    console.warn('[BlsPoller] BLS_API_KEY not set — skipping BLS poll')
    return
  }

  try {
    const now = new Date()
    const endYear = now.getFullYear().toString()
    const startYear = (now.getFullYear() - 1).toString()

    const body = {
      seriesid: SERIES.map((s) => s.seriesId),
      startyear: startYear,
      endyear: endYear,
      registrationkey: CONFIG.BLS_API_KEY,
    }

    const res = await fetch(BLS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SPYDash/1.0',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`BLS HTTP ${res.status}: ${text.slice(0, 200)}`)
    }

    const json = (await res.json()) as BlsResponse

    if (json.status !== 'REQUEST_SUCCEEDED') {
      const msgs = json.message?.join(', ') ?? 'Unknown BLS error'
      throw new Error(`BLS API: ${msgs}`)
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

    newsSnapshot.bls = items

    emitter.emit('newsfeed', { type: 'bls', items, ts: Date.now() })
    console.log(`[BlsPoller] Updated: ${items.filter((i) => i.value !== null).length}/${items.length} series`)
  } catch (err) {
    console.error('[BlsPoller] Error:', (err as Error).message)
  }
}

export function startBlsPoller(): void {
  pollBls().catch(console.error)
  setInterval(() => pollBls().catch(console.error), POLL_INTERVAL)
}

import { CONFIG } from '../config'
import { emitter, newsSnapshot } from './marketState'
import type { MacroEvent } from '../types/market'

const POLL_INTERVAL = 60 * 60 * 1000 // 1 hour

interface FinnhubEconomicEvent {
  event?: string
  time?: string
  country?: string
  impact?: string
  actual?: number | null
  estimate?: number | null
  prev?: number | null
  unit?: string | null
}

interface FinnhubCalendarResponse {
  economicCalendar?: FinnhubEconomicEvent[]
}

function parseImpact(val: string | undefined): 'high' | 'medium' | 'low' {
  if (val === 'high') return 'high'
  if (val === 'medium') return 'medium'
  return 'low'
}

async function pollMacroCalendar(): Promise<void> {
  if (!CONFIG.FINNHUB_API_KEY) {
    console.warn('[MacroCalendar] FINNHUB_API_KEY not set — skipping')
    return
  }

  try {
    const url = `https://finnhub.io/api/v1/calendar/economic?token=${CONFIG.FINNHUB_API_KEY}`
    const res = await fetch(url, { headers: { 'User-Agent': 'SPYDash/1.0' } })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }

    const json = (await res.json()) as FinnhubCalendarResponse
    const rawEvents = json.economicCalendar ?? []

    // Filter: US only, high/medium impact, not yet released or released today
    const now = new Date()
    const todayStr = now.toISOString().slice(0, 10)

    const filtered = rawEvents
      .filter((e) => {
        if (e.country !== 'US') return false
        const impact = parseImpact(e.impact)
        if (impact === 'low') return false
        // Keep events from today onward
        const eventDate = e.time ? e.time.slice(0, 10) : null
        return eventDate !== null && eventDate >= todayStr
      })
      .slice(0, 20) // cap at 20 events

    const items: MacroEvent[] = filtered.map((e) => ({
      event: e.event ?? 'Unknown',
      time: e.time ?? null,
      country: e.country ?? 'US',
      impact: parseImpact(e.impact),
      actual: e.actual ?? null,
      estimate: e.estimate ?? null,
      prev: e.prev ?? null,
      unit: e.unit ?? null,
    }))

    newsSnapshot.macroEvents = items

    emitter.emit('newsfeed', { type: 'macro-events', items, ts: Date.now() })
    console.log(`[MacroCalendar] Updated: ${items.length} upcoming US events`)
  } catch (err) {
    console.error('[MacroCalendar] Error:', (err as Error).message)
  }
}

export function startMacroCalendar(): void {
  pollMacroCalendar().catch(console.error)
  setInterval(() => pollMacroCalendar().catch(console.error), POLL_INTERVAL)
}

import { CONFIG } from '../config'
import { emitter, newsSnapshot } from './marketState'
import type { MacroEvent, FinnhubCalendarApiResponse } from '../types/market'
import { FinnhubCalendarSchema } from '../types/market'
import { createBreaker } from '../lib/circuitBreaker'
import { cacheGet, cacheSet } from '../lib/cacheStore'

const POLL_INTERVAL = 60 * 60 * 1000 // 1 hour
const CACHE_KEY = 'macro_events'
const CACHE_TTL = 3_960_000 // POLL_INTERVAL * 1.1

// Last successfully validated events — used as fallback when API fails
let lastValidMacroEvents: MacroEvent[] | null = null

function parseImpact(val: string | undefined): 'high' | 'medium' | 'low' {
  if (val === 'high') return 'high'
  if (val === 'medium') return 'medium'
  return 'low'
}

const fetchBreaker = createBreaker(
  async (url: string) => {
    const res = await fetch(url, { headers: { 'User-Agent': 'SPYDash/1.0' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json() as Promise<unknown>
  },
  'finnhub',
  { resetTimeout: 300_000 }, // free tier rate limited — retry after 5 min
)

async function pollMacroCalendar(): Promise<void> {
  if (!CONFIG.FINNHUB_API_KEY) {
    console.warn('[MacroCalendar] FINNHUB_API_KEY not set — skipping')
    return
  }

  const cached = await cacheGet<{ events: MacroEvent[]; ts: number }>(CACHE_KEY)
  if (cached) {
    newsSnapshot.macroEvents = cached.events
    newsSnapshot.macroEventsTs = cached.ts
    emitter.emit('newsfeed', { type: 'macro-events', items: cached.events, ts: cached.ts })
    return
  }

  const url = `https://finnhub.io/api/v1/calendar/economic?token=${CONFIG.FINNHUB_API_KEY}`
  const raw = (await fetchBreaker.fire(url)) as FinnhubCalendarApiResponse | null

  if (!raw) {
    // CB fallback: circuit is OPEN or fetch failed
    if (lastValidMacroEvents !== null) {
      newsSnapshot.macroEvents = lastValidMacroEvents
      emitter.emit('newsfeed', {
        type: 'macro-events',
        items: lastValidMacroEvents,
        ts: Date.now(),
        _stale: true,
      })
      console.warn('[MacroCalendar] Usando dados em cache (último válido)')
    }
    return
  }

  const parsed = FinnhubCalendarSchema.safeParse(raw)
  if (!parsed.success) {
    console.error('[MacroCalendar] Schema inválido:', parsed.error.format())
    console.error('[MacroCalendar] Payload recebido:', JSON.stringify(raw).slice(0, 500))
    if (lastValidMacroEvents !== null) {
      newsSnapshot.macroEvents = lastValidMacroEvents
      emitter.emit('newsfeed', {
        type: 'macro-events',
        items: lastValidMacroEvents,
        ts: Date.now(),
        _stale: true,
      })
    }
    return
  }

  const rawEvents = parsed.data.economicCalendar ?? []

  // Filter: US only, high/medium impact, not yet released or released today
  const now = new Date()
  const todayStr = now.toISOString().slice(0, 10)

  const filtered = rawEvents
    .filter((e) => {
      if (e.country !== 'US') return false
      const impact = parseImpact(e.impact)
      if (impact === 'low') return false
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

  lastValidMacroEvents = items
  newsSnapshot.macroEvents = items
  newsSnapshot.macroEventsTs = Date.now()
  await cacheSet(CACHE_KEY, { events: items, ts: newsSnapshot.macroEventsTs }, CACHE_TTL, 'finnhub')
  emitter.emit('newsfeed', { type: 'macro-events', items, ts: newsSnapshot.macroEventsTs })
  console.log(`[MacroCalendar] Updated: ${items.length} upcoming US events`)
}

export function startMacroCalendar(): void {
  pollMacroCalendar().catch(console.error)
  setInterval(() => pollMacroCalendar().catch(console.error), POLL_INTERVAL)
}

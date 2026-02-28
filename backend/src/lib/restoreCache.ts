import { cacheGet } from './cacheStore'
import { emitter, newsSnapshot, updateIVRank, updateVIX } from '../data/marketState'
import type {
  FearGreedData,
  MacroDataItem,
  NewsHeadline,
  MacroEvent,
  EarningsItem,
} from '../types/market'

interface CachedMacro {
  items: MacroDataItem[]
  ts: number
}

interface CachedEvents {
  events: MacroEvent[]
  ts: number
}

interface CachedEarnings {
  items: EarningsItem[]
  ts: number
}

export async function restoreSnapshotsFromCache(): Promise<void> {
  console.log('[Cache] Restaurando snapshots do Supabase...')

  const [fg, fred, bls, headlines, events, earnings, ivrank, vix] = await Promise.allSettled([
    cacheGet<FearGreedData>('fear_greed'),
    cacheGet<CachedMacro>('fred_macro'),
    cacheGet<CachedMacro>('bls_macro'),
    cacheGet<NewsHeadline[]>('gnews_headlines'),
    cacheGet<CachedEvents>('macro_events'),
    cacheGet<CachedEarnings>('earnings'),
    cacheGet<{ value: number; percentile: number | null; ivx: number | null }>('ivrank_snapshot'),
    cacheGet<{ last: number; change: number }>('vix_snapshot'),
  ])

  if (fg.status === 'fulfilled' && fg.value) {
    newsSnapshot.fearGreed = fg.value
    emitter.emit('newsfeed', { type: 'sentiment', fearGreed: fg.value, ts: Date.now() })
    console.log('[Cache] ✓ fearGreed restored')
  }

  if (fred.status === 'fulfilled' && fred.value) {
    newsSnapshot.macro = fred.value.items
    newsSnapshot.macroTs = fred.value.ts
    emitter.emit('newsfeed', { type: 'macro', items: fred.value.items, ts: fred.value.ts })
    console.log('[Cache] ✓ fred_macro restored')
  }

  if (bls.status === 'fulfilled' && bls.value) {
    newsSnapshot.bls = bls.value.items
    newsSnapshot.blsTs = bls.value.ts
    emitter.emit('newsfeed', { type: 'bls', items: bls.value.items, ts: bls.value.ts })
    console.log('[Cache] ✓ bls restored')
  }

  if (headlines.status === 'fulfilled' && headlines.value) {
    newsSnapshot.headlines = headlines.value
    emitter.emit('newsfeed', {
      type: 'headlines',
      items: headlines.value,
      ts: Date.now(),
    })
    console.log('[Cache] ✓ headlines restored')
  }

  if (events.status === 'fulfilled' && events.value) {
    newsSnapshot.macroEvents = events.value.events
    newsSnapshot.macroEventsTs = events.value.ts
    emitter.emit('newsfeed', {
      type: 'macro-events',
      items: events.value.events,
      ts: events.value.ts,
    })
    console.log('[Cache] ✓ macroEvents restored')
  }

  if (earnings.status === 'fulfilled' && earnings.value) {
    newsSnapshot.earnings = earnings.value.items
    newsSnapshot.earningsTs = earnings.value.ts
    emitter.emit('newsfeed', {
      type: 'earnings',
      items: earnings.value.items,
      ts: earnings.value.ts,
    })
    console.log('[Cache] ✓ earnings restored')
  }

  if (ivrank.status === 'fulfilled' && ivrank.value) {
    updateIVRank(ivrank.value)
    console.log('[Cache] ✓ ivrank restored')
  }

  if (vix.status === 'fulfilled' && vix.value) {
    updateVIX(vix.value)
    console.log('[Cache] ✓ vix restored')
  }
}

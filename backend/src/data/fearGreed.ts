import { emitter, newsSnapshot } from './marketState'
import type { FearGreedData } from '../types/market'

const POLL_INTERVAL = 4 * 60 * 60 * 1000 // 4 hours
const FEAR_GREED_URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata'

interface CNNFearGreedResponse {
  fear_and_greed?: {
    score?: number
    rating?: string
    previous_close?: number
    timestamp?: string
  }
}

async function pollFearGreed(): Promise<void> {
  try {
    const res = await fetch(FEAR_GREED_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SPYDash/1.0)',
        Accept: 'application/json',
        Referer: 'https://edition.cnn.com/',
      },
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }

    const json = (await res.json()) as CNNFearGreedResponse
    const fg = json.fear_and_greed

    if (!fg) {
      throw new Error('Unexpected CNN F&G response structure')
    }

    const data: FearGreedData = {
      score: typeof fg.score === 'number' ? Math.round(fg.score) : null,
      label: fg.rating ?? null,
      previousClose: typeof fg.previous_close === 'number' ? Math.round(fg.previous_close) : null,
      lastUpdated: Date.now(),
    }

    newsSnapshot.fearGreed = data

    emitter.emit('newsfeed', { type: 'sentiment', fearGreed: data, ts: Date.now() })
    console.log(`[FearGreed] Score: ${data.score} — ${data.label}`)
  } catch (err) {
    console.warn('[FearGreed] Could not fetch (unofficial endpoint):', (err as Error).message)
    // Do not clear existing snapshot on transient errors
  }
}

export function startFearGreedPoller(): void {
  pollFearGreed().catch(console.error)
  setInterval(() => pollFearGreed().catch(console.error), POLL_INTERVAL)
}

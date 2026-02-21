import { CONFIG } from '../config'
import { ensureAccessToken } from '../auth/tokenManager'

export interface OptionExpiry {
  dte: number
  expirationDate: string
  calls: OptionLeg[]
  puts: OptionLeg[]
}

export interface OptionLeg {
  symbol: string
  strike: number
  bid: number | null
  ask: number | null
  volume: number | null
  openInterest: number | null
  iv: number | null
  delta: number | null
}

let cachedChain: OptionExpiry[] = []
let lastFetch = 0
const CACHE_TTL = 5 * 60_000 // 5 minutes

export async function getOptionChain(): Promise<OptionExpiry[]> {
  if (Date.now() - lastFetch < CACHE_TTL && cachedChain.length > 0) {
    return cachedChain
  }

  try {
    const token = await ensureAccessToken()
    const res = await fetch(`${CONFIG.TT_BASE}/option-chains/SPY/nested`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })

    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const json = (await res.json()) as {
      data?: {
        items?: Array<{
          'expiration-date': string
          'days-to-expiration': number
          strikes?: Array<{
            strike: number | string
            call?: { symbol: string; bid?: number; ask?: number }
            put?: { symbol: string; bid?: number; ask?: number }
          }>
        }>
      }
    }

    const items = json.data?.items ?? []
    // Filter relevant DTE buckets: 0, 1, 7, 21, 45
    const targetDTEs = [0, 1, 7, 21, 45]

    cachedChain = items
      .filter((exp) => {
        const dte = exp['days-to-expiration']
        return targetDTEs.some((t) => Math.abs(dte - t) <= 3)
      })
      .map((exp) => ({
        dte: exp['days-to-expiration'],
        expirationDate: exp['expiration-date'],
        calls: (exp.strikes ?? [])
          .filter((s) => s.call)
          .map((s) => ({
            symbol: s.call!.symbol,
            strike: Number(s.strike),
            bid: s.call!.bid ?? null,
            ask: s.call!.ask ?? null,
            volume: null,
            openInterest: null,
            iv: null,
            delta: null,
          })),
        puts: (exp.strikes ?? [])
          .filter((s) => s.put)
          .map((s) => ({
            symbol: s.put!.symbol,
            strike: Number(s.strike),
            bid: s.put!.bid ?? null,
            ask: s.put!.ask ?? null,
            volume: null,
            openInterest: null,
            iv: null,
            delta: null,
          })),
      }))

    lastFetch = Date.now()
    console.log(`[OptionChain] Fetched ${cachedChain.length} expiries`)
    return cachedChain
  } catch (err) {
    console.error('[OptionChain] Error fetching chain:', (err as Error).message)
    return cachedChain
  }
}

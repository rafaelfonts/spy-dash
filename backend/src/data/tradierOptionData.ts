import { getTradierClient } from '../lib/tradierClient'

export interface TradierStrikeData {
  openInterest: number
  volume: number
  gamma: number
}

/** Map key format: `${strike}:${'call'|'put'}` */
export type TradierOIMap = Map<string, TradierStrikeData>

export function makeKey(strike: number, type: 'call' | 'put'): string {
  return `${strike}:${type}`
}

/**
 * Fetch OI + gamma data from Tradier for a given expiration date.
 * Returns an empty map if TRADIER_API_KEY is not set or on error.
 */
export async function getTradierOI(expiration: string): Promise<TradierOIMap> {
  const options = await getTradierClient().getOptionChain('SPY', expiration)

  const map: TradierOIMap = new Map()
  for (const opt of options) {
    map.set(makeKey(opt.strike, opt.option_type), {
      openInterest: opt.open_interest ?? 0,
      volume: opt.volume ?? 0,
      gamma: opt.greeks?.gamma ?? 0,
    })
  }

  return map
}

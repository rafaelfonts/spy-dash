import { createClient } from '@supabase/supabase-js'
import { marketState } from './marketState'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const PERSIST_INTERVAL_MS = 60_000 // 1 minuto — evita 3600+ writes/hora
const lastPersisted: Record<string, number> = {}

interface PriceTick {
  price: number
  bid: number | null
  ask: number | null
  volume: number | null
}

export function persistPriceTick(symbol: string, tick: PriceTick): void {
  const now = Date.now()
  if ((lastPersisted[symbol] ?? 0) + PERSIST_INTERVAL_MS > now) return
  lastPersisted[symbol] = now

  supabase
    .from('price_ticks')
    .insert({
      symbol,
      recorded_at: new Date().toISOString(),
      price: tick.price,
      bid: tick.bid,
      ask: tick.ask,
      volume: tick.volume,
    })
    .then(({ error }) => {
      if (error) console.error('[PriceHistory] Insert falhou:', error.message)
    })
}

export async function restorePriceHistory(): Promise<void> {
  for (const symbol of ['SPY', 'VIX']) {
    const since = new Date(Date.now() - 60 * 60_000).toISOString()
    const { data, error } = await supabase
      .from('price_sparkline')
      .select('price_avg')
      .eq('symbol', symbol)
      .gte('minute', since)
      .order('minute', { ascending: true })
      .limit(60)

    if (error) {
      console.error(`[PriceHistory] Falha ao restaurar ${symbol}:`, error.message)
      continue
    }
    if (!data?.length) continue

    const prices = data.map((r) => parseFloat(r.price_avg as string))
    if (symbol === 'SPY') {
      marketState.spy.priceHistory = prices
    } else {
      marketState.vix.priceHistory = prices
    }
    console.log(`[PriceHistory] Restaurado ${prices.length} minutos de ${symbol}`)
  }
}

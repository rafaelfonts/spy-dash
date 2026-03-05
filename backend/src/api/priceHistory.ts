import { createClient } from '@supabase/supabase-js'
import type { FastifyInstance } from 'fastify'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function registerPriceHistory(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/price-history', async (request, reply) => {
    const { symbol = 'SPY', minutes = '60', before } = request.query as {
      symbol?: string
      minutes?: string
      before?: string
    }

    const mins = Math.min(Math.max(parseInt(minutes, 10) || 60, 1), 1440) // 1–1440 min
    const since = new Date(Date.now() - mins * 60_000).toISOString()
    const beforeParam = before ?? null

    const { data, error } = await supabase.rpc('get_price_sparkline', {
      p_symbol: symbol.toUpperCase(),
      p_since: since,
      p_limit: mins,
      p_before: beforeParam,
    })

    if (error) {
      reply.code(500)
      return { error: 'Falha ao buscar histórico de preços' }
    }

    return {
      symbol: symbol.toUpperCase(),
      data: data ?? [],
      // Cursor para paginação retroativa (antes do ponto mais antigo retornado)
      nextCursor: data && data.length === mins ? (data[0] as { minute: string }).minute : null,
    }
  })
}

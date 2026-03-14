// backend/src/api/equityWatchlist.ts
import type { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import { cacheSet } from '../lib/cacheStore.js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
function getUserId(request: any): string {
  return request.user?.id ?? '';
}

// Invalida cache da watchlist agregada (usada por checkEquityAlerts)
async function invalidateWatchlistCache(): Promise<void> {
  await cacheSet('equity:watchlist:all', null, 1, 'equityWatchlist'); // TTL 1ms = imediata expiração
}

export async function registerEquityWatchlistRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/equity/watchlist
  app.get('/api/equity/watchlist', async (request, reply) => {
    const userId = getUserId(request);
    const { data, error } = await supabase
      .from('equity_watchlist')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) return reply.status(500).send({ error: error.message });
    return reply.send(data);
  });

  // POST /api/equity/watchlist
  app.post('/api/equity/watchlist', async (request, reply) => {
    const userId = getUserId(request);
    const body = request.body as {
      symbol: string;
      alert_price?: number;
      alert_direction?: 'above' | 'below';
    };

    if (!body.symbol || !/^[A-Z]{1,5}$/.test(body.symbol.trim().toUpperCase())) {
      return reply.status(400).send({ error: 'symbol inválido' });
    }
    if ((body.alert_price && !body.alert_direction) || (!body.alert_price && body.alert_direction)) {
      return reply.status(400).send({ error: 'alert_price e alert_direction devem ser enviados juntos' });
    }

    const { data, error } = await supabase
      .from('equity_watchlist')
      .upsert({
        user_id: userId,
        symbol: body.symbol.toUpperCase(),
        alert_price: body.alert_price ?? null,
        alert_direction: body.alert_direction ?? null,
      }, { onConflict: 'user_id,symbol' })
      .select()
      .single();

    if (error) return reply.status(500).send({ error: error.message });
    await invalidateWatchlistCache();
    return reply.status(201).send(data);
  });

  // DELETE /api/equity/watchlist/:symbol
  app.delete('/api/equity/watchlist/:symbol', async (request, reply) => {
    const userId = getUserId(request);
    const { symbol } = request.params as { symbol: string };
    const { error } = await supabase
      .from('equity_watchlist')
      .delete()
      .eq('user_id', userId)
      .eq('symbol', symbol.toUpperCase());
    if (error) return reply.status(500).send({ error: error.message });
    await invalidateWatchlistCache();
    return reply.status(204).send();
  });
}

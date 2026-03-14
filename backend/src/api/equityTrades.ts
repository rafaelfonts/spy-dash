// backend/src/api/equityTrades.ts
import type { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import { sendEmbed } from '../lib/discordClient.js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

function getUserId(request: any): string {
  return request.user?.id ?? '';
}

export async function registerEquityTradesRoutes(app: FastifyInstance): Promise<void> {
  const auth = [(app as any).requireAuth];

  // GET /api/equity/trades?month=YYYY-MM
  app.get('/api/equity/trades', { preHandler: auth }, async (request, reply) => {
    const userId = getUserId(request);
    const { month } = request.query as { month?: string };

    let query = supabase
      .from('equity_trades')
      .select('*')
      .eq('user_id', userId)
      .order('entry_date', { ascending: false });

    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [year, mon] = month.split('-');
      const from = `${year}-${mon}-01`;
      const to = `${year}-${mon}-31`;
      query = query.gte('entry_date', from).lte('entry_date', to);
    }

    const { data, error } = await query;
    if (error) return reply.status(500).send({ error: error.message });
    return reply.send(data);
  });

  // POST /api/equity/trades
  app.post('/api/equity/trades', { preHandler: auth }, async (request, reply) => {
    const userId = getUserId(request);
    const body = request.body as {
      symbol: string;
      entry_date: string;
      entry_price: number;
      quantity: number;
      notes?: string;
    };

    if (!body.symbol || !body.entry_date || !body.entry_price || !body.quantity) {
      return reply.status(400).send({ error: 'Campos obrigatórios: symbol, entry_date, entry_price, quantity' });
    }

    const { data, error } = await supabase
      .from('equity_trades')
      .insert({
        user_id: userId,
        symbol: body.symbol.toUpperCase(),
        entry_date: body.entry_date,
        entry_price: body.entry_price,
        quantity: body.quantity,
        notes: body.notes ?? null,
        status: 'open',
      })
      .select()
      .single();

    if (error) return reply.status(500).send({ error: error.message });

    // Notificar Discord — fire and forget
    sendEmbed('acoes', {
      title: `📥 Trade Registrado: ${data.symbol}`,
      description: `**Entrada:** $${data.entry_price} × ${data.quantity} ações\n**Capital:** ~$${(data.entry_price * data.quantity).toFixed(2)}\n**Data:** ${data.entry_date}`,
      color: 0x3498DB,
      timestamp: new Date().toISOString(),
    }).catch(() => {});

    return reply.status(201).send(data);
  });

  // PATCH /api/equity/trades/:id — registrar saída + calcular P&L
  app.patch('/api/equity/trades/:id', { preHandler: auth }, async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const body = request.body as { exit_date: string; exit_price: number };

    if (!body.exit_date || !body.exit_price) {
      return reply.status(400).send({ error: 'Campos obrigatórios: exit_date, exit_price' });
    }

    // Buscar trade para calcular P&L
    const { data: trade, error: fetchErr } = await supabase
      .from('equity_trades')
      .select('entry_price, quantity')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (fetchErr || !trade) return reply.status(404).send({ error: 'Trade não encontrado' });

    const pnl = (body.exit_price - trade.entry_price) * trade.quantity;

    const { data, error } = await supabase
      .from('equity_trades')
      .update({
        exit_date: body.exit_date,
        exit_price: body.exit_price,
        pnl: Math.round(pnl * 10000) / 10000,
        status: 'closed',
      })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) return reply.status(500).send({ error: error.message });

    // Notificar Discord — fire and forget
    const pnlFormatted = data.pnl >= 0 ? `+$${data.pnl.toFixed(2)}` : `-$${Math.abs(data.pnl).toFixed(2)}`;
    const durationDays = data.exit_date && data.entry_date
      ? Math.round((new Date(data.exit_date).getTime() - new Date(data.entry_date).getTime()) / 86400000)
      : 1;
    sendEmbed('acoes', {
      title: `${data.pnl >= 0 ? '✅' : '❌'} Trade Fechado: ${data.symbol}`,
      description: `**P&L:** ${pnlFormatted}\n**Entrada:** $${data.entry_price} → **Saída:** $${data.exit_price}\n**Duração:** ${durationDays} dia(s) | **Quantidade:** ${data.quantity}`,
      color: data.pnl >= 0 ? 0x00CC66 : 0xE74C3C,
      timestamp: new Date().toISOString(),
    }).catch(() => {});

    return reply.send(data);
  });

  // DELETE /api/equity/trades/:id
  app.delete('/api/equity/trades/:id', { preHandler: auth }, async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const { error } = await supabase
      .from('equity_trades')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) return reply.status(500).send({ error: error.message });
    return reply.status(204).send();
  });
}

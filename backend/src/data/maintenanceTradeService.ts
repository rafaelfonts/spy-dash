// backend/src/data/maintenanceTradeService.ts
// Garante mínimo de 1 operação por mês para manter APIs ativas.
// Executa SOMENTE no último dia útil do mês, entre 10:30–11:00 ET,
// e SOMENTE se o usuário não tiver nenhum trade fechado no mês corrente.

import { createClient } from '@supabase/supabase-js';
import { getTradierClient } from '../lib/tradierClient.js';
import { sendEmbed } from '../lib/discordClient.js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ETF de baixa volatilidade usado para operação de manutenção
const MAINTENANCE_SYMBOL = 'SPLG';

function getETNow(): Date {
  // UTC-5 (EST) — mesmo padrão do resto do projeto (ignora DST)
  return new Date(Date.now() - 5 * 60 * 60 * 1000);
}

function getLastBusinessDayOfMonth(year: number, month: number): number {
  // month: 0-indexed (Jan=0)
  const lastDay = new Date(Date.UTC(year, month + 1, 0)); // último dia do mês
  const dow = lastDay.getUTCDay(); // 0=Dom, 6=Sáb
  if (dow === 0) return lastDay.getUTCDate() - 2; // domingo → sexta
  if (dow === 6) return lastDay.getUTCDate() - 1; // sábado → sexta
  return lastDay.getUTCDate();
}

async function countClosedTradesThisMonth(userId: string): Promise<number> {
  const et = getETNow();
  const year = et.getUTCFullYear();
  const month = String(et.getUTCMonth() + 1).padStart(2, '0');
  const from = `${year}-${month}-01`;
  const to = `${year}-${month}-31`;

  const { count, error } = await supabase
    .from('equity_trades')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'closed')
    .gte('entry_date', from)
    .lte('entry_date', to);

  if (error) {
    console.warn('[maintenanceTrade] Erro ao contar trades:', error.message);
    return 0;
  }
  return count ?? 0;
}

async function getMaintenanceUserId(): Promise<string | null> {
  // Preferência: variável de ambiente MAINTENANCE_USER_ID
  if (process.env.MAINTENANCE_USER_ID) return process.env.MAINTENANCE_USER_ID;

  // Fallback: primeiro usuário com trades registrados
  const { data } = await supabase
    .from('equity_trades')
    .select('user_id')
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  return data?.user_id ?? null;
}

export async function checkAndExecuteMaintenanceTrade(): Promise<void> {
  const et = getETNow();
  const hour = et.getUTCHours();
  const minute = et.getUTCMinutes();
  const day = et.getUTCDate();
  const month = et.getUTCMonth(); // 0-indexed
  const year = et.getUTCFullYear();
  const dayOfWeek = et.getUTCDay();

  // Só executa em dias úteis
  if (dayOfWeek === 0 || dayOfWeek === 6) return;

  // Só executa entre 10:30 e 11:00 ET
  const minuteOfDay = hour * 60 + minute;
  if (minuteOfDay < 10 * 60 + 30 || minuteOfDay >= 11 * 60) return;

  // Só executa no último dia útil do mês
  const lastBD = getLastBusinessDayOfMonth(year, month);
  if (day !== lastBD) return;

  const userId = await getMaintenanceUserId();
  if (!userId) {
    console.warn('[maintenanceTrade] Nenhum userId encontrado para manutenção');
    return;
  }

  // Verifica se já operou este mês
  const tradeCount = await countClosedTradesThisMonth(userId);
  if (tradeCount > 0) {
    console.log(`[maintenanceTrade] Mês já tem ${tradeCount} trade(s) fechado(s) — manutenção dispensada`);
    return;
  }

  // Buscar preço atual do ETF
  const quotes = await getTradierClient().getQuotes([MAINTENANCE_SYMBOL]).catch(() => []);
  const quote = quotes[0];
  if (!quote) {
    console.warn('[maintenanceTrade] Não foi possível obter cotação do SPLG');
    return;
  }

  const entryPrice = quote.last ?? quote.close ?? 0;
  if (entryPrice <= 0) {
    console.warn('[maintenanceTrade] Preço inválido para SPLG:', entryPrice);
    return;
  }

  const exitPrice = Math.round((entryPrice + 0.01) * 10000) / 10000;
  const today = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const notes = 'operação de manutenção — ativação de conta';

  // Inserir entrada + saída em uma única transação lógica
  const { data: inserted, error: insertErr } = await supabase
    .from('equity_trades')
    .insert({
      user_id: userId,
      symbol: MAINTENANCE_SYMBOL,
      entry_date: today,
      exit_date: today,
      entry_price: entryPrice,
      exit_price: exitPrice,
      quantity: 1,
      pnl: 0.01,
      status: 'closed',
      notes,
    })
    .select()
    .single();

  if (insertErr || !inserted) {
    console.error('[maintenanceTrade] Erro ao inserir trade de manutenção:', insertErr?.message);
    return;
  }

  console.log(`[maintenanceTrade] Trade de manutenção registrado: ${MAINTENANCE_SYMBOL} @ $${entryPrice}`);

  // Notificar Discord — fire and forget
  sendEmbed('acoes', {
    title: `🔧 Manutenção — Ativação de Conta`,
    description: `Trade de manutenção registrado automaticamente.\n**Ativo:** ${MAINTENANCE_SYMBOL}\n**Preço:** $${entryPrice.toFixed(2)}\n**Custo:** $0.01\n_Nenhum sinal de trading foi gerado este mês._`,
    color: 0x7F8C8D,
    timestamp: new Date().toISOString(),
  }).catch(() => {});
}

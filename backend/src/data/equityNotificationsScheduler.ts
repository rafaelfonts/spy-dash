// backend/src/data/equityNotificationsScheduler.ts
// Segue o mesmo padrão de preMarketBriefing.ts: setInterval(60s) + check de horário ET + cooldown Redis

import { cacheGet, cacheSet } from '../lib/cacheStore.js';
import { sendEmbed } from '../lib/discordClient.js';
import { getEquityScreenerSnapshot } from './equityScreenerState.js';
import { checkAndExecuteMaintenanceTrade } from './maintenanceTradeService.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

function getETHour(): { hour: number; minute: number; dayOfWeek: number } {
  const now = new Date();
  // UTC-5 (EST) — ignora DST por simplicidade (igual ao preMarketBriefing.ts)
  const etMs = now.getTime() - 5 * 60 * 60 * 1000;
  const et = new Date(etMs);
  return {
    hour: et.getUTCHours(),
    minute: et.getUTCMinutes(),
    dayOfWeek: et.getUTCDay(), // 0=Dom, 5=Sex
  };
}

function getDateKey(): string {
  const now = new Date();
  const etMs = now.getTime() - 5 * 60 * 60 * 1000;
  const et = new Date(etMs);
  return `${et.getUTCFullYear()}-${String(et.getUTCMonth() + 1).padStart(2, '0')}-${String(et.getUTCDate()).padStart(2, '0')}`;
}

function getWeekKey(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getUTCDay() + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

async function sendDailyScreenerDigest(): Promise<void> {
  const cooldownKey = `equity:screener_discord:${getDateKey()}`;
  const alreadySent = await cacheGet<boolean>(cooldownKey);
  if (alreadySent) return;

  const snapshot = getEquityScreenerSnapshot();
  if (!snapshot.marketOpen || snapshot.candidates.length === 0) return;

  const top5 = snapshot.candidates.slice(0, 5);
  const lines = top5.map((c, i) =>
    `**${i + 1}. ${c.symbol}** — $${c.price.toFixed(2)} | ${c.change >= 0 ? '+' : ''}${c.change.toFixed(1)}% | RVOL ${c.rvol}x${c.hasCatalyst ? ' 📰' : ''}`
  ).join('\n');

  await sendEmbed('acoes', {
    title: '📊 Screener Diário — Top Candidatos',
    description: `**${new Date().toLocaleDateString('pt-BR')}** — ${top5.length} candidatos com momentum\n\n${lines}`,
    color: 0x00FF88,
    timestamp: new Date().toISOString(),
  });

  // Cooldown: não reenviar hoje (TTL 14h)
  await cacheSet(cooldownKey, true, 14 * 60 * 60 * 1000, 'equityNotifications');
  console.log('[equityNotifications] Daily screener digest sent to Discord #acoes');
}

async function sendWeeklySummary(): Promise<void> {
  const cooldownKey = `equity:weekly_discord:${getWeekKey()}`;
  const alreadySent = await cacheGet<boolean>(cooldownKey);
  if (alreadySent) return;

  // Buscar trades desta semana (últimos 7 dias)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const from = sevenDaysAgo.toISOString().split('T')[0];

  const { data: trades } = await supabase
    .from('equity_trades')
    .select('symbol, pnl, status, entry_date')
    .gte('entry_date', from)
    .eq('status', 'closed');

  const closedTrades = trades ?? [];
  const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const winners = closedTrades.filter((t) => (t.pnl ?? 0) > 0);
  const winRate = closedTrades.length > 0 ? Math.round((winners.length / closedTrades.length) * 100) : 0;

  const currentMonthStart = new Date().toISOString().slice(0, 7);
  const { data: monthTrades } = await supabase
    .from('equity_trades')
    .select('id')
    .gte('entry_date', `${currentMonthStart}-01`)
    .eq('status', 'closed');

  const monthCount = (monthTrades ?? []).length;
  const metaStatus = monthCount >= 2 ? '✅ Meta mensal atingida' : `⚠ ${monthCount}/2 operações no mês`;

  const pnlFormatted = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;

  await sendEmbed('acoes', {
    title: '📈 Resumo Semanal — Área de Ações',
    description: `**P&L da semana:** ${pnlFormatted}\n**Operações fechadas:** ${closedTrades.length}\n**Win rate:** ${winRate}%\n\n${metaStatus}`,
    color: 0x9B59B6,
    timestamp: new Date().toISOString(),
  });

  await cacheSet(cooldownKey, true, 7 * 24 * 60 * 60 * 1000, 'equityNotifications');
  console.log('[equityNotifications] Weekly summary sent to Discord #acoes');
}

export function startEquityNotificationsScheduler(): void {
  setInterval(async () => {
    const { hour, minute, dayOfWeek } = getETHour();

    // Screener diário: 09:30 ET (dias úteis)
    if (dayOfWeek >= 1 && dayOfWeek <= 5 && hour === 9 && minute >= 30 && minute < 32) {
      await sendDailyScreenerDigest().catch((e) => console.warn('[equityNotifications] Screener digest failed:', e));
    }

    // Resumo semanal: sexta 17:00 ET
    if (dayOfWeek === 5 && hour === 17 && minute >= 0 && minute < 2) {
      await sendWeeklySummary().catch((e) => console.warn('[equityNotifications] Weekly summary failed:', e));
    }

    // Manutenção de API: último dia útil do mês, 10:30–11:00 ET
    if (dayOfWeek >= 1 && dayOfWeek <= 5 && hour === 10 && minute >= 30 && minute < 60) {
      await checkAndExecuteMaintenanceTrade().catch((e) => console.warn('[equityNotifications] Maintenance trade failed:', e));
    }
  }, 60 * 1000); // verifica a cada 60s

  console.log('[equityNotifications] Scheduler started');
}

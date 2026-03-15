// backend/src/data/equityScreenerPoller.ts
import { getTradierClient } from '../lib/tradierClient.js';
import { emitter } from '../data/marketState.js';
import { getEquityUniverse, scheduleWeeklyUniverseRefresh } from './equityUniverseService.js';
import { startEquityCatalystPoller, getCatalystTickers } from './equityCatalystPoller.js';
import { setEquityCandidates, DEFAULT_FILTERS } from './equityScreenerState.js';
import type { EquityCandidate } from './equityTypes.js';
import { checkEquityAlerts } from './alertEngine.js';
import { calcRSI } from '../lib/technicalCalcs.js';

const POLL_MS = 60_000;
const OFFHOURS_MS = 5 * 60_000;

function isMarketOpen(): boolean {
  const now = new Date();
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const open = 14 * 60 + 15;  // 09:15 ET = 14:15 UTC
  const close = 20 * 60 + 15; // 16:15 ET = 21:15 UTC
  const day = now.getUTCDay();
  return day >= 1 && day <= 5 && utcMin >= open && utcMin <= close;
}

async function tick(): Promise<void> {
  const universe = await getEquityUniverse();
  if (universe.tickers.length === 0) return;

  const quotes = await getTradierClient().getQuotes(universe.tickers).catch(() => []);
  if (quotes.length === 0) return;

  const catalysts = getCatalystTickers();
  const f = DEFAULT_FILTERS;

  const rawCandidates = quotes
    .filter((q) => {
      const price = q.last ?? q.close ?? 0;
      const change = q.change_percentage ?? 0;
      const vol = q.volume ?? 0;
      const avgVol = q.average_volume ?? 0;
      if (avgVol === 0) return false; // rejeita se RVOL incalculável
      const rvol = vol / avgVol;
      return (
        price >= f.priceMin &&
        price <= f.priceMax &&
        vol >= f.volumeMin &&
        rvol >= f.rvolMin &&
        change >= f.changeMin
      );
    })
    .map((q) => ({
      symbol: q.symbol,
      price: q.last ?? q.close ?? 0,
      changePct: q.change_percentage ?? 0,
      volume: q.volume ?? 0,
      rvol: Math.round(((q.volume ?? 0) / (q.average_volume ?? 1)) * 10) / 10,
      hasCatalyst: catalysts.has(q.symbol),
    }));

  // Compute equityScore for each candidate (no extra API calls — rsiMacroScore = 0 fallback)
  const candidates: EquityCandidate[] = rawCandidates
    .map((c) => {
      // RSI not available without timesales fetch — use 0 as fallback per spec
      const rsiMacroScore = 0;
      const equityScore = Math.round(
        Math.min(c.rvol / 5, 1) * 30 +
        Math.min(Math.abs(c.changePct) / 10, 1) * 25 +
        (c.hasCatalyst ? 1 : 0) * 25 +
        rsiMacroScore * 20
      );
      return {
        symbol: c.symbol,
        price: c.price,
        change: c.changePct,
        volume: c.volume,
        rvol: c.rvol,
        hasCatalyst: c.hasCatalyst,
        lastUpdated: Date.now(),
        equityScore,
        isTopSetup: false, // set after sorting
      };
    })
    .sort((a, b) => b.equityScore - a.equityScore)
    .slice(0, 20) // máx 20 candidatos exibidos
    .map((c, idx) => ({ ...c, isTopSetup: idx < 3 }));

  const open = isMarketOpen();
  setEquityCandidates(candidates, open);
  emitter.emit('equity-screener', { candidates, filters: f, marketOpen: open, capturedAt: Date.now() });

  // Verificar alertas da watchlist (non-blocking)
  checkEquityAlerts(candidates.map((c) => ({ symbol: c.symbol, price: c.price })))
    .catch((e) => console.warn('[equityScreener] checkEquityAlerts failed:', e));

  if (candidates.length > 0) {
    console.log(`[equityScreener] ${candidates.length} candidates | top: ${candidates[0].symbol} RVOL=${candidates[0].rvol}x`);
  }
}

export async function startEquityScreenerPoller(): Promise<void> {
  // Inicializar universo + catalisadores
  await getEquityUniverse().catch((e) => console.warn('[equityScreener] Universe init failed:', e));
  scheduleWeeklyUniverseRefresh();

  const universeRef = { tickers: [] as string[] };
  setInterval(async () => {
    const u = await getEquityUniverse().catch(() => null);
    if (u) universeRef.tickers = u.tickers;
  }, 60 * 60 * 1000);

  // Popular universeRef com o universo já carregado antes de iniciar catalisadores
  // (o setInterval acima só dispara após 1h — precisamos popular agora para o primeiro tick)
  const initialUniverse = await getEquityUniverse().catch(() => null);
  if (initialUniverse) universeRef.tickers = initialUniverse.tickers;
  await startEquityCatalystPoller(() => universeRef.tickers);

  function scheduleNext(): void {
    const delay = isMarketOpen() ? POLL_MS : OFFHOURS_MS;
    setTimeout(async () => {
      await tick().catch((e) => console.warn('[equityScreener] Tick failed:', e));
      scheduleNext();
    }, delay);
  }

  // Tick inicial
  await tick().catch((e) => console.warn('[equityScreener] Initial tick failed:', e));
  scheduleNext();

  console.log('[equityScreener] Poller started');
}

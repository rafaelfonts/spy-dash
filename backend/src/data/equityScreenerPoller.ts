// backend/src/data/equityScreenerPoller.ts
import { getTradierClient } from '../lib/tradierClient.js';
import { emitter } from '../data/marketState.js';
import { getEquityUniverse, scheduleWeeklyUniverseRefresh } from './equityUniverseService.js';
import { startEquityCatalystPoller, getCatalystTickers, getCatalystFirstSeenAt } from './equityCatalystPoller.js';
import { setEquityCandidates, DEFAULT_FILTERS } from './equityScreenerState.js';
import { getAdvancedMetricsSnapshot } from './advancedMetricsState.js';
import type { EquityCandidate } from './equityTypes.js';
import { checkEquityAlerts } from './alertEngine.js';
import { getDailyContext, startEquityDailyBarsCachePoll } from './equityDailyBarsCache.js';

const POLL_MS = 60_000;
const OFFHOURS_MS = 5 * 60_000;

// ── RVOL adaptativo (4b) ──────────────────────────────────────────────────────
// Histórico rolling de RVOL médio dos candidatos aprovados (max 10 entradas)
const RVOL_HISTORY_MAX = 10;
const RVOL_FLOOR = 1.2; // mínimo absoluto, independente do histórico
const rvolHistory: number[] = [];

function getAdaptiveRvolMin(): number {
  if (rvolHistory.length < 3) return DEFAULT_FILTERS.rvolMin;
  const sorted = [...rvolHistory].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  return Math.max(RVOL_FLOOR, p50);
}

// ── Decaimento de catalisador (4d) ────────────────────────────────────────────
// Peso máximo 25pts → decaimento linear até 0 em 4h (240min)
const CATALYST_DECAY_MINUTES = 240;

function catalystScore(symbol: string, hasCatalyst: boolean): number {
  if (!hasCatalyst) return 0;
  const firstSeen = getCatalystFirstSeenAt(symbol);
  if (firstSeen === null) return 25; // fallback conservador: score cheio
  const ageMin = (Date.now() - firstSeen) / 60_000;
  return Math.max(0, Math.round(25 * (1 - ageMin / CATALYST_DECAY_MINUTES)));
}

function isMarketOpen(): boolean {
  const now = new Date();
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const open = 14 * 60 + 15;  // 09:15 ET = 14:15 UTC
  const close = 20 * 60 + 15; // 16:15 ET = 21:15 UTC
  const day = now.getUTCDay();
  return day >= 1 && day <= 5 && utcMin >= open && utcMin <= close;
}

async function tick(): Promise<void> {
  // Verificar veto de regime SPY antes de qualquer processamento
  const metrics = getAdvancedMetricsSnapshot();
  if (metrics?.noTrade?.noTradeLevel === 'avoid') {
    const reasons = metrics.noTrade.activeVetos ?? [];
    const open = isMarketOpen();
    setEquityCandidates([], open);
    emitter.emit('equity-screener', {
      candidates: [],
      filters: DEFAULT_FILTERS,
      marketOpen: open,
      capturedAt: Date.now(),
      regimeVetoed: true,
      regimeVetoReasons: reasons,
    });
    console.log(`[equityScreener] Regime SPY adverso — screening suspenso (${reasons.length} vetos)`);
    return;
  }

  const universe = await getEquityUniverse();
  if (universe.tickers.length === 0) return;

  const quotes = await getTradierClient().getQuotes(universe.tickers).catch(() => []);
  if (quotes.length === 0) return;

  const catalysts = getCatalystTickers();
  const f = DEFAULT_FILTERS;
  const adaptiveRvolMin = getAdaptiveRvolMin();

  const equityRegimeState = metrics?.equityRegime ?? null;
  const maxCandidates = equityRegimeState?.maxCandidates ?? 20;
  const scoreThreshold = equityRegimeState?.scoreThresholds?.etf ?? 60;

  const scored = quotes
    .filter((q) => {
      const price = q.last ?? q.close ?? 0;
      const vol = q.volume ?? 0;
      const avgVol = q.average_volume ?? 0;
      if (avgVol === 0) return false;

      // Hard filters (Camada 0)
      if (price < f.priceMin) return false;
      if (f.priceMax !== null && price > f.priceMax) return false;
      if (vol < f.volumeMin) return false;

      // D1 filters (prefer daily data if available)
      const d1 = getDailyContext(q.symbol);
      if (d1) {
        // Z-score guard: reject over-extended moves
        if (Math.abs(d1.zScore20d) > 2.0) return false;
        // D1 RVOL floor
        if (d1.rvolD1 < RVOL_FLOOR) return false;
        // D1 daily change from close bars
        const bars = d1.bars;
        if (bars.length >= 2) {
          const d1Change = (bars[bars.length - 1].close - bars[bars.length - 2].close) / bars[bars.length - 2].close * 100;
          if (Math.abs(d1Change) < f.changeMin) return false;
        }
      } else {
        // Fallback to intraday RVOL when D1 cache not yet populated
        const rvol = vol / avgVol;
        if (rvol < adaptiveRvolMin) return false;
        const change = q.change_percentage ?? 0;
        if (change < f.changeMin) return false;
      }
      return true;
    })
    .map((q) => {
      const d1 = getDailyContext(q.symbol);
      const price = q.last ?? q.close ?? 0;
      const rvol = d1 ? d1.rvolD1 : Math.round(((q.volume ?? 0) / (q.average_volume ?? 1)) * 10) / 10;
      const hasCatalyst = catalysts.has(q.symbol);

      // Score components aligned with institutional spec
      const alignmentScore = d1
        ? (d1.alignment === 'bullish' ? 30 : d1.alignment === 'neutral' ? 12 : 0)
        : Math.min(rvol / 5, 1) * 30;

      const adxScore = d1
        ? (d1.adx14.adx >= 35 ? 20 : d1.adx14.adx >= 28 ? 16 : d1.adx14.adx >= 22 ? 12 : d1.adx14.adx >= 18 ? 7 : 0)
        : 0;

      const catScore = catalystScore(q.symbol, hasCatalyst);
      const zScorePos = d1 ? (Math.abs(d1.zScore20d) > 2 ? 0 : Math.abs(d1.zScore20d) <= 1.5 ? 5 : 3) : 3;
      const volScore = Math.min(rvol / 2, 1) * 10;

      const equityScore = Math.round(alignmentScore + adxScore + catScore + zScorePos + volScore);
      const changePct = d1 && d1.bars.length >= 2
        ? (d1.bars[d1.bars.length - 1].close - d1.bars[d1.bars.length - 2].close) / d1.bars[d1.bars.length - 2].close * 100
        : (q.change_percentage ?? 0);

      return {
        symbol: q.symbol,
        price,
        change: changePct,
        volume: q.volume ?? 0,
        rvol,
        hasCatalyst,
        lastUpdated: Date.now(),
        equityScore,
        isTopSetup: false,
        alignment: d1?.alignment,
        adx: d1 ? d1.adx14.adx : undefined,
        zScore: d1 ? d1.zScore20d : undefined,
      };
    });

  const candidates: EquityCandidate[] = scored
    .filter((c) => c.equityScore >= scoreThreshold * 0.8) // soft threshold for screener list
    .sort((a, b) => b.equityScore - a.equityScore)
    .slice(0, maxCandidates)
    .map((c, idx) => ({ ...c, isTopSetup: idx < 3 }));

  // 4b: Atualizar histórico de RVOL médio para próximos ciclos
  if (candidates.length > 0) {
    const avgRvol = candidates.reduce((sum, c) => sum + c.rvol, 0) / candidates.length;
    rvolHistory.push(Math.round(avgRvol * 10) / 10);
    if (rvolHistory.length > RVOL_HISTORY_MAX) rvolHistory.shift();
  }

  const open = isMarketOpen();
  setEquityCandidates(candidates, open);
  emitter.emit('equity-screener', { candidates, filters: f, marketOpen: open, capturedAt: Date.now(), equityRegime: equityRegimeState ?? null });

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

  // Start D1 bars cache — refreshes every 8h
  startEquityDailyBarsCachePoll(() => universeRef.tickers);

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

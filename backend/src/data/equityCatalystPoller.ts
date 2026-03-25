import { cacheGet, cacheSet } from '../lib/cacheStore.js';
import { CONFIG } from '../config.js';

const CATALYST_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function getTodayKey(): string {
  const d = new Date();
  return `equity:catalysts:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function isMarketHours(): boolean {
  const now = new Date();
  const h = now.getUTCHours() * 60 + now.getUTCMinutes();
  const open = 13 * 60;    // 08:00 ET = 13:00 UTC
  const close = 20 * 60 + 30; // 16:30 ET
  const day = now.getUTCDay();
  return day >= 1 && day <= 5 && h >= open && h <= close;
}

async function fetchCatalystsFromFinnhub(tickers: string[]): Promise<Set<string>> {
  const result = new Set<string>();

  // Finnhub company-news: scan for mentioned tickers in today's news
  // Use market news endpoint (general) — free tier
  try {
    const url = `https://finnhub.io/api/v1/news?category=general&token=${CONFIG.FINNHUB_API_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return result;
    const news: Array<{ headline: string; related?: string }> = await res.json();
    const tickerSet = new Set(tickers.map((t) => t.toUpperCase()));
    for (const article of news) {
      // Check if article headline or related field mentions any ticker
      const text = `${article.headline ?? ''} ${article.related ?? ''}`.toUpperCase();
      for (const ticker of tickerSet) {
        if (text.includes(ticker)) {
          result.add(ticker);
        }
      }
    }
  } catch {
    // Non-blocking — no catalysts if Finnhub fails
  }
  return result;
}

let catalystTickersCache: Set<string> = new Set();
let catalystFirstSeenAt: Map<string, number> = new Map(); // symbol → epoch ms quando detectado

export function getCatalystTickers(): Set<string> {
  return catalystTickersCache;
}

/** Retorna o epoch ms em que o catalisador foi detectado pela primeira vez hoje, ou null se não encontrado. */
export function getCatalystFirstSeenAt(symbol: string): number | null {
  return catalystFirstSeenAt.get(symbol) ?? null;
}

export async function startEquityCatalystPoller(getUniverse: () => string[]): Promise<void> {
  const POLL_INTERVAL = 60 * 60 * 1000; // 60min

  async function tick(): Promise<void> {
    if (!isMarketHours()) return;
    const tickers = getUniverse();
    if (tickers.length === 0) return;

    const key = getTodayKey();
    const cached = await cacheGet<string[]>(key);
    if (cached) {
      catalystTickersCache = new Set(cached);
      return;
    }

    const catalysts = await fetchCatalystsFromFinnhub(tickers);
    const now = Date.now();
    // Registrar firstSeenAt apenas para símbolos novos (não sobrescreve detecções anteriores)
    for (const sym of catalysts) {
      if (!catalystFirstSeenAt.has(sym)) {
        catalystFirstSeenAt.set(sym, now);
      }
    }
    catalystTickersCache = catalysts;
    await cacheSet(key, Array.from(catalysts), CATALYST_TTL_MS, 'equityCatalystPoller');
    console.log(`[equityCatalyst] Found ${catalysts.size} tickers with catalysts today`);
  }

  // Restore cache on startup (regardless of market hours)
  const restoreKey = getTodayKey();
  const restored = await cacheGet<string[]>(restoreKey).catch(() => null);
  if (restored) {
    catalystTickersCache = new Set(restored);
    // Restaurar firstSeenAt como startup time (timestamp conservador)
    const startupTs = Date.now();
    for (const sym of restored) {
      if (!catalystFirstSeenAt.has(sym)) {
        catalystFirstSeenAt.set(sym, startupTs);
      }
    }
    console.log(`[equityCatalyst] Restored ${restored.length} catalyst tickers from cache`);
  }

  // Initial tick (only runs during market hours)
  await tick().catch((e) => console.warn('[equityCatalyst] Initial tick failed:', e));
  setInterval(() => tick().catch((e) => console.warn('[equityCatalyst] Tick failed:', e)), POLL_INTERVAL);
}

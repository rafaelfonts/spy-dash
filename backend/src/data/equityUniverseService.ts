// backend/src/data/equityUniverseService.ts
import OpenAI from 'openai';
import { cacheGet, cacheSet } from '../lib/cacheStore.js';
import { getTradierClient } from '../lib/tradierClient.js';
import { EQUITY_SEED_TICKERS } from './equityUniverse.seed.js';
import type { EquityUniverse } from './equityTypes.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const UNIVERSE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

function getWeekKey(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getUTCDay() + 1) / 7);
  return `equity:universe:${year}-W${String(week).padStart(2, '0')}`;
}

async function fetchAISuggestions(): Promise<string[]> {
  const prompt = `List exactly 50 US-listed small cap stock tickers (NYSE/NASDAQ) that are currently trading between $2–$20 and have shown consistent momentum and liquidity in recent weeks. Focus on sectors with high retail activity: AI/tech, crypto mining, biotech, EV, fintech. Return ONLY a JSON array of ticker symbols, no explanation. Example: ["SOUN","BBAI","MARA"]`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 300,
    });
    const content = response.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(content);
    // Accept array at root or under any key
    const arr = Array.isArray(parsed) ? parsed : Object.values(parsed).find(Array.isArray);
    if (!Array.isArray(arr)) return [];
    return (arr as string[]).filter((t) => typeof t === 'string' && /^[A-Z]{1,5}$/.test(t));
  } catch {
    console.warn('[equityUniverse] AI suggestion fetch failed, using seed only');
    return [];
  }
}

async function validateWithTradier(candidates: string[]): Promise<string[]> {
  if (candidates.length === 0) return [];
  try {
    const quotes = await getTradierClient().getQuotes(candidates);
    return quotes
      .filter((q) => {
        const price = q.last ?? q.close ?? 0;
        return price >= 2 && price <= 20;
      })
      .map((q) => q.symbol);
  } catch {
    console.warn('[equityUniverse] Tradier validation failed, returning unvalidated list');
    return candidates;
  }
}

export async function buildEquityUniverse(): Promise<EquityUniverse> {
  const aiTickers = await fetchAISuggestions();
  const merged = Array.from(new Set([...EQUITY_SEED_TICKERS, ...aiTickers]));
  const validated = await validateWithTradier(merged);

  const universe: EquityUniverse = {
    tickers: validated,
    generatedAt: new Date().toISOString(),
    seedCount: EQUITY_SEED_TICKERS.filter((t) => validated.includes(t)).length,
    aiCount: aiTickers.filter((t) => validated.includes(t) && !EQUITY_SEED_TICKERS.includes(t)).length,
  };

  const key = getWeekKey();
  await cacheSet(key, universe, UNIVERSE_TTL_MS, 'equityUniverseService');
  console.log(`[equityUniverse] Universe built: ${validated.length} tickers (seed: ${universe.seedCount}, ai: ${universe.aiCount})`);
  return universe;
}

export async function getEquityUniverse(): Promise<EquityUniverse> {
  const key = getWeekKey();
  const cached = await cacheGet<EquityUniverse>(key);
  if (cached) return cached;
  return buildEquityUniverse();
}

export function scheduleWeeklyUniverseRefresh(): void {
  // Check every hour, rebuild on Monday before 09:00 ET if not yet built this week
  setInterval(async () => {
    const now = new Date();
    const dayUTC = now.getUTCDay(); // 0=Sun, 1=Mon
    const hourET = now.getUTCHours() - 5; // aproximado (ignora DST por simplicidade)
    if (dayUTC === 1 && hourET >= 7 && hourET < 9) {
      const key = getWeekKey();
      const cached = await cacheGet<EquityUniverse>(key);
      if (!cached) {
        console.log('[equityUniverse] Monday refresh triggered');
        await buildEquityUniverse();
      }
    }
  }, 60 * 60 * 1000);
}

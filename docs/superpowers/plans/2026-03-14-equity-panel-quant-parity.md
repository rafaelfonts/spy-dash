# Equity Panel Quant Parity Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Ações panel to full quantitative parity with SPY analysis by adding local technical indicators, Tavily tool calling, pgvector memory, and an equity regime score.

**Architecture:** A new set of pure-function backend modules (`equityTechnicals`, `equityRegimeScorer`, `equityMemory`, `equityNewsDigest`) feeds a refactored `equityAnalyze.ts` handler that now uses tool calling, injects 7 data blocks into the prompt, and persists results to a new `equity_analyses` Supabase table. The screener gains a composite score, and the frontend `EquityAIAnalysis` card is rewritten to display the richer output.

**Tech Stack:** Fastify 4, TypeScript, OpenAI gpt-4o (tool calling + JSON schema), Tavily REST API, Supabase pgvector (HNSW), Redis (ioredis), Tradier API, React 18, Zustand

---

## Chunk 1: Database Migration + New Type Definitions

### Task 1: Supabase migration for `equity_analyses`

**Files:**
- Create: `supabase/migrations/20260314000001_equity_analyses.sql`

- [ ] **Step 1: Write migration**

```sql
-- supabase/migrations/20260314000001_equity_analyses.sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS equity_analyses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol          TEXT NOT NULL,
  summary         TEXT,
  full_text       TEXT,
  embedding       vector(1536),
  market_snapshot JSONB,
  structured_output JSONB,
  analysis_date   DATE DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE equity_analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own equity analyses"
  ON equity_analyses FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX ON equity_analyses
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE OR REPLACE FUNCTION search_equity_analyses(
  query_embedding vector(1536),
  p_user_id       UUID,
  p_symbol        TEXT,
  similarity_threshold FLOAT DEFAULT 0.5,
  match_count     INT DEFAULT 5
)
RETURNS TABLE (
  id          UUID,
  summary     TEXT,
  similarity  FLOAT,
  created_at  TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ea.id,
    ea.summary,
    1 - (ea.embedding <=> query_embedding) AS similarity,
    ea.created_at
  FROM equity_analyses ea
  WHERE ea.user_id = p_user_id
    AND ea.symbol  = p_symbol
    AND 1 - (ea.embedding <=> query_embedding) >= similarity_threshold
  ORDER BY ea.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```

- [ ] **Step 2: Apply migration locally**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash"
supabase db push
```

Expected: Migration applied without errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260314000001_equity_analyses.sql
git commit -m "chore(db): adiciona tabela equity_analyses com pgvector + RLS + HNSW"
```

---

### Task 2: Add `AnalysisStructuredEquity` type to `market.ts`

**Files:**
- Modify: `backend/src/types/market.ts`
- Modify: `frontend/src/store/marketStore.ts`

- [ ] **Step 1: Add backend type**

Open `backend/src/types/market.ts` and append at the end of the file:

```typescript
// ---------- Equity Analysis ----------

export interface EquityTechnicals {
  rsi: number | null
  rsiZone: 'oversold' | 'neutral' | 'overbought'
  macd: { value: number; signal: number; histogram: number } | null
  macdCross: 'bullish' | 'bearish' | 'none'
  bb: { upper: number; middle: number; lower: number } | null
  bbPercentB: number | null
  bbBandwidth: number | null
  vwap: number | null
  trend: 'uptrend' | 'downtrend' | 'sideways'
}

export interface EquityRegimeComponents {
  rsi: number        // 0–2
  macd: number       // 0–2
  bb: number         // 0–2
  catalyst: number   // 0–2
  spyAlignment: number // 0–2
}

export interface AnalysisStructuredEquity {
  symbol: string
  setup: string
  entry_range: string
  target: string
  stop: string
  risk_reward: string
  confidence: 'ALTA' | 'MÉDIA' | 'BAIXA'
  warning: string | null
  // Quantitative additions
  equity_regime_score: number             // 0–10, integer
  rsi_zone: 'oversold' | 'neutral' | 'overbought'
  trend: 'uptrend' | 'downtrend' | 'sideways'
  catalyst_confirmed: boolean
  timeframe: '1d' | '2d' | '3-5d'
  invalidation_level: number | null
  key_levels: { support: number[]; resistance: number[] }
  trade_signal: 'trade' | 'wait' | 'avoid'
  no_trade_reasons: string[]
}
```

- [ ] **Step 2: Update frontend store — replace `EquityAnalysis` with `AnalysisStructuredEquity`**

In `frontend/src/store/marketStore.ts`:

1. Find and **delete** the `EquityAnalysis` interface (lines ~295–304):
   ```typescript
   export interface EquityAnalysis {
     symbol: string
     setup: string
     entry_range: string
     target: string
     stop: string
     risk_reward: string
     confidence: 'ALTA' | 'MÉDIA' | 'BAIXA'
     warning: string | null
   }
   ```

2. **Add** the new interface in its place (same location):
   ```typescript
   export interface AnalysisStructuredEquity {
     symbol: string
     setup: string
     entry_range: string
     target: string
     stop: string
     risk_reward: string
     confidence: 'ALTA' | 'MÉDIA' | 'BAIXA'
     warning: string | null
     equity_regime_score: number
     rsi_zone: 'oversold' | 'neutral' | 'overbought'
     trend: 'uptrend' | 'downtrend' | 'sideways'
     catalyst_confirmed: boolean
     timeframe: '1d' | '2d' | '3-5d'
     invalidation_level: number | null
     key_levels: { support: number[]; resistance: number[] }
     trade_signal: 'trade' | 'wait' | 'avoid'
     no_trade_reasons: string[]
   }
   ```

3. Update all references from `EquityAnalysis` to `AnalysisStructuredEquity` in this file:
   - `equityAnalysis: EquityAnalysis | null` → `equityAnalysis: AnalysisStructuredEquity | null`
   - `equityAnalysis: null as EquityAnalysis | null` → `equityAnalysis: null as AnalysisStructuredEquity | null`
   - `setEquityAnalysis: (a: EquityAnalysis | null) => void` → `setEquityAnalysis: (a: AnalysisStructuredEquity | null) => void`

- [ ] **Step 3: Compile check**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/frontend"
npx tsc --noEmit 2>&1 | head -40
```

Expected: No errors related to `EquityAnalysis`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/types/market.ts frontend/src/store/marketStore.ts
git commit -m "feat(types): adiciona AnalysisStructuredEquity substituindo EquityAnalysis"
```

---

## Chunk 2: Pure Backend Modules

### Task 3: `equityNewsDigest.ts` — swing-trade news digest

**Files:**
- Create: `backend/src/lib/equityNewsDigest.ts`

- [ ] **Step 1: Create the module**

```typescript
// backend/src/lib/equityNewsDigest.ts
import OpenAI from 'openai'
import { CONFIG } from '../config.js'
import type { TavilyResult } from './tavilyClient.js'

const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY })

/**
 * Adapts buildNewsDigest for equity swing trade context.
 * Unlike the SPY version (which focuses on SPY options), this focuses on 1-5 day
 * impact on the individual ticker. Uses OpenAI SDK (same pattern as analysisMemory.ts).
 */
export async function buildEquityNewsDigest(
  results: TavilyResult[],
  symbol: string,
  reason: string,
): Promise<string | null> {
  if (results.length === 0) return null

  const snippets = results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.content}`)
    .join('\n\n')

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content:
            `Você é um analista de swing trade. Resuma os snippets abaixo em no máximo 80 palavras, ` +
            `focando no impacto direto para uma operação de 1–5 dias em ${symbol}. Seja objetivo e direto.`,
        },
        {
          role: 'user',
          content: `Motivo da busca: ${reason}\n\nSnippets:\n${snippets}`,
        },
      ],
    })
    return res.choices[0]?.message?.content ?? null
  } catch (err) {
    console.warn('[equityNewsDigest] gpt-4o-mini falhou, usando fallback:', (err as Error).message)
    return `[FONTE EXTERNA — conteúdo não verificado]: ${results[0].content.slice(0, 150)}`
  }
}
```

- [ ] **Step 2: Compile check**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/backend"
npx tsc --noEmit 2>&1 | grep equityNewsDigest
```

Expected: No output (no errors).

- [ ] **Step 3: Commit**

```bash
git add backend/src/lib/equityNewsDigest.ts
git commit -m "feat(equity): cria equityNewsDigest com prompt calibrado para swing trade"
```

---

### Task 4: `equityTechnicals.ts` — RSI/MACD/BBands/VWAP

**Files:**
- Create: `backend/src/lib/equityTechnicals.ts`

This module reuses the calculation functions already present in `backend/src/data/technicalIndicatorsPoller.ts` (lines 25–95: `calcRSI`, `calcEMA`, `calcMACD`, `calcBBands`). Those functions are **not exported** today. We need to either export them or duplicate the logic. The cleanest approach: **extract** them into a shared `backend/src/lib/technicalCalcs.ts` that both the poller and the new module import.

- [ ] **Step 1: Extract calculation functions into `technicalCalcs.ts`**

Create `backend/src/lib/technicalCalcs.ts`:

```typescript
// backend/src/lib/technicalCalcs.ts
// Pure calculation functions — copied exactly from technicalIndicatorsPoller.ts.
// No side effects, no imports from project modules.

/**
 * RSI com suavização de Wilder (EMA fator 1/period).
 * Requer prices.length >= period*2 para warm-up correto.
 * Retorna 50 (neutro) quando série é muito curta ou completamente flat.
 */
export function calcRSI(prices: number[], period = 14): number {
  if (prices.length < period * 2) return 50

  // Fase 1: semente via média simples dos primeiros `period` deltas
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1]
    if (diff > 0) avgGain += diff
    else avgLoss += Math.abs(diff)
  }
  avgGain /= period
  avgLoss /= period

  // Fase 2: EMA de Wilder para o restante da série
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period
  }

  if (avgGain === 0 && avgLoss === 0) return 50  // flat market → neutral
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

export function calcEMA(prices: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const ema: number[] = [prices[0]]
  for (let i = 1; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[i - 1] * (1 - k))
  }
  return ema
}

export function calcMACD(prices: number[]): {
  value: number; signal: number; histogram: number
  crossover: 'bullish' | 'bearish' | 'none'
} | null {
  if (prices.length < 35) return null
  const ema12 = calcEMA(prices, 12)
  const ema26 = calcEMA(prices, 26)
  const macdLine = ema12.map((v, i) => v - ema26[i])
  // Use the FULL macdLine for the signal EMA — NOT just the last 9 elements
  const signalLine = calcEMA(macdLine, 9)
  const macdVal = macdLine[macdLine.length - 1]
  const signalVal = signalLine[signalLine.length - 1]
  const histNow = macdVal - signalVal
  const histPrev = macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2]
  const crossover: 'bullish' | 'bearish' | 'none' =
    histPrev <= 0 && histNow > 0 ? 'bullish'
    : histPrev >= 0 && histNow < 0 ? 'bearish'
    : 'none'
  return { value: macdVal, signal: signalVal, histogram: histNow, crossover }
}

/**
 * Returns null when stdDev === 0 (flat prices — e.g. market closed).
 * IMPORTANT: the caller (technicalIndicatorsPoller tick) must handle null:
 * replace `const bbFlat = bbands.upper === bbands.lower` with `if (!bbands) { bbFlat = true }`.
 */
export function calcBBands(prices: number[], period = 20): {
  upper: number; middle: number; lower: number
  percentB: number | null; bandwidth: number | null
} | null {
  const slice = prices.slice(-period)
  if (slice.length < period) return null
  const middle = slice.reduce((a, b) => a + b, 0) / period
  const variance = slice.reduce((acc, p) => acc + (p - middle) ** 2, 0) / period
  const stdDev = Math.sqrt(variance)
  if (stdDev === 0) return null
  const upper = middle + 2 * stdDev
  const lower = middle - 2 * stdDev
  const lastPrice = prices[prices.length - 1]
  const percentB = (lastPrice - lower) / (upper - lower)
  const bandwidth = (upper - lower) / middle
  return { upper, middle, lower, percentB, bandwidth }
}
```

- [ ] **Step 2: Update `technicalIndicatorsPoller.ts` to import from `technicalCalcs.ts`**

In `backend/src/data/technicalIndicatorsPoller.ts`:

1. Add import at the top (after existing imports):
   ```typescript
   import { calcRSI, calcEMA, calcMACD, calcBBands } from '../lib/technicalCalcs.js'
   ```

2. Delete the 4 local function bodies **only**: `calcRSI` (lines 25–49), `calcEMA` (lines 51–58), `calcMACD` (lines 60–80), `calcBBands` (lines 82–91).

3. **Do NOT move or delete `deriveBBPosition`** (lines 97–109) — it stays in the poller because it is exported and used by `openai.ts`.

4. Update the `tick()` function to handle `calcBBands` returning `null` (since the new version returns `null` when flat, instead of `{ upper:0, lower:0, middle:0 }`). Replace the `bbFlat` check:
   ```typescript
   // BEFORE:
   const bbFlat = bbands.upper === bbands.lower

   // AFTER:
   const bbFlat = !bbands || bbands.upper === bbands.lower
   ```
   Also update the `bbPercentB` and `bbBandwidth` lines to guard against `null bbands`:
   ```typescript
   const bbPercentB =
     bbFlat || currentPrice == null || !bbands
       ? null
       : (currentPrice - bbands.lower) / (bbands.upper - bbands.lower)
   const bbBandwidth = bbFlat || !bbands ? null : (bbands.upper - bbands.lower) / bbands.middle * 100
   ```
   `calcBBands` returns `{ upper, middle, lower, percentB, bandwidth } | null` (no `position` field).
   `TechnicalData['bbands']` (consumed by `publishTechnicalData`) requires `{ upper, middle, lower, position }`.
   They must be kept as separate variables — do NOT try to use the raw calcBBands result directly as `bbands`:

   ```typescript
   // resultado cru de technicalCalcs.ts (sem position, pode ser null)
   const bbResult = calcBBands(prices)
   const bbFlat = !bbResult || bbResult.upper === bbResult.lower

   // objeto TechnicalData['bbands'] exigido por publishTechnicalData (nunca null, tem position)
   const bbands: TechnicalData['bbands'] = bbResult
     ? { upper: bbResult.upper, middle: bbResult.middle, lower: bbResult.lower, position: 'middle' }
     : { upper: 0, middle: 0, lower: 0, position: 'middle' }

   // bbPercentB e bbBandwidth vêm do bbResult (não do bbands que perdeu esses campos)
   const bbPercentB =
     bbFlat || currentPrice == null ? null
     : (currentPrice - bbands.lower) / (bbands.upper - bbands.lower)
   const bbBandwidth = bbFlat ? null : (bbands.upper - bbands.lower) / bbands.middle * 100
   ```

   The `bbands.position = deriveBBPosition(...)` assignment below stays unchanged — it overwrites `'middle'`.

- [ ] **Step 3: Create `equityTechnicals.ts`**

```typescript
// backend/src/lib/equityTechnicals.ts
import { calcRSI, calcMACD, calcBBands } from './technicalCalcs.js'
import type { EquityTechnicals } from '../types/market.js'

export interface TradierBar {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export function computeEquityTechnicals(bars: TradierBar[]): EquityTechnicals {
  const prices = bars.map((b) => b.close)

  // RSI
  const rsiRaw = prices.length >= 28 ? calcRSI(prices, 14) : null
  const rsiZone: EquityTechnicals['rsiZone'] =
    rsiRaw == null ? 'neutral'
    : rsiRaw < 30 ? 'oversold'
    : rsiRaw > 70 ? 'overbought'
    : 'neutral'

  // MACD
  const macdResult = prices.length >= 35 ? calcMACD(prices) : null
  const macdCross: EquityTechnicals['macdCross'] =
    macdResult?.crossover === 'bullish' ? 'bullish'
    : macdResult?.crossover === 'bearish' ? 'bearish'
    : 'none'
  const macd = macdResult
    ? { value: macdResult.value, signal: macdResult.signal, histogram: macdResult.histogram }
    : null

  // BBands
  const bbResult = prices.length >= 20 ? calcBBands(prices, 20) : null
  const bb = bbResult
    ? { upper: bbResult.upper, middle: bbResult.middle, lower: bbResult.lower }
    : null

  // VWAP intraday
  let vwap: number | null = null
  const totalVolume = bars.reduce((s, b) => s + b.volume, 0)
  if (totalVolume > 0) {
    const pvSum = bars.reduce((s, b) => s + (b.high + b.low + b.close) / 3 * b.volume, 0)
    vwap = pvSum / totalVolume
  }

  // Trend: based on last 10 closes vs first 10 closes
  let trend: EquityTechnicals['trend'] = 'sideways'
  if (prices.length >= 20) {
    const recent = prices.slice(-10).reduce((s, p) => s + p, 0) / 10
    const earlier = prices.slice(-20, -10).reduce((s, p) => s + p, 0) / 10
    const pctDiff = (recent - earlier) / earlier
    if (pctDiff > 0.002) trend = 'uptrend'
    else if (pctDiff < -0.002) trend = 'downtrend'
  }

  console.log(
    `[equityTechnicals] RSI=${rsiRaw?.toFixed(1) ?? 'N/A'} MACD=${macdCross} BB=%B=${bbResult?.percentB?.toFixed(2) ?? 'N/A'} trend=${trend}`
  )

  return {
    rsi: rsiRaw,
    rsiZone,
    macd,
    macdCross,
    bb,
    bbPercentB: bbResult?.percentB ?? null,
    bbBandwidth: bbResult?.bandwidth ?? null,
    vwap,
    trend,
  }
}
```

- [ ] **Step 4: Compile check**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/backend"
npx tsc --noEmit 2>&1 | head -30
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/technicalCalcs.ts backend/src/lib/equityTechnicals.ts backend/src/data/technicalIndicatorsPoller.ts
git commit -m "feat(equity): extrai cálculos técnicos para technicalCalcs.ts + cria equityTechnicals"
```

---

### Task 5: `equityRegimeScorer.ts` — composite 0–10 score

**Files:**
- Create: `backend/src/lib/equityRegimeScorer.ts`

- [ ] **Step 1: Create the module**

```typescript
// backend/src/lib/equityRegimeScorer.ts
import { getAdvancedMetricsSnapshot } from '../data/advancedMetricsState.js'
import type { EquityTechnicals, EquityRegimeComponents } from '../types/market.js'

interface ScoreInput {
  technicals: EquityTechnicals
  hasCatalyst: boolean       // from Finnhub
  tavilyConfirmed: boolean   // true if Tavily returned ≥1 result (set after tool call)
}

interface EquityRegimeResult {
  score: number
  components: EquityRegimeComponents
}

export function scoreEquityRegime(input: ScoreInput): EquityRegimeResult {
  const { technicals, hasCatalyst, tavilyConfirmed } = input

  // Component 1: RSI zone (0–2)
  const rsiScore =
    technicals.rsiZone === 'oversold' ? 2
    : technicals.rsiZone === 'neutral' && (technicals.rsi ?? 50) < 50 ? 1
    : 0

  // Component 2: MACD (0–2)
  const macdScore =
    technicals.macdCross === 'bullish' ? 2
    : technicals.macd && technicals.macd.histogram > 0 ? 1
    : 0

  // Component 3: BB %B position (0–2)
  const bbPct = technicals.bbPercentB
  const bbScore =
    bbPct !== null && bbPct < 0.2 ? 2
    : bbPct !== null && bbPct < 0.5 ? 1
    : 0

  // Component 4: Catalyst quality (0–2)
  const catalystScore = tavilyConfirmed ? 2 : hasCatalyst ? 1 : 0

  // Component 5: SPY alignment (0–2)
  let spyScore = 1  // default: neutral
  const snap = getAdvancedMetricsSnapshot()
  if (snap?.regimePreview) {
    const spyRegimeScore = snap.regimePreview.score ?? 0
    const spyBullish = spyRegimeScore >= 6
    const spyBearish = spyRegimeScore <= 3
    if (spyBullish) spyScore = 2
    else if (spyBearish) spyScore = 0
  }

  const raw = rsiScore + macdScore + bbScore + catalystScore + spyScore
  const score = Math.max(0, Math.min(10, raw))

  console.log(
    `[equityRegime] score=${score} components={rsi:${rsiScore}, macd:${macdScore}, bb:${bbScore}, catalyst:${catalystScore}, spy:${spyScore}}`
  )

  return {
    score,
    components: { rsi: rsiScore, macd: macdScore, bb: bbScore, catalyst: catalystScore, spyAlignment: spyScore },
  }
}
```

- [ ] **Step 2: Compile check**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/backend"
npx tsc --noEmit 2>&1 | grep equityRegime
```

Expected: No output.

- [ ] **Step 3: Commit**

```bash
git add backend/src/lib/equityRegimeScorer.ts
git commit -m "feat(equity): cria equityRegimeScorer com score 0-10 (RSI/MACD/BB/catalyst/SPY)"
```

---

### Task 6: `equityMemory.ts` — pgvector memory for equity analyses

**Files:**
- Create: `backend/src/data/equityMemory.ts`

- [ ] **Step 1: Create the module**

```typescript
// backend/src/data/equityMemory.ts
// Mirrors analysisMemory.ts but scoped to individual equity symbols.
import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'
import type { AnalysisStructuredEquity } from '../types/market.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

interface EquityMarketSnapshot {
  price: number
  change: number
  rsi: number | null
  volume: number
  equityRegimeScore: number
}

async function generateEquityCompactSummary(
  fullText: string,
  structured: AnalysisStructuredEquity | null,
  symbol: string,
): Promise<string> {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 120,
      messages: [{
        role: 'user',
        content: [
          `Crie um resumo compacto desta análise de swing trade em ${symbol} em 1-2 frases (máx 80 palavras).`,
          'Inclua: bias direcional, setup, entrada, alvo, stop, resultado se houver.',
          '',
          '--- ANÁLISE ---',
          fullText.slice(0, 2000),
          '',
          '--- STRUCTURED ---',
          structured ? JSON.stringify(structured) : '{}',
        ].join('\n'),
      }],
    })
    return (res.choices[0].message.content?.trim() ?? '').slice(0, 400)
  } catch (err) {
    console.error('[equityMemory] generateCompactSummary failed:', (err as Error).message)
    return ''
  }
}

export async function saveEquityAnalysis(
  userId: string,
  symbol: string,
  fullText: string,
  structured: AnalysisStructuredEquity | undefined,
  marketSnapshot: EquityMarketSnapshot,
): Promise<void> {
  try {
    const summary = await generateEquityCompactSummary(fullText, structured ?? null, symbol)

    const embRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: summary || fullText.slice(0, 1000),
    })
    const embedding = embRes.data[0].embedding

    await supabase.from('equity_analyses').insert({
      user_id: userId,
      symbol,
      summary,
      full_text: fullText,
      embedding,
      market_snapshot: marketSnapshot,
      structured_output: structured ?? null,
      analysis_date: new Date().toISOString().slice(0, 10),
    })

    console.log(`[equityMemory] Salvo: user=${userId} symbol=${symbol} regime=${marketSnapshot.equityRegimeScore}`)
  } catch (err) {
    console.error('[equityMemory] saveEquityAnalysis failed:', (err as Error).message)
    // Non-blocking: memory failure must not block the main analysis response
  }
}

interface EquityMemoryRow {
  id: string
  summary: string
  market_snapshot: EquityMarketSnapshot
  structured_output: AnalysisStructuredEquity | null
  created_at: string
}

async function getRecentEquityAnalyses(
  userId: string,
  symbol: string,
  limit = 2,
): Promise<EquityMemoryRow[]> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await supabase
      .from('equity_analyses')
      .select('id, summary, market_snapshot, structured_output, created_at')
      .eq('user_id', userId)
      .eq('symbol', symbol)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error || !data) return []
    return data as EquityMemoryRow[]
  } catch {
    return []
  }
}

async function searchSimilarEquityAnalyses(
  userId: string,
  symbol: string,
  queryText: string,
  excludeIds: string[],
): Promise<Array<{ id: string; summary: string; created_at: string; similarity: number }>> {
  try {
    const embRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: queryText.slice(0, 8000),
    })
    const queryEmbedding = embRes.data[0].embedding

    const { data, error } = await supabase.rpc('search_equity_analyses', {
      query_embedding: queryEmbedding,
      p_user_id: userId,
      p_symbol: symbol,
      similarity_threshold: 0.5,
      match_count: 5 + excludeIds.length,
    })

    if (error || !data) return []
    const exclude = new Set(excludeIds)
    return (data as Array<{ id: string; summary: string; created_at: string; similarity: number }>)
      .filter((r) => !exclude.has(r.id))
      .slice(0, 2)
  } catch (err) {
    console.error('[equityMemory] searchSimilarEquityAnalyses failed:', (err as Error).message)
    return []
  }
}

function fmtAge(isoDate: string): string {
  const ageMin = Math.floor((Date.now() - new Date(isoDate).getTime()) / 60_000)
  if (ageMin < 1) return 'agora'
  if (ageMin < 60) return `${ageMin}min atrás`
  const h = Math.floor(ageMin / 60)
  return h < 24 ? `${h}h atrás` : `${Math.floor(h / 24)}d atrás`
}

export async function buildEquityMemoryBlock(
  userId: string,
  symbol: string,
  rsi: number | null,
): Promise<string> {
  const recent = await getRecentEquityAnalyses(userId, symbol, 2)

  let block = `### MEMÓRIA — ${symbol}\n\n`

  if (recent.length === 0) {
    return block + `_Nenhuma análise anterior de ${symbol} disponível._\n`
  }

  block += `**Análises recentes (24h):**\n`
  for (const r of recent) {
    const snap = r.market_snapshot
    const regime = snap?.equityRegimeScore ?? '?'
    const signal = (r.structured_output as AnalysisStructuredEquity | null)?.trade_signal ?? 'N/A'
    block += `- [${fmtAge(r.created_at)}] Regime: ${regime}/10 | Signal: ${signal} | $${snap?.price?.toFixed(2) ?? '?'}\n`
    block += `  ${r.summary}\n\n`
  }

  // Semantic search when RSI is extreme (more relevant context)
  const shouldSearchSemantic = rsi !== null && (rsi < 30 || rsi > 70)
  if (shouldSearchSemantic) {
    const snap0 = recent[0].market_snapshot
    const queryText = `${symbol} rsi ${rsi?.toFixed(0)} regime ${snap0?.equityRegimeScore} price ${snap0?.price}`
    const similar = await searchSimilarEquityAnalyses(userId, symbol, queryText, recent.map((r) => r.id))
    if (similar.length > 0) {
      block += `**Situações similares passadas:**\n`
      for (const r of similar) {
        block += `- [${fmtAge(r.created_at)}] ${r.summary}\n`
      }
    }
  }

  return block
}
```

- [ ] **Step 2: Compile check**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/backend"
npx tsc --noEmit 2>&1 | grep equityMemory
```

Expected: No output.

- [ ] **Step 3: Commit**

```bash
git add backend/src/data/equityMemory.ts
git commit -m "feat(equity): cria equityMemory com pgvector + busca semântica por símbolo"
```

---

## Chunk 3: Refactor `equityAnalyze.ts`

### Task 7: Rewrite `equityAnalyze.ts` with all 7 blocks + tool calling

**Files:**
- Modify: `backend/src/api/equityAnalyze.ts`

- [ ] **Step 1: Rewrite the file**

Replace the entire content of `backend/src/api/equityAnalyze.ts`:

```typescript
// backend/src/api/equityAnalyze.ts
import type { FastifyInstance } from 'fastify'
import OpenAI from 'openai'
import { getTradierClient } from '../lib/tradierClient.js'
import { CONFIG } from '../config.js'
import { requireAuth } from '../hooks/authMiddleware.js'
import { computeEquityTechnicals } from '../lib/equityTechnicals.js'
import { scoreEquityRegime } from '../lib/equityRegimeScorer.js'
import { buildEquityMemoryBlock, saveEquityAnalysis } from '../data/equityMemory.js'
import { searchLiveNews } from '../lib/tavilyClient.js'
import { buildEquityNewsDigest } from '../lib/equityNewsDigest.js'
import { cacheGet, cacheSet } from '../lib/cacheStore.js'

const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY })

const TAVILY_CACHE_TTL_MS = 30 * 60 * 1000  // 30 min

const EQUITY_ANALYSIS_SCHEMA = {
  name: 'equity_analysis_output',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      symbol:              { type: 'string' },
      setup:               { type: 'string' },
      entry_range:         { type: 'string' },
      target:              { type: 'string' },
      stop:                { type: 'string' },
      risk_reward:         { type: 'string' },
      confidence:          { type: 'string', enum: ['ALTA', 'MÉDIA', 'BAIXA'] },
      warning:             { anyOf: [{ type: 'string' }, { type: 'null' }] },
      equity_regime_score: { type: 'integer', minimum: 0, maximum: 10 },
      rsi_zone:            { type: 'string', enum: ['oversold', 'neutral', 'overbought'] },
      trend:               { type: 'string', enum: ['uptrend', 'downtrend', 'sideways'] },
      catalyst_confirmed:  { type: 'boolean' },
      timeframe:           { type: 'string', enum: ['1d', '2d', '3-5d'] },
      invalidation_level:  { anyOf: [{ type: 'number' }, { type: 'null' }] },
      key_levels: {
        type: 'object',
        properties: {
          support:    { type: 'array', items: { type: 'number' } },
          resistance: { type: 'array', items: { type: 'number' } },
        },
        required: ['support', 'resistance'],
        additionalProperties: false,
      },
      trade_signal:    { type: 'string', enum: ['trade', 'wait', 'avoid'] },
      no_trade_reasons: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'symbol', 'setup', 'entry_range', 'target', 'stop', 'risk_reward',
      'confidence', 'warning', 'equity_regime_score', 'rsi_zone', 'trend',
      'catalyst_confirmed', 'timeframe', 'invalidation_level', 'key_levels',
      'trade_signal', 'no_trade_reasons',
    ],
    additionalProperties: false,
  },
}

async function getTavilyWithCache(
  symbol: string,
  query: string,
  reason: string,
): Promise<string | null> {
  const today = new Date().toISOString().slice(0, 10)
  const cacheKey = `tavily:equity:${symbol}:${today}`

  const cached = await cacheGet<string>(cacheKey)
  if (cached) {
    console.log(`[equityAnalyze] Tavily cache hit for ${symbol}`)
    return cached
  }

  const results = await searchLiveNews(query, 5)
  const digest = await buildEquityNewsDigest(results, symbol, reason)
  if (digest) {
    await cacheSet(cacheKey, digest, TAVILY_CACHE_TTL_MS, 'equityAnalyze:tavily')
  }
  return digest
}

async function buildEquityPrompt(
  symbol: string,
  userId: string,
): Promise<{ prompt: string; technicals: ReturnType<typeof computeEquityTechnicals>; hasCatalyst: boolean; price: number; change: number; volume: number }> {
  const tradier = getTradierClient()

  // [1] Quote + OHLCV
  const quotes = await tradier.getQuotes([symbol]).catch(() => [])
  const q = quotes[0]
  const price = q?.last ?? q?.close ?? 0
  const change = q?.change_percentage ?? 0
  const volume = q?.volume ?? 0
  const avgVol = q?.average_volume ?? 0
  const rvol = avgVol > 0 ? volume / avgVol : 0
  const quoteBlock = q
    ? `Preço: $${price.toFixed(2)} | Var: ${change.toFixed(2)}% | RVOL: ${rvol.toFixed(1)}x | Vol: ${volume.toLocaleString()} | AvgVol: ${avgVol.toLocaleString()}`
    : 'Cotação indisponível'

  // [2] Timesales — 30 bars (was 10)
  const timesales = await tradier.getTimeSales(symbol).catch(() => [])
  const bars30 = timesales.slice(-30)
  const priceBlock = bars30.length > 0
    ? bars30.map((t) => `${t.time}: $${t.close} (vol:${t.volume})`).join(' | ')
    : 'Histórico indisponível'

  // [3] Technical indicators
  const technicals = computeEquityTechnicals(bars30.map((b) => ({
    time: b.time,
    open: b.open ?? b.close,
    high: b.high ?? b.close,
    low: b.low ?? b.close,
    close: b.close,
    volume: b.volume ?? 0,
  })))

  const techBlock = [
    `RSI(14): ${technicals.rsi?.toFixed(1) ?? 'N/A'} [${technicals.rsiZone}]`,
    `MACD: ${technicals.macd ? `${technicals.macd.histogram.toFixed(3)} (${technicals.macdCross})` : 'N/A'}`,
    `BBands: ${technicals.bb ? `U:$${technicals.bb.upper.toFixed(2)} M:$${technicals.bb.middle.toFixed(2)} L:$${technicals.bb.lower.toFixed(2)} %B:${technicals.bbPercentB?.toFixed(2)}` : 'N/A'}`,
    `VWAP: ${technicals.vwap ? `$${technicals.vwap.toFixed(2)}` : 'N/A'}`,
    `Trend: ${technicals.trend}`,
  ].join(' | ')

  // [4] Equity regime score (pre-computed)
  const regimeResult = scoreEquityRegime({ technicals, hasCatalyst: false, tavilyConfirmed: false })

  // [5] Memory block
  const memoryBlock = await buildEquityMemoryBlock(userId, symbol, technicals.rsi).catch(() => `### MEMÓRIA — ${symbol}\n_Indisponível._\n`)

  // [6] Finnhub news
  let hasCatalyst = false
  let newsBlock = 'Notícias indisponíveis'
  try {
    const today = new Date().toISOString().split('T')[0]
    const res = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${today}&to=${today}&token=${CONFIG.FINNHUB_API_KEY}`,
      { signal: AbortSignal.timeout(5000) },
    )
    if (res.ok) {
      const news: Array<{ headline: string }> = await res.json()
      const headlines = news.slice(0, 3).map((n) => `- ${n.headline}`).join('\n')
      newsBlock = headlines || 'Sem notícias hoje'
      hasCatalyst = news.length > 0
    }
  } catch { /* ignora */ }

  const prompt = `Você é um analista quantitativo de swing trade. Analise ${symbol} para uma operação de 1–5 dias.

EQUITY REGIME SCORE: ${regimeResult.score}/10 (NÃO recalcule — use este valor em equity_regime_score)
Components: RSI:${regimeResult.components.rsi}/2 MACD:${regimeResult.components.macd}/2 BB:${regimeResult.components.bb}/2 Catalyst:${regimeResult.components.catalyst}/2 SPY:${regimeResult.components.spyAlignment}/2

=== DADOS DE MERCADO (${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/New_York' })} ET) ===
${quoteBlock}

=== INDICADORES TÉCNICOS ===
${techBlock}

=== HISTÓRICO DE PREÇO (últimas 30 barras 1min) ===
${priceBlock}

=== NOTÍCIAS HOJE ===
${newsBlock}

${memoryBlock}

=== INSTRUÇÕES ===
- setup: máx 2 frases em pt-BR descrevendo o setup
- entry_range: formato "$X.XX–$X.XX"
- target, stop, invalidation_level: preços numéricos em formato "$X.XX"
- risk_reward: formato "1.5:1"
- timeframe: informe "1d", "2d" ou "3-5d" conforme o setup
- equity_regime_score: USE O VALOR ${regimeResult.score} (já calculado acima)
- trade_signal: "trade" se regime≥6 e sem vetoes, "wait" se regime 4-5, "avoid" se regime≤3
- no_trade_reasons: lista de motivos caso trade_signal seja "wait" ou "avoid"

Use a tool search_equity_news se: (1) RVOL>${rvol > 2.5 ? 'JÁ ACIONADO — RVOL=' + rvol.toFixed(1) : '2.5 e sem catalisador claro'}, (2) variação≥5% sem explicação técnica, (3) earnings em ≤2 dias.`

  return { prompt, technicals, hasCatalyst, price, change, volume }
}

export async function registerEquityAnalyzeRoute(app: FastifyInstance): Promise<void> {
  app.post('/api/equity/analyze', { preHandler: requireAuth }, async (request, reply) => {
    const userId = (request as any).user.id as string

    const { symbol } = request.body as { symbol?: string }
    if (!symbol || typeof symbol !== 'string' || !/^[A-Z]{1,5}$/.test(symbol.trim().toUpperCase())) {
      return reply.status(400).send({ error: 'symbol inválido' })
    }
    const sym = symbol.trim().toUpperCase()

    const { prompt, technicals, hasCatalyst, price, change, volume } = await buildEquityPrompt(sym, userId)

    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [{
      type: 'function',
      function: {
        name: 'search_equity_news',
        description: `Search real-time news for ${sym}. Use when RVOL>2.5 without known catalyst, earnings ≤2 days, or price move ≥5% without clear technical explanation.`,
        parameters: {
          type: 'object',
          properties: {
            query:  { type: 'string', description: 'Search query, e.g. "AAPL earnings Q1 2026 guidance"' },
            reason: { type: 'string', description: 'Why this search was triggered' },
          },
          required: ['query', 'reason'],
          additionalProperties: false,
        },
      },
    }]

    let messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'user', content: prompt },
    ]

    let tavilyUsed = false
    let newsDigest: string | null = null

    // First call — may request tool
    let response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: 600,
    }).catch((e) => {
      console.error('[equityAnalyze] OpenAI first call failed:', e)
      return null
    })

    if (!response) return reply.status(500).send({ error: 'Falha na análise IA' })

    // Handle tool call
    const toolCall = response.choices[0]?.message?.tool_calls?.[0]
    if (toolCall?.function.name === 'search_equity_news') {
      const args = JSON.parse(toolCall.function.arguments) as { query: string; reason: string }
      console.log(`[equityAnalyze] Tool call: search_equity_news query="${args.query}"`)

      newsDigest = await getTavilyWithCache(sym, args.query, args.reason)
      tavilyUsed = true

      // Second call with tool result
      messages = [
        ...messages,
        response.choices[0].message,
        {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: newsDigest ?? 'Nenhuma notícia relevante encontrada.',
        },
      ]

      response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages,
        response_format: { type: 'json_schema', json_schema: EQUITY_ANALYSIS_SCHEMA },
        max_tokens: 600,
      }).catch((e) => {
        console.error('[equityAnalyze] OpenAI second call failed:', e)
        return null
      })

      if (!response) return reply.status(500).send({ error: 'Falha na análise IA (tool result)' })
    } else {
      // No tool call — re-call with json_schema response format
      response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages,
        response_format: { type: 'json_schema', json_schema: EQUITY_ANALYSIS_SCHEMA },
        max_tokens: 600,
      }).catch((e) => {
        console.error('[equityAnalyze] OpenAI json_schema call failed:', e)
        return null
      })
      if (!response) return reply.status(500).send({ error: 'Falha na análise IA' })
    }

    const content = response.choices[0]?.message?.content
    if (!content) return reply.status(500).send({ error: 'IA sem resposta' })

    let structured: any
    try {
      structured = JSON.parse(content)
    } catch {
      return reply.status(500).send({ error: 'Resposta da IA inválida' })
    }

    // Safety: override regime_score with pre-computed value
    const regimeResult = scoreEquityRegime({
      technicals,
      hasCatalyst,
      tavilyConfirmed: tavilyUsed,
    })
    structured.equity_regime_score = regimeResult.score

    // Persist to memory (non-blocking)
    const fullText = JSON.stringify(structured)
    saveEquityAnalysis(userId, sym, fullText, structured, {
      price,
      change,
      rsi: technicals.rsi,
      volume,
      equityRegimeScore: regimeResult.score,
    }).catch((e) => console.warn('[equityAnalyze] saveEquityAnalysis failed:', e))

    return reply.send(structured)
  })
}
```

- [ ] **Step 2: Compile check**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/backend"
npx tsc --noEmit 2>&1 | head -30
```

Expected: No errors.

- [ ] **Step 3: Start backend and test the endpoint**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/backend"
npm run dev &
sleep 4
# Test with a real symbol (requires auth token — check manually via curl or browser)
echo "Backend started — test /api/equity/analyze via frontend"
```

Expected: Backend starts without crashes. Check logs for `[equityTechnicals]` and `[equityRegime]` lines on analysis call.

- [ ] **Step 4: Commit**

```bash
git add backend/src/api/equityAnalyze.ts
git commit -m "feat(equity): refatora equityAnalyze com 7 blocos + tool calling Tavily + requireAuth + memória"
```

---

## Chunk 4: Screener Score + Frontend

### Task 8: Add `equityScore` to screener poller

**Files:**
- Modify: `backend/src/data/equityScreenerPoller.ts`
- Modify: `backend/src/data/equityTypes.ts` (add `equityScore` and `isTopSetup` fields)

- [ ] **Step 1: Update `equityTypes.ts` to add score fields**

Find `backend/src/data/equityTypes.ts` (or wherever `EquityCandidate` is defined) and add two fields:

```typescript
export interface EquityCandidate {
  symbol: string
  price: number
  change: number
  volume: number
  rvol: number
  hasCatalyst: boolean
  lastUpdated: number
  equityScore: number   // 0–100 composite score (NEW)
  isTopSetup: boolean   // true for top 3 by score (NEW)
}
```

- [ ] **Step 2: Add score computation in `equityScreenerPoller.ts`**

In the `.map()` chain that builds `EquityCandidate[]` (after the `.filter()` block), compute the score:

```typescript
.map((q) => {
  const price = q.last ?? q.close ?? 0
  const change = q.change_percentage ?? 0
  const vol = q.volume ?? 0
  const avgVol = q.average_volume ?? 1
  const rvol = vol / avgVol

  // RSI macro score: fetch last 28 closes from timesales if available
  // For screener (batch), we skip the API call and use rvolScore as proxy.
  // rsiMacroScore defaults to 0 when bars < 28 — documented fallback.
  const rsiMacroScore = 0

  const equityScore = Math.round(
    Math.min(rvol / 5, 1) * 30 +
    Math.min(Math.abs(change) / 10, 1) * 25 +
    (catalysts.has(q.symbol) ? 1 : 0) * 25 +
    rsiMacroScore * 20
  )

  return {
    symbol: q.symbol,
    price,
    change,
    volume: vol,
    rvol: Math.round(rvol * 10) / 10,
    hasCatalyst: catalysts.has(q.symbol),
    lastUpdated: Date.now(),
    equityScore,
    isTopSetup: false,  // set below after sort
  }
})
```

After sort and slice, mark top 3:

```typescript
const withScore = candidates.slice(0, 20)
withScore.forEach((c, i) => { c.isTopSetup = i < 3 })
```

- [ ] **Step 3: Update Zustand store frontend type to match**

In `frontend/src/store/marketStore.ts`, add `equityScore` and `isTopSetup` to `EquityCandidate`:

```typescript
export interface EquityCandidate {
  symbol: string
  price: number
  change: number
  volume: number
  rvol: number
  hasCatalyst: boolean
  lastUpdated: number
  equityScore: number
  isTopSetup: boolean
}
```

- [ ] **Step 4: Compile check**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/backend"
npx tsc --noEmit 2>&1 | head -20
cd "/Users/rafaelfontes/Documents/SPY Dash/frontend"
npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/data/equityTypes.ts backend/src/data/equityScreenerPoller.ts frontend/src/store/marketStore.ts
git commit -m "feat(screener): adiciona equityScore (0-100) e badge isTopSetup aos candidatos"
```

---

### Task 9: Rewrite `EquityAIAnalysis.tsx` with rich output

**Files:**
- Modify: `frontend/src/components/equity/EquityAIAnalysis.tsx`

- [ ] **Step 1: Rewrite the component**

Replace the entire content of `frontend/src/components/equity/EquityAIAnalysis.tsx`:

```tsx
// frontend/src/components/equity/EquityAIAnalysis.tsx
import { useMarketStore } from '../../store/marketStore'
import { supabase } from '../../lib/supabase'
import { getApiBase } from '../../lib/apiBase'

interface Props {
  onRegisterTrade: () => void
}

const SIGNAL_COLORS = {
  trade: 'text-[#00ff88] border-[#00ff88]/30',
  wait:  'text-yellow-400 border-yellow-400/30',
  avoid: 'text-red-400 border-red-400/30',
}
const SIGNAL_LABELS = { trade: 'OPERAR', wait: 'AGUARDAR', avoid: 'EVITAR' }

const REGIME_COLOR = (score: number) =>
  score >= 7 ? 'text-[#00ff88]' : score >= 4 ? 'text-yellow-400' : 'text-red-400'

const RSI_LABELS = { oversold: 'Sobrevendido', neutral: 'Neutro', overbought: 'Sobrecomprado' }
const RSI_COLORS = { oversold: 'text-[#00ff88]', neutral: 'text-text-secondary', overbought: 'text-red-400' }

const TREND_LABELS = { uptrend: '↑ Alta', downtrend: '↓ Baixa', sideways: '→ Lateral' }
const TREND_COLORS = { uptrend: 'text-[#00ff88]', downtrend: 'text-red-400', sideways: 'text-text-secondary' }

const CONFIDENCE_COLORS = {
  ALTA: 'bg-[#00ff88]/10 text-[#00ff88] border-[#00ff88]/30',
  MÉDIA: 'bg-yellow-400/10 text-yellow-400 border-yellow-400/30',
  BAIXA: 'bg-red-400/10 text-red-400 border-red-400/30',
}

export function EquityAIAnalysis({ onRegisterTrade }: Props) {
  const analysis = useMarketStore((s) => s.equityAnalysis)
  if (!analysis) return null

  const signalColor = SIGNAL_COLORS[analysis.trade_signal] ?? SIGNAL_COLORS.wait
  const signalLabel = SIGNAL_LABELS[analysis.trade_signal] ?? analysis.trade_signal

  return (
    <div id="equity-ai-analysis" className="rounded-lg border border-border-subtle bg-bg-card p-4 space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-text-primary">{analysis.symbol}</span>
          <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-bold ${signalColor}`}>
            {signalLabel}
          </span>
          {analysis.catalyst_confirmed && (
            <span className="text-xs text-text-muted" title="Catalisador confirmado">📰</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span>Regime</span>
          <span className={`font-num font-semibold ${REGIME_COLOR(analysis.equity_regime_score)}`}>
            {analysis.equity_regime_score}/10
          </span>
        </div>
      </div>

      {/* Technical row */}
      <div className="flex items-center gap-4 text-[11px] text-text-secondary">
        <span>
          RSI: <span className={RSI_COLORS[analysis.rsi_zone]}>{RSI_LABELS[analysis.rsi_zone]}</span>
        </span>
        <span>
          Trend: <span className={TREND_COLORS[analysis.trend]}>{TREND_LABELS[analysis.trend]}</span>
        </span>
        <span>
          Horizonte: <span className="text-text-primary">{analysis.timeframe}</span>
        </span>
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${CONFIDENCE_COLORS[analysis.confidence]}`}>
          {analysis.confidence}
        </span>
      </div>

      {/* Setup */}
      <p className="text-sm text-text-secondary leading-relaxed">{analysis.setup}</p>

      {/* Trade levels grid */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-text-muted">Entrada</span>
          <span className="font-num text-text-primary">{analysis.entry_range}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">Alvo</span>
          <span className="font-num text-[#00ff88]">{analysis.target}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">Stop</span>
          <span className="font-num text-red-400">{analysis.stop}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">R/R</span>
          <span className="font-num text-text-primary">{analysis.risk_reward}</span>
        </div>
        {analysis.invalidation_level != null && (
          <div className="flex justify-between col-span-2">
            <span className="text-text-muted">Invalidação</span>
            <span className="font-num text-red-400/80">${analysis.invalidation_level.toFixed(2)}</span>
          </div>
        )}
      </div>

      {/* Key levels */}
      {(analysis.key_levels.support.length > 0 || analysis.key_levels.resistance.length > 0) && (
        <div className="grid grid-cols-2 gap-4 text-[11px]">
          {analysis.key_levels.support.length > 0 && (
            <div>
              <span className="text-text-muted block mb-1">Suportes</span>
              <div className="flex flex-wrap gap-1">
                {analysis.key_levels.support.map((s) => (
                  <span key={s} className="font-num text-[#00ff88]/80">${s.toFixed(2)}</span>
                ))}
              </div>
            </div>
          )}
          {analysis.key_levels.resistance.length > 0 && (
            <div>
              <span className="text-text-muted block mb-1">Resistências</span>
              <div className="flex flex-wrap gap-1">
                {analysis.key_levels.resistance.map((r) => (
                  <span key={r} className="font-num text-red-400/80">${r.toFixed(2)}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* No-trade reasons */}
      {analysis.no_trade_reasons.length > 0 && (
        <div className="space-y-1">
          <span className="text-[10px] uppercase tracking-wide text-text-muted">Vetoes</span>
          <ul className="space-y-0.5">
            {analysis.no_trade_reasons.map((r, i) => (
              <li key={i} className="text-xs text-red-400/80">• {r}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Warning */}
      {analysis.warning && (
        <p className="text-xs text-yellow-400/80 border border-yellow-400/20 rounded px-2 py-1">
          ⚠ {analysis.warning}
        </p>
      )}

      {/* Register trade */}
      {analysis.trade_signal === 'trade' && (
        <button
          onClick={onRegisterTrade}
          className="w-full text-xs font-medium py-2 rounded border border-[#00ff88]/30 text-[#00ff88] hover:bg-[#00ff88]/10 transition-colors"
        >
          ✓ Registrar compra
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Compile check**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/frontend"
npx tsc --noEmit 2>&1 | head -30
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/equity/EquityAIAnalysis.tsx
git commit -m "feat(ui): reescreve EquityAIAnalysis com regime score, trade_signal, key_levels, vetoes"
```

---

### Task 10: Update `EquityScreenerPanel.tsx` with score column and Top Setup badge

**Files:**
- Modify: `frontend/src/components/equity/EquityScreenerPanel.tsx`

- [ ] **Step 1: Update the component**

In `frontend/src/components/equity/EquityScreenerPanel.tsx`:

1. Update **two places** that reference `EquityAnalysis`:
   - Line ~5: `import type { EquityAnalysis } from '../../store/marketStore'` → `import type { AnalysisStructuredEquity } from '../../store/marketStore'`
   - Line ~22: `const data: EquityAnalysis = await res.json()` → `const data: AnalysisStructuredEquity = await res.json()`
   Both must be updated together — leaving either one causes a TypeScript compile error.
2. Update the table to:
   - Sort candidates by `equityScore` descending (they already arrive sorted from backend, but sort client-side as safety)
   - Add a `Score` column header
   - Display `c.equityScore` in the score column
   - Show `⭐` badge before symbol when `c.isTopSetup === true`

Key changes to the table row:
```tsx
// In the table header, add:
<th className="text-right pr-2">Score</th>

// In each row, change symbol cell to:
<td className="font-mono text-xs">
  {c.isTopSetup && <span className="text-yellow-400 mr-1">⭐</span>}
  {c.symbol}
</td>

// Add score cell:
<td className="text-right pr-2 font-num text-xs text-text-secondary">{c.equityScore}</td>
```

- [ ] **Step 2: Compile check**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/frontend"
npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors.

- [ ] **Step 3: Start frontend and verify visually**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/frontend"
npm run dev
```

Open http://localhost:5173 → Ações tab → verify:
- Screener shows Score column
- Top 3 candidates have ⭐ badge
- Clicking "Analisar" shows the new EquityAIAnalysis card with regime score, trade_signal badge, key levels, vetoes

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/equity/EquityScreenerPanel.tsx
git commit -m "feat(ui): adiciona coluna Score e badge Top Setup ao EquityScreenerPanel"
```

---

## Chunk 5: Integration Testing + Deploy

### Task 11: End-to-end verification

- [ ] **Step 1: Start full stack**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash"
./start.sh
```

- [ ] **Step 2: Verify backend logs on analysis call**

Navigate to Ações tab, click Analisar on a candidate. Check terminal for:
```
[equityTechnicals] RSI=XX.X MACD=bullish|bearish|none BB=%B=X.XX trend=uptrend|downtrend|sideways
[equityRegime] score=X components={rsi:X, macd:X, bb:X, catalyst:X, spy:X}
[equityMemory] Salvo: user=... symbol=... regime=...
```

- [ ] **Step 3: Verify Supabase table**

Check Supabase dashboard → Table Editor → `equity_analyses` — confirm a new row was inserted with correct `user_id`, `symbol`, `embedding` (non-null vector), `structured_output`.

- [ ] **Step 4: Verify memory on second analysis**

Click Analisar for the same symbol again. Check backend logs for:
```
[equityMemory] N análises de TICKER encontradas
```
This log is emitted by `buildEquityMemoryBlock` in `equityMemory.ts` — **add it** to the function:
```typescript
// At the start of buildEquityMemoryBlock, after loading `recent`:
console.log(`[equityMemory] ${recent.length} análises de ${symbol} encontradas`)
```
Also verify the full prompt includes `### MEMÓRIA — SYMBOL` by checking backend console output.

- [ ] **Step 5: Verify Tavily tool call (if triggered)**

If a candidate with RVOL>2.5 is analyzed, check backend logs for:
```
[equityAnalyze] Tool call: search_equity_news query="..."
```
This is emitted by the handler in `equityAnalyze.ts`. The `[tavily]` log (from `tavilyClient.ts`) will also appear:
```
[tavily] query="..." results=N
```

- [ ] **Step 6: Compile TypeScript for both services**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/backend" && npx tsc --noEmit
cd "/Users/rafaelfontes/Documents/SPY Dash/frontend" && npx tsc --noEmit
```

Expected: Zero errors.

---

### Task 12: Deploy

- [ ] **Step 1: Commit any remaining changes**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash"
git status
# If any uncommitted files:
git add -A
git commit -m "chore: finaliza implementação equity panel quant parity"
```

- [ ] **Step 2: Deploy backend**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/backend"
fly deploy
```

Expected: Deployment succeeds. Check `fly logs` for startup sequence — no crashes.

- [ ] **Step 3: Deploy frontend**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/frontend"
vercel --prod --yes
```

Expected: Deployment URL printed. Verify Ações tab works at https://spy-dash-frontend.vercel.app

- [ ] **Step 4: Final smoke test in production**

1. Open https://spy-dash-frontend.vercel.app → Ações tab
2. Verify screener loads with Score column and ⭐ badges
3. Click Analisar on a candidate — verify EquityAIAnalysis card shows:
   - Regime score X/10
   - Trade signal (OPERAR / AGUARDAR / EVITAR)
   - Key levels grid
   - Timeframe badge
4. Done ✓

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `supabase/migrations/20260314000001_equity_analyses.sql` | Create | Table + RLS + HNSW + RPC |
| `backend/src/types/market.ts` | Modify | Add `AnalysisStructuredEquity`, `EquityTechnicals`, `EquityRegimeComponents` |
| `backend/src/lib/technicalCalcs.ts` | Create | Pure calc functions: `calcRSI`, `calcEMA`, `calcMACD`, `calcBBands` |
| `backend/src/lib/equityNewsDigest.ts` | Create | News digest with swing-trade prompt |
| `backend/src/lib/equityTechnicals.ts` | Create | `computeEquityTechnicals()` → RSI/MACD/BBands/VWAP |
| `backend/src/lib/equityRegimeScorer.ts` | Create | `scoreEquityRegime()` → 0–10 score |
| `backend/src/data/equityMemory.ts` | Create | `saveEquityAnalysis()`, `buildEquityMemoryBlock()` |
| `backend/src/data/technicalIndicatorsPoller.ts` | Modify | Import from `technicalCalcs.ts` instead of inline functions |
| `backend/src/api/equityAnalyze.ts` | Rewrite | 7 blocks + tool calling + requireAuth + persistence |
| `backend/src/data/equityTypes.ts` | Modify | Add `equityScore`, `isTopSetup` to `EquityCandidate` |
| `backend/src/data/equityScreenerPoller.ts` | Modify | Compute and assign `equityScore` + `isTopSetup` |
| `frontend/src/store/marketStore.ts` | Modify | Replace `EquityAnalysis` → `AnalysisStructuredEquity` + new `EquityCandidate` fields |
| `frontend/src/components/equity/EquityAIAnalysis.tsx` | Rewrite | Display regime score, signal, key levels, vetoes, timeframe |
| `frontend/src/components/equity/EquityScreenerPanel.tsx` | Modify | Score column, ⭐ badge, cast update |

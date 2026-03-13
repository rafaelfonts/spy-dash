# Web Search Tool — `search_live_news` Design Spec

**Date:** 2026-03-13
**Status:** Approved
**Author:** Claude Code (brainstorming session)

---

## Context

The SPY Dash AI agent already uses two on-demand tools (`fetch_24h_context`, `fetch_sec_filings`) to lazily fetch external data only when the model detects it is needed. The agent has access to rich quantitative data (GEX, P/C, RSI, MACD, regime score, RVOL, etc.) but has no visibility into live news or breaking events. This creates a blind spot: unexplained price/volume spikes during intraday trading may be driven by news the agent cannot see.

**Goal:** Add a third tool `search_live_news` that allows the AI to query Tavily Search API for real-time news when it detects an anomaly it cannot explain with internal data alone. Results are summarized by `gpt-4o-mini` before injection into the main analysis prompt, controlling token cost and latency.

---

## Approach

**Chosen:** Tool-based on-demand search (Approach A) — mirrors the existing `fetch_24h_context` and `fetch_sec_filings` pattern exactly.

**Rejected alternatives:**
- Background poller (Approach B): continuous Tavily API cost; no contextual query
- Hybrid poller + tool (Approach C): double cost and complexity for marginal gain

---

## Architecture

### New Files

#### `backend/src/lib/tavilyClient.ts`
```typescript
export interface TavilyResult {
  title: string
  url: string
  content: string
  score: number
  published_date?: string
}

export async function searchLiveNews(
  query: string,
  maxResults = 5
): Promise<TavilyResult[]>
```

- **Endpoint:** `POST https://api.tavily.com/search`
- **Auth:** `CONFIG.TAVILY_API_KEY` (added to `backend/src/config.ts` — see Modified Files)
- **Parameters:**
  ```json
  {
    "query": "<dynamic>",
    "max_results": 5,
    "search_depth": "basic",
    "include_domains": ["reuters.com", "bloomberg.com", "wsj.com", "cnbc.com", "marketwatch.com", "ft.com"]
  }
  ```
- **Filtering:** Only returns results with `score > 0.5`
- **Circuit breaker:** `'tavily'` — `createBreaker(searchLiveNewsRaw, 'tavily', { timeout: 8_000 })` — uses existing auto-registration factory in `circuitBreaker.ts`, no changes to that file needed
- **On breaker OPEN:** Returns `[]` (empty array, not thrown)
- **Log on each call:** `console.log('[tavily] query="${query}" results=${results.length}')` for cost monitoring

#### `backend/src/lib/newsDigest.ts`
```typescript
export async function buildNewsDigest(
  results: TavilyResult[],
  reason: string
): Promise<string | null>
```

- **Purpose:** Summarize Tavily snippets into ≤ 80 words relevant to SPY options trading
- **Model:** `gpt-4o-mini` via **native `fetch()` to `https://api.openai.com/v1/chat/completions`** with `CONFIG.OPENAI_API_KEY` — same pattern used throughout the project (no OpenAI SDK import, no shared instance)
- **Prompt pattern:** "Você é um analista quantitativo. Resuma os snippets abaixo em no máximo 80 palavras, focando no impacto direto para SPY options trading. Motivo da busca: {reason}. Snippets: {content}"
- **max_tokens:** 200
- **No streaming** — synchronous result via `json()` parse of response body
- **On empty results:** Returns `null` (tool_result will say "Sem notícias de impacto encontradas")
- **On `gpt-4o-mini` failure:** Returns `[FONTE EXTERNA — conteúdo não verificado]: ${results[0].content.slice(0, 150)}` — sanitization prefix prevents raw external content being mistaken for trusted context

---

## Tool Definition

### OpenAI Format (for GPT-4o fallback path in openai.ts)
```typescript
{
  type: 'function',
  function: {
    name: 'search_live_news',
    description: 'Busca notícias ao vivo sobre o SPY e mercado americano quando detectar movimento de preço/volume inexplicável pelos dados estruturais internos. Use quando RVOL > 2.0, variação ≥ 0.4% em 15min sem correlação GEX/VIX/P/C, ou queda de regime_score ≥ 3 pontos sem razão estrutural.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Query de busca contextualizada incluindo preço atual, variação e timeframe. Ex: "SPY fell 0.6% in 15min from $580 to $576 reason today"'
        },
        reason: {
          type: 'string',
          description: 'Descrição da anomalia que justifica a busca. Ex: "RVOL 2.3x without GEX or P/C catalyst"'
        }
      },
      required: ['query', 'reason']
    }
  }
}
```

### Anthropic Format (for Claude primary path)
```typescript
{
  name: 'search_live_news',
  description: '...', // same as above
  input_schema: {
    type: 'object',
    properties: { query: {...}, reason: {...} },
    required: ['query', 'reason']
  }
}
```

---

## System Prompt Addition

Add to the tools section of `STATIC_SYSTEM_PROMPT` in `openai.ts`:

```
FERRAMENTA search_live_news — Acione quando:
1. Variação de preço ≥ 0.4% em 15min não explicada por VIX, GEX ou P/C
2. RVOL > 2.0 sem catalisador estrutural identificado nos dados internos
3. regime_score caiu ≥ 3 pontos sem mudança em GEX, vanna ou charm
Formule a `query` incluindo o preço atual do SPY, a variação em pontos/percentual e o timeframe.
Exemplo: "SPY drop 0.5% in 20 minutes at $580 November 2024 reason catalyst"
```

---

## Data Flow

```
POST /api/analyze
       │
       ▼
buildPrompt() — 22 blocks assembled from in-memory snapshots (unchanged)
       │
       ▼
1st LLM call — tools: [fetch_24h_context, fetch_sec_filings, search_live_news]
       │
       ├── end_turn → extract structured output → emit event:structured → done
       │
       ├── tool_use: fetch_24h_context or fetch_sec_filings → (existing behavior)
       │
       └── tool_use: search_live_news(query, reason)
                │
                ├── searchLiveNews(query) → Tavily API (≤8s, circuit breaker)
                │
                ▼
            buildNewsDigest(results, reason) → gpt-4o-mini (≤2s, max_tokens:200)
                │
                ▼
            2nd LLM call — tool_result: digest (or "Sem notícias..." on null)
                │
                ▼
            streaming tokens → event:token → frontend
                │
                ▼
            extractStructuredOutput() → event:structured
```

**Total added latency when tool fires:** ~3-5s (Tavily ~2-3s + gpt-4o-mini ~1-2s)

---

## Confidence Scoring

Add new source key to `confidenceScorer.ts`:

```typescript
'tavily': capturedAt → freshness scoring
```

- Results from last 2h → score ≥ 0.8 (ALTA)
- Results 2-6h old → score 0.5-0.8 (MÉDIA)
- No timestamp or >6h → score < 0.5 (BAIXA)
- No results → score 0 (tag omitted)

Tag injected at top of news digest: `[Confiança: 0.90 ALTA]`

---

## Modified Files

| File | Change |
|---|---|
| `backend/src/config.ts` | +`TAVILY_API_KEY: process.env.TAVILY_API_KEY ?? ''` + startup warning log when empty |
| `backend/src/api/openai.ts` | **Four changes:** (1) +tool constant definitions (both OpenAI + Anthropic formats); (2) +tool added to the `tools` array in **three locations**: Claude path (~line 1609), OpenAI primary path (~line 2002), OpenAI legacy path (~line 2379); (3) +handler in tool result switch; (4) +system prompt trigger instructions. Also: extend return type of `streamTokens` and `streamClaudeAnalyze` to include `toolCallArgs: string` so the handler can access `query` and `reason` from the model's tool call JSON |
| `backend/src/lib/confidenceScorer.ts` | +`'tavily'` source key with `publishCycleMs: 7_200_000` (2h) and `maxAcceptableAgeMs: 21_600_000` (6h); `capturedAt` passed as the `published_date` of the highest-scoring Tavily result |
| `backend/.env` (local) | `TAVILY_API_KEY=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` |
| Fly.io secrets | `fly secrets set TAVILY_API_KEY=... --app spy-dash-backend-dark-log-5876` |

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Tavily timeout (>8s) | Circuit breaker fires, tool_result: "Busca web indisponível (timeout)" |
| Tavily breaker OPEN | Returns `[]`, tool_result: "Busca web indisponível (circuit aberto)" |
| No results (all score < 0.5) | tool_result: "Sem notícias de impacto encontradas para este movimento" |
| gpt-4o-mini fails | Returns raw first snippet truncated to 150 chars as fallback |
| `TAVILY_API_KEY` missing | Log warning on startup; tool handler returns graceful fallback string |

Analysis always continues — `search_live_news` failure never blocks the analysis pipeline.

**Prompt injection guard:** The `[FONTE EXTERNA — conteúdo não verificado]` prefix on the raw-snippet fallback signals to the main LLM that this content is untrusted, mitigating prompt injection risk from external news sources.

---

## Token Cost Estimate (per triggered analysis)

| Step | Tokens |
|---|---|
| 5 Tavily snippets → gpt-4o-mini input | ~1,400 |
| gpt-4o-mini output (digest) | ~100 |
| Digest injected into main LLM context | ~150 |
| **Incremental cost** | **~$0.001 (gpt-4o-mini pricing)** |

---

## Verification Plan

1. `cd backend && npm run dev` — confirm `TAVILY_API_KEY` loaded (log on startup)
2. Call `POST /api/analyze` — inspect logs for `[tavily]` entries (should be absent when market is stable)
3. Temporarily lower trigger threshold in system prompt → verify Tavily is called and digest appears in streamed tokens
4. Set `TAVILY_API_KEY=invalid` → verify analysis still completes with fallback message
5. Verify `event:structured` is emitted correctly even after web search tool use
6. Deploy backend: `cd backend && fly deploy`

---

## Out of Scope

- Frontend UI for news results (not requested)
- Multi-tool chaining (web search + macro context in same analysis)
- Persistent news cache between analyses
- Query history or audit log for Tavily calls

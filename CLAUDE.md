# CLAUDE.md — SPY Dash

## Idioma

**Responda SEMPRE em português do Brasil (pt-BR)**, independente do idioma usado pelo usuário. Comentários em código devem seguir o padrão existente no arquivo (em geral inglês para código, português para logs de console).

---

## Visão Geral do Projeto

Dashboard de trading em tempo real para opções de SPY.

- **Backend:** Fastify 4 + TypeScript — `backend/src/`
- **Frontend:** React 18 + Vite + Zustand — `frontend/src/`
- **Dados ao vivo:** DXFeed WebSocket (via Tastytrade OAuth2)
- **Ticks de preço:** `/ws/ticks` WebSocket (`wsTicks.ts`) — payload compacto `{t,l,b,a,c,cp,v,dh,dl,ts}`
- **Dados macro/alertas:** SSE `/stream/market` (`sse.ts`)
- **IA:** `POST /api/analyze` → GPT-4o streaming + Tool Calling + Structured Outputs (`json_schema`)
- **Cache:** Redis (ioredis) com Brotli automático em payloads >1KB
- **Persistência:** Supabase (Auth, `ai_analyses` pgvector, `price_sparkline` matview)

---

## Comandos de Desenvolvimento

```bash
# Iniciar tudo (recomendado)
./start.sh

# Backend (porta 3001)
cd backend && npm run dev

# Frontend (porta 5173)
cd frontend && npm run dev

# Build
cd backend && npm run build
cd frontend && npm run build
```

---

## Arquitetura Crítica

### Fluxo de Dados de Mercado
```
DXFeed WS → marketState (EventEmitter) → wsTicks.ts → /ws/ticks → usePriceTicks.ts → Zustand
```
- `quote` e `vix` foram **removidos do SSE** — ticks de preço chegam exclusivamente via `/ws/ticks`
- `usePriceTicks.ts` faz batching local de `PricePoint[]` (max 390 pts); aceita tick único ou array

### Tipo Central: PricePoint
```typescript
interface PricePoint { t: number; p: number }  // epoch ms + preço
```
`priceHistory` é `PricePoint[]` em todo o stack (backend `types/market.ts`, frontend `store/marketStore.ts`).

### Persistência do Histórico Intraday (cadeia no startup)
```
restoreIntradayFromRedis()   // Redis 14h — filtra só hoje
  → restorePriceHistory()    // Supabase — busca até 5 dias
  → restoreFromTradier()     // Tradier timesales — 390 bars 1min (sobrescreve)
```
Persistido de volta ao Redis a cada 60s via `startIntradayCachePersistence()`.

### Bootstrap não-bloqueante
`listen()` é chamado antes dos restores. Cada operação tem `withTimeout()` individual. Pollers só iniciam após `Promise.allSettled()` dos restores.

### SSE por usuário
`sse.ts` mantém `clientsByUser: Map<string, SSEClient[]>`. Use `broadcastToUser(userId, event, data)` para alertas por usuário.

### updateSPY / updateVIX — guarda crítico
Só acumula ponto em `priceHistory` quando `'last' in data && data.last != null`. Bid/ask-only ticks **não** devem duplicar o preço.

---

## Padrões a Seguir

### Novo poller de dados
1. Adicionar em `advancedMetricsPoller.ts` via `Promise.allSettled`
2. Adicionar campo em `AdvancedMetricsPayload` (`advancedMetricsState.ts`)
3. Emitir via `emitter.emit(...)` e ouvir em `sse.ts`
4. Enviar snapshot na conexão do cliente SSE

### Novo bloco no prompt IA
1. Criar `build*Block()` em `openai.ts`
2. Adicionar parâmetro a `buildPrompt()`
3. Ler do snapshot em memória

### Novo cache Redis
- Usar `cacheGet<T>()` / `cacheSet(key, value, ttlMs, source)` de `lib/cacheStore.ts`
- TTL 14h (`14 * 60 * 60 * 1000`) para dados que precisam sobreviver ao fechamento do mercado
- Restaurar no startup em `index.ts` com `withTimeout()`

### Novo evento SSE
1. `emitter.on('evento', handler)` em `sse.ts`
2. Enviar snapshot imediato na conexão em `sse.ts`
3. Ouvir no frontend em `useMarketStream.ts`

---

## Arquivos-Chave

| Arquivo | Responsabilidade |
|---|---|
| `backend/src/index.ts` | Bootstrap: listen + restores paralelos + pollers |
| `backend/src/api/sse.ts` | SSE stream, listeners de eventos, broadcast por usuário |
| `backend/src/api/wsTicks.ts` | WebSocket `/ws/ticks` com batching 100ms |
| `backend/src/api/openai.ts` | GPT-4o: `buildPrompt()`, Tool Calling, Structured Outputs |
| `backend/src/data/marketState.ts` | Estado central + EventEmitter + `updateSPY/VIX()` |
| `backend/src/data/priceHistory.ts` | Restauração de histórico + `getLastVwap()` + cache Redis |
| `backend/src/stream/dxfeedClient.ts` | Conexão DXFeed, watchdog, parser de eventos |
| `backend/src/lib/cacheStore.ts` | Redis com Brotli + `cacheGet` / `cacheSet` |
| `backend/src/lib/confidenceScorer.ts` | Score 0–1 por fonte + label ALTA/MÉDIA/BAIXA |
| `backend/src/data/alertEngine.ts` | Alertas de preço por usuário (proximity + debounce 60s) |
| `backend/src/types/market.ts` | Todos os tipos TypeScript compartilhados |
| `frontend/src/store/marketStore.ts` | Zustand: estado global + tipos exportados (`PricePoint`) |
| `frontend/src/hooks/usePriceTicks.ts` | WebSocket `/ws/ticks` → store (history buffers locais) |
| `frontend/src/hooks/useMarketStream.ts` | EventSource SSE → store |
| `frontend/src/components/charts/PriceSparkline.tsx` | Recharts com XAxis 30min ET, tooltip, ReferenceLine |

---

## TTLs de Cache Redis (referência rápida)

| Chave | TTL | Notas |
|---|---|---|
| `spy_intraday`, `vix_intraday` | 14h | Filtrado para hoje no restore |
| `spy_quote_snapshot` | 14h | Popula card SPY com mercado fechado |
| `ivrank_snapshot` | 14h | Inclui `hv30` da Tastytrade |
| `vix_snapshot` | 14h | Fallback Finnhub/Tradier |
| `tradier:chain:*` | 5min | Option chain completa |
| `gex:daily:*` | 5min | GEX por strike |
| `technical_indicators:SPY` | 60min | RSI/MACD/BBands local |
| `auth:tt_refresh_token` | 30d | AES-256-GCM criptografado |

---

## Armadilhas Conhecidas

- **`@fastify/websocket` v8** — handler recebe `SocketStream`, usar `connection.socket` (não `WebSocket` diretamente)
- **DXFeed Summary com mercado fechado** — campos `dayHigh/dayLow/prevClose` chegam como `NaN`; usar `isValidNumber()` antes de aplicar ao estado
- **userId Supabase** — é `user.id` (não `user.sub`); corrigido em `openai.ts` e `rateLimiter.ts`
- **`putCallRatio`** — retorna `null` quando `putVolume + callVolume === 0` (mercado fechado)
- **`priceHistory` push** — só em `updateSPY/VIX` quando `'last' in data`; nunca em bid/ask-only updates
- **DXFeed watchdog** — `lastFeedDataAt` começa em `0`; watchdog não avalia staleness até receber o primeiro `FEED_DATA` (evita loop de reconexão no fim de semana)
- **`OPTION_CHAIN_THRESHOLD`** — padrão `0.01` (era `0.003`); controla quais strikes são considerados ATM

---

## Segurança

- Todas as rotas protegidas usam `requireAuth` (JWT Supabase via header `Authorization: Bearer` ou query `?token=`)
- Backend usa `SUPABASE_SERVICE_ROLE_KEY` (bypassa RLS) — nunca expor no frontend
- RLS ativo em `ai_analyses` e `price_ticks` (migration `20260228000000_enable_rls.sql`)
- Refresh token Tastytrade criptografado com AES-256-GCM no Redis (`tokenManager.ts`)

---

## Variáveis de Ambiente Necessárias

Ver seção "Configuração e Instalação" no README.md para lista completa. As chaves obrigatórias para funcionalidade básica são: `TT_*` (Tastytrade), `TRADIER_API_KEY`, `OPENAI_API_KEY`, `REDIS_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

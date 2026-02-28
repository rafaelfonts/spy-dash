# SPY Dash

Dashboard de trading em tempo real focado em opções de SPY, com streaming de dados de mercado ao vivo, análise gerada por IA e feed de contexto macroeconômico.

---

## Visão Geral

SPY Dash integra dados de mercado em tempo real via Tastytrade/DXFeed com análise GPT-4o e um feed de contexto completo (earnings, dados macro, eventos econômicos, headlines, sentimento de mercado, GEX, Volume Profile, VIX Term Structure e indicadores técnicos), entregando um painel profissional para operadores de opções que precisam de velocidade e contexto ao mesmo tempo.

**Stack:** React 18 + Vite no frontend, Fastify + TypeScript no backend, comunicação via Server-Sent Events (SSE).

---

## Funcionalidades

### Dados de Mercado em Tempo Real
- Preço, bid/ask, volume e máx./mín. do dia do SPY via WebSocket DXFeed
- Índice VIX com fallback chain: DXFeed → Finnhub → Tradier (garantia de dado mesmo quando DXFeed não emite Trade events para índices)
- Sparkline de preços com histórico intraday restaurado do Tradier no startup (390 bars de 1min, cobrindo ~6.5h de sessão)
- IV Rank percentual atualizado a cada 60s via Tastytrade API
- Flash de tick animado a cada atualização de preço
- Indicador "AO VIVO" quando o mercado americano está aberto

### Streaming Resiliente
- Conexão WebSocket com reconexão automática (backoff exponencial, até 20 tentativas)
- Detecção de dados stale: reconecta automaticamente se não houver update por mais de 90s
- Broadcast SSE para múltiplos clientes simultâneos (global e por usuário)
- SSE heartbeat a cada 15s para manter conexão viva em proxies
- Batching de eventos `newsfeed` em janela de 500ms (`SSEBatcher`) para evitar flood de mensagens
- Endpoint `/health` com idade do dado mais recente

### Análise por IA (GPT-4o)
- Análise gerada com contexto completo enviado via `buildPrompt()` (10 blocos):
  1. **Mercado em tempo real:** preço SPY, variação, VIX (com nível), IV Rank (valor + percentil + label)
  2. **Cadeia de opções:** ATM ±5 strikes com bid/ask de calls e puts para as 3 expirações mais próximas (0, 1, ~7 DTE)
  3. **Contexto macro (FRED + BLS):** CPI, Core CPI, PCE, Fed Funds Rate, Yield Curve, Unemployment, NFP, AHE, PPI — com direção vs. leitura anterior
  4. **Earnings próximos:** componentes do SPY com earnings em -7 a +90 dias (janela cobre ciclo recente e próximo)
  5. **Eventos macro de alto impacto:** próximas 48h com estimativa e valor anterior
  6. **GEX (Gamma Exposure):** total, callWall, putWall, flipPoint, regime, análise de strikes-chave
  7. **Volume Profile:** POC, VAH, VAL do dia (detecta value area e price acceptance zones)
  8. **VIX Term Structure:** curva IV por DTE, steepness%, estructura (normal/inverted/flat), dados de contango/backwardation
  9. **Memória de análises:** resumos das últimas 3 análises do usuário nas últimas 24h (contexto histórico por sessão)
  10. **Indicadores Técnicos:** RSI(14), MACD (valor + signal + histogram + crossover), BBANDS (upper/middle/lower + posição do preço)
- **Confidence scores por fonte:** cada bloco do prompt é acompanhado de tag de confiança calculada por `confidenceScorer.ts`. Dados com score BAIXO são marcados como `[DADOS DESATUALIZADOS]` no prompt, avisando a IA sobre limitações de qualidade.
- **Circuit breaker statuses:** o prompt inclui o estado atual de cada circuit breaker (`CLOSED` | `HALF_OPEN` | `OPEN`) para que a IA avalie quais dados podem estar indisponíveis.
- **Structured output:** a IA retorna além do texto de análise um objeto estruturado `{ bias: 'bullish' | 'bearish' | 'neutral', key_levels: { support: number[], resistance: number[], gex_flip: number | null } }` usado pelo `alertEngine` para registrar alertas automáticos.
- **System prompt:** "especialista sênior em opções americanas, foco em SPY, análises concisas, objetivas e acionáveis, formato Markdown". Inclui heurísticas de combinação de sinais: ex. RSI sobrecomprado + resistência GEX = sinal de venda forte; RSI oversold + suporte GEX = sinal de compra forte; MACD crossover bullish + GEX positivo = momentum sustentável.
- Resposta em streaming via SSE — texto aparece em tempo real (max 1200 tokens)
- Renderização em Markdown com headers, listas e destaques
- Idioma padrão: Português

### Memória de Análise IA
- Ao fim de cada análise, `analysisMemory.ts` salva no Supabase (`ai_analyses`):
  - Texto completo da análise
  - Resumo gerado por GPT-4o-mini (2-3 frases com bias, níveis-chave e estratégia)
  - Embedding vetorial do resumo via `text-embedding-3-small`
  - Snapshot de mercado no momento (spyPrice, vix, ivRank)
  - Structured output (bias + key_levels)
- As últimas 3 análises das últimas 24h são injetadas no próximo prompt como contexto histórico
- Falha de persistência não bloqueia o fluxo principal (try/catch silencioso)

### GEX + Volume Profile
- **GEX (Gamma Exposure):** calculado a partir de option data real da Tradier (`tradierOptionData.ts` + `gexCalculator.ts`)
  - Modelo Black-Scholes para gamma via `gexService.ts`
  - Métricas publicadas: `total` (net GEX em $M), `callWall`, `putWall`, `zeroGamma` (zero gamma level via BS), `flipPoint` (sign-change cumulativo), `regime` (positive/negative), `maxGexStrike`, `minGexStrike`
  - `byStrike`: top 20 strikes por `|netGEX|` enviados via SSE com `{ strike, netGEX, callGEX, putGEX, callOI, putOI }`
  - Expiração mais próxima usada para cálculo
- **Volume Profile:** calculado a partir de time-sales intraday do Tradier
  - POC (Point of Control) — strike com maior volume
  - VAH (Value Area High) e VAL (Value Area Low) — 70% do volume total
  - `totalVolume` e `barsProcessed` para diagnóstico
- **Put/Call Ratio:** volume de puts vs. calls, ratio numérico, label (bullish/neutral/bearish), expiração
- Poller independente (`advancedMetricsPoller.ts`) — não depende do token Tastytrade, começa imediatamente no startup
- Cache SSE: ao conectar, cliente recebe snapshot imediato do estado atual
- Painel `GEXPanel.tsx` no frontend com gráfico de barras por strike (calls verde, puts vermelho)

### VIX Term Structure
- Inferida a partir da option chain SPY (não requer API externa adicional)
- `vixTermStructure.ts`: calcula IV implícita por DTE usando preços de opções ATM
- Métricas publicadas: `structure` (normal | inverted | flat), `steepness` (% diferença IV curto vs. longo prazo), `curve` (array `{ dte, iv }`)
- `startVIXTermStructurePoller()` — poll a cada 5min, aguarda 10s no startup para option chain popular
- Pula se option chain está stale (>6min) ou VIX spot / SPY price indisponíveis
- Injetado no prompt IA com contexto sobre contango (mercado calmo, boa venda de vol) vs. backwardation (stress, cuidado)

### Indicadores Técnicos (Alpha Vantage)
- Fetches: RSI(14), MACD (default params), BBANDS (20 periods, 2σ) — símbolo SPY, intervalo 15min
- **Estratégia de rotação:** 1 indicador por tick, ciclando RSI → MACD → BBANDS (a cada 15min durante horário de mercado)
  - Cada ciclo completo ≈ 45min
  - ~20 req/dia — dentro do limite de 25 req/dia do free tier
  - Publica apenas quando todos os 3 foram coletados ao menos uma vez
  - Off-hours: scheduler recua para checks a cada 5min (sem chamadas à API)
- `deriveBBPosition(spyPrice, bbands)`: classifica posição do preço relativa às bandas (`above_upper | near_upper | middle | near_lower | below_lower`). Chamada em `openai.ts` no momento do clique (usa preço SPY ao vivo, não o preço quando BBANDS foi calculado)
- No-op se `ALPHA_VANTAGE_KEY` não configurado

### Alertas de Preço em Tempo Real
- Após cada análise IA, o `alertEngine.ts` registra os `key_levels` do structured output como alertas ativos do usuário (até 10 alertas; nova análise substitui todos os anteriores)
- A cada `quote` event (a cada tick de preço), `checkAlerts(price)` avalia todos os alertas ativos:
  - `approaching`: preço dentro de 0.2% do nível (`PROXIMITY_WARN`)
  - `testing`: preço dentro de 0.05% do nível (`PROXIMITY_TEST`)
  - Debounce de 60s por alerta para evitar spam
  - Só dispara durante horário de mercado (NYSE 09:30–16:00 ET)
- Alertas enviados via `broadcastToUser(userId, 'alert', {...})` — roteamento por usuário no SSE
- Frontend: `AlertOverlay.tsx` exibe notificações em overlay fixo (top-right), slide-in/out com Framer Motion, auto-dismiss em 8s, dismissível por clique

### Feed de Mercado
Painel com seis fontes de dados agregadas via SSE:

| Seção | Fonte | Frequência |
|---|---|---|
| **Earnings Calendar** | Tastytrade API | A cada 6h |
| **Dados Macro (FRED)** | Federal Reserve St. Louis | A cada 24h |
| **Dados Macro (BLS)** | Bureau of Labor Statistics | A cada 24h |
| **Eventos Macro** | Finnhub Economic Calendar | A cada 1h |
| **Headlines** | GNews | A cada 30min |
| **Fear & Greed** | CNN (endpoint público) | A cada 4h |

**Earnings Calendar:** próximos earnings dos 10 maiores componentes do SPY (janela -7 a +90 dias), ordenados por DTE, com alertas de urgência (≤3 dias = vermelho, ≤14 dias = amarelo).

**Dados Macro FRED:** CPI All Items, Core CPI, PCE Deflator, Fed Funds Rate e Yield Curve (T10Y2Y), com direção vs. leitura anterior e color-coding semântico.

**Dados Macro BLS:** Unemployment Rate, Nonfarm Payrolls, Average Hourly Earnings e PPI Final Demand, via BLS API v2.

**Eventos Macro:** calendário prospectivo de eventos US de alto e médio impacto com horário em ET, consenso de analistas e valor anterior.

**Headlines:** 10 headlines recentes filtradas por Fed, FOMC, S&P 500, juros, CPI, NFP, SPY e volatilidade, com links diretos para a fonte.

**Fear & Greed:** gauge semicircular SVG com score 0–100 e 5 zonas de cor (Medo Extremo → Ganância Extrema).

### Dashboard UI
- Três cards principais: **SPY**, **VIX**, **IV Rank**
- **GEX Panel:** gráfico de barras por strike (calls/puts), métricas callWall/putWall/flipPoint, regime, P/C Ratio com barra visual
- Sparklines com tooltips (Recharts)
- **Alert Overlay:** notificações de alerta de preço em overlay fixo, animadas com Framer Motion
- Tema escuro customizado com Tailwind CSS
- Animações de entrada/saída com Framer Motion
- Skeletons de carregamento
- Indicador de status da conexão com contagem de reconexões

### Cadeia de Opções (Option Chain)
- Dados SPY: calls e puts por DTE (0, 1, 7, 21, 45 dias) — filtro ±3 dias em relação ao alvo
- Cache em memória de 5 minutos no backend (endpoint `GET /api/option-chain`)
- Incluída automaticamente no prompt da IA ao clicar em "Analisar com IA": o hook `useAIAnalysis` busca `/api/option-chain`, seleciona os 5 strikes mais próximos do ATM para cada uma das 3 expirações mais próximas e inclui bid/ask de calls e puts no contexto enviado ao GPT-4o

### Autenticação
- Supabase Auth com email e senha
- JWT validado no backend em todas as rotas protegidas
- Token Bearer no header HTTP (ou query param `?token=` para SSE)

---

## Arquitetura

```
SPY Dash/
├── backend/                    # Fastify API + streaming
│   └── src/
│       ├── index.ts            # Bootstrap do servidor
│       ├── config.ts           # Variáveis de ambiente (todas as keys)
│       ├── api/                # Endpoints HTTP
│       │   ├── health.ts       # Status do servidor (público + protegido)
│       │   ├── openai.ts       # Análise GPT-4o em streaming (buildPrompt + buildTechBlock)
│       │   ├── sse.ts          # Stream de mercado SSE (broadcast global + por usuário)
│       │   └── priceHistory.ts # GET /api/price-history
│       ├── auth/               # OAuth2 Tastytrade
│       │   ├── tokenManager.ts # Refresh automático de tokens
│       │   └── streamerToken.ts
│       ├── middleware/
│       │   └── authMiddleware.ts  # Validação JWT Supabase
│       ├── stream/             # Conexão DXFeed
│       │   ├── dxfeedClient.ts # WebSocket + parser de quotes
│       │   └── reconnector.ts  # Reconexão com backoff
│       ├── data/               # Estado e polling
│       │   ├── marketState.ts       # Estado centralizado + EventEmitter + newsSnapshot
│       │   │                        # MAX_HISTORY=390 (6.5h de sessão, 1 bar/min)
│       │   ├── ivRankPoller.ts      # Poll IV Rank 60s (Tastytrade)
│       │   ├── optionChain.ts       # Fetch + cache de options (Tastytrade)
│       │   ├── priceHistory.ts      # Persistência Supabase + restoreFromTradier()
│       │   ├── earningsCalendar.ts  # Earnings top 10 SPY (Tastytrade, 6h; janela -7..90d)
│       │   ├── fredPoller.ts        # CPI/PCE/Fed Rate/Yield Curve (FRED, 24h)
│       │   ├── blsPoller.ts         # NFP/Desemprego/PPI/Earnings (BLS, 24h)
│       │   ├── macroCalendar.ts     # Eventos econômicos EUA (Finnhub, 1h)
│       │   ├── newsAggregator.ts    # Headlines de mercado (GNews, 30min)
│       │   ├── fearGreed.ts         # Fear & Greed score (CNN, 4h)
│       │   ├── vixPoller.ts         # Fallback VIX: DXFeed → Finnhub → Tradier
│       │   ├── tradierOptionData.ts # Busca opções SPY do Tradier para GEX
│       │   ├── gexService.ts        # Cálculo GEX via Black-Scholes gamma
│       │   ├── volumeProfileService.ts  # Volume Profile: POC/VAH/VAL via time-sales
│       │   ├── advancedMetricsPoller.ts # GEX + VolumeProfile + P/C Ratio (poll independente)
│       │   ├── advancedMetricsState.ts  # Snapshot GEX/Volume/PCR em memória + SSE emit
│       │   ├── vixTermStructure.ts      # inferTermStructure() a partir de option chain
│       │   ├── vixTermStructurePoller.ts # Poll 5min; aguarda option chain no startup
│       │   ├── vixTermStructureState.ts  # Snapshot VIX term structure em memória
│       │   ├── technicalIndicatorsPoller.ts # RSI/MACD/BBANDS Alpha Vantage (rotação 15min)
│       │   ├── technicalIndicatorsState.ts  # Snapshot indicadores técnicos em memória
│       │   ├── alertEngine.ts       # Alertas de preço por usuário (proximity + debounce)
│       │   └── analysisMemory.ts    # Persistência análise IA no Supabase + embeddings
│       ├── lib/                # Utilitários
│       │   ├── circuitBreaker.ts    # Opossum wrapper: CLOSED/HALF_OPEN/OPEN; registry global
│       │   ├── confidenceScorer.ts  # Score 0.0–1.0 por fonte (frescor × CB multiplier)
│       │   ├── cacheStore.ts        # Cache em memória com TTL, namespace por fonte
│       │   ├── restoreCache.ts      # Restaura snapshots de cache no startup do servidor
│       │   ├── sseBatcher.ts        # Batch de eventos newsfeed em janela de 500ms
│       │   ├── tradierClient.ts     # TradierClient: getQuotes(), getTimeSales(), getOptionChain()
│       │   └── gexCalculator.ts     # Black-Scholes gamma: Nd1(), calcGamma(), buildProfile()
│       └── types/
│           └── market.ts       # Interfaces TypeScript (todos os tipos compartilhados)
│
├── frontend/                   # React 18 SPA
│   └── src/
│       ├── App.tsx             # Componente raiz + auth gate
│       ├── store/
│       │   └── marketStore.ts  # Zustand (estado global: mercado + newsFeed + GEX + alerts)
│       ├── hooks/
│       │   ├── useMarketStream.ts  # EventSource → store (todos os eventos SSE)
│       │   ├── useAIAnalysis.ts    # Streaming GPT-4o + coleta option chain
│       │   ├── useAuth.ts          # Supabase Auth
│       │   └── useMarketOpen.ts    # Horário de mercado EUA
│       ├── components/
│       │   ├── cards/          # SPYCard, VIXCard, IVRankCard
│       │   ├── ai/             # AIPanel + AnalysisResult
│       │   ├── options/
│       │   │   └── GEXPanel.tsx    # Painel GEX: gráfico byStrike + callWall/putWall/flipPoint
│       │   ├── news/           # NewsFeedPanel e subcomponentes
│       │   │   ├── NewsFeedPanel.tsx      # Container (6 seções)
│       │   │   ├── EarningsCalendar.tsx
│       │   │   ├── MacroData.tsx
│       │   │   ├── MacroCalendar.tsx
│       │   │   ├── NewsHeadlines.tsx
│       │   │   ├── FearGreedGauge.tsx
│       │   │   └── PutCallRatioCard.tsx   # P/C Ratio com barra visual
│       │   ├── charts/         # PriceSparkline (Recharts)
│       │   ├── layout/         # Header + StatusBar
│       │   ├── ui/             # ConnectionDot, TickFlash, Skeleton, AlertOverlay
│       │   │   └── AlertOverlay.tsx       # Overlay de alertas de preço (Framer Motion)
│       │   └── auth/           # LoginPage (Supabase)
│       └── lib/
│           ├── formatters.ts   # Utilitários de formatação
│           └── supabase.ts     # Cliente Supabase
│
├── legacy/                     # Versão anterior HTML/JS
├── start.sh                    # Script de inicialização unificado
└── README.md
```

### Fluxo de Dados — Mercado em Tempo Real

```
DXFeed WebSocket → marketState (EventEmitter) → SSE broadcast → Browser EventSource
                                                                → Zustand store
                                                                → React re-renders

Startup: restorePriceHistory() (Supabase) + restoreFromTradier() (Tradier timesales, 390 bars)
         → marketState.spy.priceHistory populado antes do primeiro broadcast
```

### Fluxo de Dados — GEX + Volume Profile

```
Tradier API (option chain + time-sales)
  → tradierOptionData.ts (fetch opções SPY)
  → gexCalculator.ts (Black-Scholes gamma por strike)
  → gexService.ts (callWall, putWall, flipPoint, byStrike, regime)
  → volumeProfileService.ts (POC, VAH, VAL via time-sales 5min bars)
  → advancedMetricsPoller.ts (monta AdvancedMetricsPayload, inclui top-20 byStrike)
  → advancedMetricsState.ts (snapshot em memória + emitter.emit('advanced-metrics'))
  → SSE broadcast → Browser EventSource
  → Zustand store (gex, profile, putCallRatio)
  → GEXPanel.tsx re-renders
```

### Fluxo de Dados — VIX Term Structure

```
optionChain.ts (snapshot em memória, cache 5min)
  + marketState.vix.last
  + marketState.spy.last
  → vixTermStructure.ts inferTermStructure()
    (IV implícita por DTE a partir de opções ATM)
  → vixTermStructurePoller.ts (poll 5min)
  → vixTermStructureState.ts (emitter.emit('vix-term-structure'))
  → SSE broadcast → Browser EventSource
  → Zustand store → AIPanel (injetado no prompt)
```

### Fluxo de Dados — Indicadores Técnicos

```
Alpha Vantage API (RSI → MACD → BBANDS, rotação 15min)
  → technicalIndicatorsPoller.ts (acumulador acc{})
  → publishTechnicalData() quando todos 3 coletados
  → technicalIndicatorsState.ts (snapshot em memória)
  → openai.ts buildTechBlock() (injeta no prompt ao clicar em Analisar)
     + deriveBBPosition(spyPrice, bbands) → posição relativa às bandas
```

### Fluxo de Dados — Alertas de Preço

```
GPT-4o structured output { key_levels: { support, resistance, gex_flip } }
  → registerAlertsFromAnalysis(userId, structured)
  → alertsByUser Map<userId, ActiveAlert[]>

DXFeed quote event (todo tick de preço)
  → checkAlerts(price)
  → priceDiff ≤ PROXIMITY_TEST (0.05%) → 'testing'
  → priceDiff ≤ PROXIMITY_WARN (0.2%) → 'approaching'
  → broadcastToUser(userId, 'alert', {...})
  → clientsByUser SSE routing
  → AlertOverlay.tsx exibe notificação
```

### Fluxo de Dados — Análise IA

```
Usuário clica "Analisar com IA"
  → GET /api/option-chain  (cache 5min)
  → lê todos os snapshots do Zustand (macro, earnings, gex, vixTermStructure, technicals)
  → GET últimas análises do Supabase (analysisMemory, últimas 24h)
  → POST /api/analyze {
        marketSnapshot, optionChain, context,
        gex, vixTermStructure, technicals
      }
  → buildPrompt() monta texto com 10 blocos + confidence tags + CB statuses
  → GPT-4o (gpt-4o, max_tokens: 1200, streaming)
    + structured output { bias, key_levels }
  → SSE stream token a token → Markdown em tempo real
  → saveAnalysis() → Supabase ai_analyses (async, não bloqueia)
  → registerAlertsFromAnalysis() → alertEngine ativa alertas
```

### Fluxo de Dados — Feed de Mercado

```
Pollers independentes (6h / 24h / 1h / 30min / 4h) — 6 módulos
  → newsSnapshot (in-memory cache)
  → emitter.emit('newsfeed', { type, items })
  → SSEBatcher (500ms janela) → newsfeed-batch SSE event
  → Browser EventSource → Zustand newsFeed slice
  → NewsFeedPanel re-renders

Novo cliente SSE conectado:
  → snapshot imediato dos 6 tipos de dados em cache
  → snapshot imediato de advanced-metrics + vix-term-structure
```

### Circuit Breakers

Todos os pollers de APIs externas são protegidos por `circuitBreaker.ts` (wrapper de `opossum`):

| Breaker | API | Parâmetros |
|---|---|---|
| `finnhub` | Finnhub (VIX, macro events) | resetTimeout: 5min |
| `fred` | Federal Reserve FRED | padrão (60s) |
| `bls` | Bureau of Labor Statistics | padrão (60s) |
| `cnn` | CNN Fear & Greed | padrão (60s) |
| `gnews` | GNews Headlines | padrão (60s) |

- **CLOSED:** operação normal
- **HALF_OPEN:** tentando recuperação (1 call de teste)
- **OPEN:** pausando chamadas, usando fallback (último dado válido em memória)
- O status de cada breaker é incluído no prompt IA e no endpoint `/health/details`

### Confidence Scorer

`confidenceScorer.ts` calcula um score 0.0–1.0 por fonte de dados:
- **Frescor (0.2–1.0):** degradação linear entre `publishCycleMs` e `maxAcceptableAgeMs`
- **Multiplicador CB:** CLOSED=1.0, HALF_OPEN=0.6, OPEN=0.3
- **Label:** ALTA (≥0.8), MÉDIA (≥0.5), BAIXA (<0.5)
- Dados com capturedAt=null retornam score=0/BAIXA
- No prompt IA, score BAIXA resulta em tag `[DADOS DESATUALIZADOS — usar com cautela]`

---

## APIs e Endpoints

### HTTP

| Endpoint | Método | Auth | Descrição |
|---|---|---|---|
| `/health` | GET | — | Status binário: `{ "status": "ok" \| "degraded" }` |
| `/health/details` | GET | `X-Health-Token` | Detalhes completos: dataAge, circuit breakers, SSE clients, uptime |
| `/stream/market` | GET (SSE) | JWT | Stream de todos os eventos de mercado |
| `/api/analyze` | POST (SSE) | JWT | Análise GPT-4o em streaming |
| `/api/option-chain` | GET | JWT | Snapshot da cadeia de opções SPY |
| `/api/price-history` | GET | JWT | Histórico de preços por símbolo |
| `/admin/breakers` | GET | JWT | Lista circuit breakers com status e nomes |
| `/admin/breakers/:name/reset` | POST | JWT | Reseta manualmente um circuit breaker para CLOSED |

### Health Endpoints

**Público — apenas status binário**
```bash
curl http://localhost:3001/health
# → { "status": "ok" }
# → { "status": "degraded" }  (WebSocket não conectado ou algum circuit breaker OPEN)
```

**Protegido — detalhes completos** (requer header `X-Health-Token`)
```bash
HEALTH_SECRET=$(grep HEALTH_SECRET backend/.env | cut -d= -f2)
curl -H "X-Health-Token: $HEALTH_SECRET" http://localhost:3001/health/details
# → {
#     "status": "ok",
#     "dataAge": { "spy": 2, "vix": 2, "ivRank": 45 },
#     "circuitBreakers": { "fred": "CLOSED", "bls": "CLOSED", "cnn": "CLOSED" },
#     "sseClients": 3,
#     "uptime": 3600
#   }
```

**Admin — circuit breakers** (requer JWT)
```bash
# Listar todos os breakers
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/admin/breakers

# Resetar um breaker específico
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3001/admin/breakers/finnhub/reset
```

### Eventos SSE (`/stream/market`)

| Evento | Tipo / Payload |
|---|---|
| `quote` | Preço SPY, bid, ask, volume, máx/mín, priceHistory[] |
| `vix` | Preço VIX, variação, level (low/moderate/high), priceHistory[] |
| `ivrank` | IV Rank %, percentil, rótulo |
| `status` | Estado da conexão WebSocket, tentativas de reconexão |
| `advanced-metrics` | `{ gex: { total, callWall, putWall, flipPoint, regime, byStrike[] }, profile: { poc, vah, val }, putCallRatio: { ratio, putVolume, callVolume, label } }` |
| `vix-term-structure` | `{ structure: 'normal'\|'inverted'\|'flat', steepness: number, curve: [{ dte, iv }] }` |
| `alert` | `{ level, type: 'support'\|'resistance'\|'gex_flip', alertType: 'approaching'\|'testing', price, timestamp }` (apenas para o usuário dono do alerta) |
| `newsfeed-batch` | Batch de múltiplos tipos de newsfeed em uma única mensagem `{ batch: { [type]: payload } }` |
| `newsfeed` | Payload polimórfico com campo `type` (legacy, para compatibilidade): |
| ↳ `type: earnings` | `items: EarningsItem[]` — earnings dos top 10 SPY |
| ↳ `type: macro` | `items: MacroDataItem[]` — séries FRED |
| ↳ `type: bls` | `items: MacroDataItem[]` — séries BLS |
| ↳ `type: macro-events` | `items: MacroEvent[]` — calendário Finnhub |
| ↳ `type: headlines` | `items: NewsHeadline[]` — headlines GNews |
| ↳ `type: sentiment` | `fearGreed: FearGreedData` — score CNN Fear & Greed |
| `ping` | Heartbeat a cada 15s (timestamp) — mantém conexão viva |

---

## Stack Tecnológico

### Backend

| Tecnologia | Versão | Uso |
|---|---|---|
| Node.js | 20+ | Runtime |
| Fastify | 4.26 | Servidor HTTP |
| TypeScript | 5.3 | Linguagem |
| ws | — | WebSocket DXFeed |
| OpenAI SDK | — | GPT-4o + GPT-4o-mini + text-embedding-3-small |
| Supabase Admin SDK | — | Validação JWT + persistência análises |
| opossum | — | Circuit breakers |
| dotenv | — | Configuração |

### Frontend

| Tecnologia | Versão | Uso |
|---|---|---|
| React | 18.3 | UI |
| Vite | 5.1 | Build + Dev server |
| TypeScript | 5.3 | Linguagem |
| Zustand | 4.5 | Estado global |
| TanStack Query | 5.18 | Data fetching |
| Tailwind CSS | 3.4 | Estilização |
| Recharts | 2.12 | Sparklines + GEX chart |
| Framer Motion | 11 | Animações + AlertOverlay |
| react-markdown | 9 | Renderização da IA |
| Supabase JS | — | Autenticação |

### Integrações Externas

| Serviço | Uso | Key necessária |
|---|---|---|
| Tastytrade API | OAuth2, IV Rank, option chain, earnings | Sim (OAuth2) |
| DXFeed | Quotes SPY/VIX em tempo real via WebSocket | Via Tastytrade |
| Tradier API | GEX (option chain), Volume Profile (time-sales), VIX fallback, SPY price history | Sim |
| OpenAI | GPT-4o (análise), GPT-4o-mini (resumos), text-embedding-3-small | Sim |
| Supabase | Autenticação JWT + persistência análises IA | Sim |
| FRED (Federal Reserve) | CPI, PCE, Fed Rate, Yield Curve | Sim (gratuita) |
| Finnhub | VIX quote (fallback), calendário econômico prospectivo | Sim (gratuita) |
| GNews | Headlines de mercado em tempo real | Sim (gratuita) |
| BLS | NFP, CPI, Desemprego (baixa latência) | Sim (gratuita) |
| CNN Fear & Greed | Score de sentimento 0–100 | Não (público) |
| Alpha Vantage | RSI(14), MACD, BBANDS — 25 req/dia free tier | Sim (gratuita) |

---

## Configuração e Instalação

### Pré-requisitos

- Node.js 20+
- Conta Tastytrade com acesso à API
- Conta Tradier com acesso à API (production: `api.tradier.com`)
- API Key OpenAI com acesso ao GPT-4o
- Projeto Supabase (gratuito em supabase.com) com tabelas `price_ticks`, `price_sparkline`, `ai_analyses`
- API Key FRED (gratuita em fred.stlouisfed.org/docs/api/fred/)
- API Key Finnhub (gratuita em finnhub.io)
- API Key GNews (gratuita em gnews.io)
- API Key BLS (gratuita em bls.gov/developers/)
- API Key Alpha Vantage (gratuita em alphavantage.co — 25 req/dia free tier)

### Variáveis de Ambiente (`backend/.env`)

```env
# Tastytrade OAuth2
TT_BASE=https://api.tastytrade.com
TT_CLIENT_ID=<seu_client_id>
TT_CLIENT_SECRET=<seu_client_secret>
TT_REFRESH_TOKEN=<seu_refresh_token>

# Tradier — production em api.tradier.com, sandbox em sandbox.tradier.com
TRADIER_API_KEY=<sua_key>
TRADIER_BASE_URL=https://api.tradier.com

# OpenAI
OPENAI_API_KEY=sk-proj-...

# Alpha Vantage — gratuito em alphavantage.co (25 req/dia free tier)
ALPHA_VANTAGE_KEY=<sua_key>

# FRED (Federal Reserve) — gratuito em fred.stlouisfed.org/docs/api/fred/
FRED_API_KEY=<sua_key>

# Finnhub — gratuito em finnhub.io (60 req/min; uso comercial requer plano pago)
FINNHUB_API_KEY=<sua_key>

# GNews — gratuito em gnews.io (100 req/dia, sem delay)
GNEWS_API_KEY=<sua_key>

# BLS (Bureau of Labor Statistics) — gratuito em bls.gov/developers/
BLS_API_KEY=<sua_key>

# Servidor
PORT=3001
CORS_ORIGIN=http://localhost:5173

# Health check secret — protege GET /health/details
# Gere com: openssl rand -hex 32
HEALTH_SECRET=<gere_com_openssl_rand_hex_32>

# Supabase
SUPABASE_URL=https://<projeto>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
```

### Variáveis de Ambiente (`frontend/.env`)

```env
VITE_SUPABASE_URL=https://<projeto>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon_key>
```

### Instalação

```bash
# Backend
cd backend && npm install

# Frontend
cd frontend && npm install
```

### Inicialização

```bash
# Opção 1 — script unificado (recomendado)
chmod +x start.sh
./start.sh

# Opção 2 — manual em terminais separados
cd backend && npm run dev   # http://localhost:3001
cd frontend && npm run dev  # http://localhost:5173
```

### Scripts Disponíveis

**Backend:**
```bash
npm run dev    # Modo desenvolvimento (tsx watch)
npm run build  # Compilar TypeScript → dist/
npm start      # Executar build de produção
```

**Frontend:**
```bash
npm run dev     # Dev server Vite (HMR)
npm run build   # Type check + build produção
npm run preview # Preview do build de produção
```

---

## Estado Atual de Desenvolvimento

### Implementado

**Dados de mercado:**
- Streaming WebSocket DXFeed (SPY + VIX) em tempo real
- VIX com fallback chain DXFeed → Finnhub → Tradier
- OAuth2 Tastytrade com refresh automático de token
- Polling IV Rank a cada 60s
- Cadeia de opções SPY com cache em memória (5min)
- Broadcast SSE para múltiplos clientes com reconexão automática
- Histórico de preços intraday SPY restaurado do Tradier no startup (390 bars 1min)
- Persistência de ticks de preço no Supabase (throttle 1min/símbolo)

**GEX + Volume Profile + Indicadores:**
- GEX por strike (Black-Scholes gamma) via Tradier option data — callWall, putWall, flipPoint, regime
- Volume Profile intraday (POC, VAH, VAL) via Tradier time-sales
- Put/Call Ratio com barra visual por expiração
- VIX Term Structure inferida da option chain (normal/inverted/flat, steepness%)
- Indicadores técnicos RSI(14), MACD, BBANDS via Alpha Vantage com rotação 15min

**Análise IA:**
- Painel "Análise IA" com GPT-4o streaming e contexto de 10 blocos
- Confidence scores por fonte + marcação de dados desatualizados no prompt
- Circuit breaker statuses no contexto da IA
- Structured output (bias + key_levels) para integração com alertEngine
- Memória de análise: 3 análises recentes injetadas no próximo prompt
- Persistência de análises no Supabase com embeddings (gpt-3.5-ada)
- Alertas de preço em tempo real (support/resistance/gex_flip) por usuário

**Feed de Mercado:**
- Earnings Calendar dos top 10 componentes do SPY via Tastytrade (6h; janela -7..90d)
- Dados Macro via FRED: CPI, Core CPI, PCE, Fed Funds Rate, Yield Curve T10Y2Y (24h)
- Dados Macro via BLS: Unemployment Rate, Nonfarm Payrolls, Avg Hourly Earnings, PPI Final Demand (24h)
- Calendário de Eventos Econômicos via Finnhub: US high/medium impact (1h)
- Headlines de mercado via GNews com query focada em Fed/macro/SPY (30min)
- Fear & Greed Index via CNN com gauge SVG semicircular (4h)
- Snapshot imediato para novos clientes SSE conectados (todos os tipos de dados)
- SSEBatcher: batching de eventos newsfeed em janela de 500ms

**Infraestrutura:**
- Circuit breakers para todas as APIs externas (opossum)
- Cache em memória com TTL por fonte (`cacheStore.ts`)
- Restauração de cache no startup (`restoreCache.ts`)
- Confidence scorer por fonte de dados (`confidenceScorer.ts`)
- SSE roteado por usuário (`broadcastToUser`) para alertas direcionados
- Endpoint `/admin/breakers` para gestão de circuit breakers

**UI & Autenticação:**
- Dashboard React com 3 cards de métricas (SPY, VIX, IV Rank)
- Painel GEX com gráfico de barras por strike (calls/puts)
- Alert Overlay com animação slide-in/out (Framer Motion, auto-dismiss 8s)
- Painel "Feed de Mercado" com 6 seções em layout de 3 colunas
- Supabase Auth com email/senha (JWT validado no backend)
- Animações Framer Motion + Tailwind dark theme
- Skeletons de carregamento + Sparklines Recharts

### Planejado / Em Desenvolvimento

- Rastreamento de posições e portfólio
- Suporte a múltiplos ativos além do SPY
- Internacionalização (i18n)
- Busca semântica em análises anteriores (similarity search via pgvector)

### Limitações Conhecidas

- Greeks das opções (delta, gamma, theta) não retornados diretamente pela API Tastytrade neste endpoint
- Fear & Greed usa endpoint CNN não oficial — pode mudar sem aviso (com fallback implementado)
- Finnhub free tier não autoriza uso comercial
- GNews free tier limitado a 100 req/dia
- Alpha Vantage free tier limitado a 25 req/dia (design da rotação mantém uso dentro deste limite)
- VIX Term Structure depende da option chain estar fresca (≤6min); pula se stale

---

## Tema Visual

Paleta customizada escura (definida em `tailwind.config.js`):

| Token | Cor | Uso |
|---|---|---|
| `bg-base` | `#0a0a0f` | Fundo global |
| `bg-card` | `#12121a` | Fundo dos cards |
| `bg-elevated` | `#1a1a26` | Elementos elevados |
| `accent-green` | `#00ff88` | Alta / bullish / queda de inflação |
| `accent-red` | `#ff4444` | Baixa / bearish / alta de inflação |
| `accent-yellow` | `#ffcc00` | Alerta / médio impacto |
| `text-primary` | `#e8e8f0` | Texto principal |
| `text-secondary` | `#8888aa` | Texto secundário |

---

## Contribuindo

O projeto está em desenvolvimento ativo. Estrutura de branches sugerida:

- `main` — código estável
- `feature/*` — novas funcionalidades
- `fix/*` — correções

Abra uma issue antes de iniciar mudanças estruturais.

---

*SPY Dash — Construído para operadores de opções que precisam de velocidade e contexto.*

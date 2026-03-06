# SPY Dash

Dashboard de trading em tempo real focado em opções de SPY, com streaming de dados de mercado ao vivo, análise gerada por IA e feed de contexto macroeconômico.

---

## Visão Geral

SPY Dash integra dados de mercado em tempo real via Tastytrade/DXFeed com análise GPT-4o e um feed de contexto completo (earnings, dados macro, eventos econômicos, headlines, sentimento de mercado, GEX, Volume Profile, VIX Term Structure e indicadores técnicos), entregando um painel profissional para operadores de opções que precisam de velocidade e contexto ao mesmo tempo.

**Stack:** React 18 + Vite no frontend, Fastify + TypeScript no backend, comunicação via Server-Sent Events (SSE) para dados macro/alertas e preço SPY/VIX em tempo real. Cache de dados de mercado em Redis (ioredis) com compressão Brotli automática, persistência de usuário e autenticação via Supabase.

---

## Funcionalidades

### Dados de Mercado em Tempo Real
- Preço, bid/ask, volume e máx./mín. do dia do SPY via WebSocket DXFeed
- Índice VIX com fallback chain: DXFeed → Finnhub → Tradier (garantia de dado mesmo quando DXFeed não emite Trade events para índices)
- Histórico intraday restaurado no startup via cadeia: Redis cache (14h TTL, hoje) → Supabase (até 5 dias) → Tradier timesales (390 bars 1min); persistido no Redis a cada 60s em background (usado no backend para indicadores técnicos e prompt IA; preço SPY/VIX ao vivo via SSE)
- IV Rank e HV(30d) atualizados a cada 60s via Tastytrade API; IV Rank % em destaque no card (IVx e Percentil como métricas secundárias); cache com TTL 14h para sobreviver ao fechamento do mercado
- Flash de tick animado a cada atualização de preço
- Indicador "AO VIVO" quando o mercado americano está aberto

### Streaming Resiliente
- Conexão WebSocket DXFeed com reconexão automática (backoff exponencial, até 20 tentativas)
- **SPY e VIX em tempo real via SSE:** eventos `quote` e `vix` são enviados pelo stream SSE (`/stream/market`); snapshot de preço SPY/VIX enviado na conexão inicial do cliente
- Detecção de dados stale: reconecta automaticamente se não houver update por mais de **5 minutos** (`lastFeedDataAt` tracker — watchdog só avalia staleness após o primeiro `FEED_DATA` recebido na conexão, evitando loops de reconexão em fins de semana quando o feed está vivo mas não emite trades)
- Broadcast SSE para múltiplos clientes simultâneos (global e por usuário)
- SSE heartbeat a cada 15s para manter conexão viva em proxies
- Batching de eventos `newsfeed` em janela de 500ms (`SSEBatcher`) para evitar flood de mensagens
- Endpoint `/health` com idade do dado mais recente

### Análise por IA (GPT-4o)
- **Prompt base limpo:** apenas dados de mercado essenciais (SPY, VIX, IV Rank, option chain, GEX, Volume Profile, VIX Term Structure, indicadores técnicos, memória de análises)
- **Tool Calling condicional (`fetch_24h_context`):** o modelo decide autonomamente quando buscar o contexto macro (Fear & Greed, VIX term structure, FRED, BLS, earnings, eventos econômicos). Chamado apenas quando VIX > 20, P/C ratio atípico, RSI extremo + crossover MACD, ou o usuário fizer perguntas macro — evita enviar ~3KB de dados desnecessários em análises de rotina
- **Structured Outputs nativo via `json_schema`:** o modelo retorna diretamente o objeto estruturado em uma única chamada GPT-4o: `bias`, `confidence`, `timeframe`, `key_levels`, `suggested_strategy` (com pernas call/put, strike, DTE), `catalysts`, `risk_factors`; campos de estratégia: `recommended_dte`, `pop_estimate`, `supporting_gex_dte`, `invalidation_level`, `expected_credit`, `theta_per_day`
- **Histórico intraday no prompt (`buildPriceHistoryBlock`):** sessão OHLC, range %, curva amostrada a cada ~15min, tendência 1h, e estimativa de HV intraday (desvio-padrão de log-returns × √(252×390))
- **VWAP no bloco técnico:** `buildTechBlock()` inclui `VWAP: $X.XX | SPY ACIMA/ABAIXO do VWAP em Y.YY%` quando disponível (capturado da última barra Tradier timesales via `getLastVwap()`)
- **Ratio IV/HV(30d):** `buildPrompt()` calcula `ivRank.value / hv30` e sinaliza `[VOL CARA]` quando ratio > 1.3 — dado direto da resposta Tastytrade `hv-30-day`
- **Aviso de mercado fechado no system prompt:** quando `isMarketOpen()` retorna `false`, o system prompt inclui nota explícita para a IA enquadrar recomendações para a próxima abertura, sem sugerir entradas imediatas
- Contexto injetado via `buildPrompt()` com blocos numerados + confidence tags + CB statuses
- **Confidence scores por fonte:** cada bloco do prompt é acompanhado de tag de confiança calculada por `confidenceScorer.ts`. Dados com score BAIXO são marcados como `[DADOS DESATUALIZADOS]` no prompt
- **Circuit breaker statuses:** o prompt inclui o estado atual de cada circuit breaker para que a IA avalie quais dados podem estar indisponíveis
- Resposta em streaming via SSE — texto aparece em tempo real (max 1200 tokens)
- Renderização em Markdown com headers, listas e destaques
- Idioma padrão: Português

### Memória de Análise IA
- Ao fim de cada análise, `analysisMemory.ts` salva no Supabase (`ai_analyses`):
  - Texto completo da análise (`full_text`)
  - Resumo gerado por GPT-4o-mini (2-3 frases) e **resumo compacto** (`compact_summary`) para contexto no prompt
  - Embedding vetorial do resumo via `text-embedding-3-small` (armazenado como `vector(1536)` nativo via pgvector)
  - Snapshot de mercado no momento (spyPrice, vix, ivRank)
  - Structured output (bias + key_levels + campos de estratégia)
  - **Metadados de memória:** `analysis_date`, `is_archived`, `analysis_session_id` (para agrupamento e poda)
- As últimas 3 análises das últimas 24h são injetadas no próximo prompt como contexto histórico (usa `compact_summary` quando disponível)
- Falha de persistência não bloqueia o fluxo principal (try/catch silencioso)

**Política de retenção e poda:**
- **7 dias:** todas as análises mantidas completas
- **8–30 dias:** 1 análise por dia por usuário (a de maior confidence), demais arquivadas (`is_archived = TRUE`)
- **Após 90 dias:** `full_text` é limpo (`NULL`) nas linhas arquivadas para liberar espaço; metadados, summary e embedding permanecem
- **Edge Function `prune-analyses`:** chama a função SQL `prune_old_analyses()` diariamente (agendamento recomendado: 02:00 UTC no Supabase Dashboard ou cron externo)

### Pesquisa Semântica (pgvector)
- `POST /api/search` recebe uma query em linguagem natural e retorna as análises históricas semanticamente mais relevantes
- Fluxo: query → `text-embedding-3-small` (embedding 1536 dims) → RPC `search_historical_analyses` → cosine similarity via `<=>` operator do pgvector
- Índice HNSW (`vector_cosine_ops`, m=16, ef_construction=64) para busca aproximada rápida
- Parâmetros configuráveis: `threshold` (similaridade mínima, padrão 0.7) e `limit` (máx. resultados, padrão 5)
- Filtro por `user_id` — cada usuário vê apenas as suas próprias análises
- Migration `20260228000001_pgvector_search.sql`: ativa extensão `vector`, migra coluna `embedding TEXT → vector(1536)`, cria índice HNSW e função RPC

### Expected Move (Cone de Probabilidade) — Put Spreads 21–45 DTE
- **Cálculo:** soma do preço da Call ATM e da Put ATM (straddle) por vencimento, a partir da cadeia Tradier para 21 e 45 DTE
- **Serviço:** `expectedMoveService.ts` — resolve vencimentos 21/45 DTE, obtém cadeia Tradier, define strike ATM (menor `|strike - spot|`), Expected Move = call_mid + put_mid (mid = (bid+ask)/2, fallback `last`)
- **Estado:** `expectedMoveState.ts` — snapshot em memória `byExpiry` + `capturedAt`; consumido pelo prompt da IA
- **Poller:** `expectedMovePoller.ts` — primeiro tick após 10s, depois 60s (mercado aberto) / 5min (fora); atualiza snapshot sem zerar em falha
- **Integração IA:** bloco **Expected Move (1σ)** no prompt com cone (SPY − EM a SPY + EM) por vencimento; instrução no system prompt para **alertar criticamente** se a perna vendida do Put Spread estiver dentro do cone (risco mal dimensionado)
- Foco em operações estruturais (trava de alta com puts): a perna vendida deve ficar fora do cone de 1 desvio padrão (~68% probabilidade)

### GEX + Volume Profile
- **GEX (Gamma Exposure):** calculado a partir de option data real da Tradier (`tradierOptionData.ts` + `gexCalculator.ts`)
  - Modelo Black-Scholes para gamma via `gexService.ts`
  - **Multi-DTE:** GEX por bucket de expiração (0DTE, 1D, 7D, 21D, 45D, ALL) — `calculateAllExpirationsGex()` em `gexService.ts`; cache por expiração (`gex:exp:{symbol}:{exp}`, TTL 5min); publicado como `gexByExpiration` no evento SSE `advanced-metrics`
  - Métricas por bucket: `total`, `callWall`, `putWall`, `flipPoint`, `regime`, `maxGexStrike`; formato tabular injetado no prompt IA via `buildGexMultiDTEBlock()` (framework de 4 camadas: regime vol → GEX DTE → strike PoP → técnico)
  - `byStrike`: top 20 strikes por `|netGEX|` enviados via SSE com `{ strike, netGEX, callGEX, putGEX, callOI, putOI }`
- **Análise focada em GEX:** `POST /api/analyze/gex-flow` — endpoint SSE em streaming com gpt-4o-mini para análise da estrutura de GEX por DTE (acionado pelo botão "Analisar Fluxo" no GEXPanel)
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
- Injetado no prompt IA (via `fetch_24h_context` tool) com contexto sobre contango vs. backwardation

### Indicadores Técnicos (locais)
- RSI(14), MACD (12,26,9) e Bollinger Bands (20 períodos, 2σ) calculados diretamente de `marketState.spy.priceHistory` — **sem dependência de API externa**
- `technicalIndicatorsPoller.ts` re-escrito para cálculo local: usa os 390 bars 1min do histórico intraday em memória (mapeados de `PricePoint[]` para `number[]` internamente)
- `deriveBBPosition(spyPrice, bbands)`: classifica posição do preço relativa às bandas (`above_upper | near_upper | middle | near_lower | below_lower`)
- Poll reduzido de 60s para **5min** — retry automático em 60s enquanto aguarda ≥35 bars; sem spam de log quando mercado está fechado
- Publicado via SSE e injetado no prompt IA (bloco base — sempre presente)
- `TechnicalIndicatorsCard.tsx` exibe RSI gauge, MACD histogram + crossover badge e BB position badge no dashboard

### Sinais de Trade em Horários Fixos (10:30 e 15:00 ET)

- **Análise global agendada:** o mesmo agente IA usado em "Analisar com IA" roda automaticamente às **10:30 ET** e **15:00 ET** em dias úteis, sem depender do clique do usuário.
- **Uma execução por horário:** o backend dispara uma única análise por slot (lock Redis `lock:scheduled_signal:YYYY-MM-DD:slot`), reutilizando `buildPrompt`, regime veto, vanna/charm e `extractStructuredOutput`.
- **Função reutilizável:** `runAnalysisForPayload()` em `openai.ts` executa a análise sem streaming (retorna `{ fullText, structured }`); o handler `POST /api/analyze` e o `scheduledSignalService` usam a mesma lógica.
- **Cache e broadcast:** resultado gravado em Redis (`cache:trade_signal:latest`, TTL 14h); evento SSE `trade_signal_update` com payload `{ trade_signal, regime_score, no_trade_reasons, bias, key_levels, timestamp }` é enviado a todos os clientes conectados.
- **Novos clientes:** ao conectar ao SSE, o último sinal é lido do Redis e enviado no snapshot inicial.
- **Frontend:** widget "Último sinal (10:30/15:00 ET)" (`LastScheduledSignal.tsx`) exibe Operar/Aguardar/Não operar, regime X/10, horário ET e, se houver, `no_trade_reasons` (tooltip). Estado em `lastScheduledSignal` no store; evento `trade_signal_update` tratado em `useMarketStream.ts`.
- **Scheduler:** `scheduledSignalService.ts` — `startScheduledSignalScheduler()` registrado no `index.ts` após os restores (verificação a cada 60s; horários 10:30 e 15:00 ET).

### Pre-Market Briefing Automático

- **Briefing às 9:00 ET** (seg–sex): gerado automaticamente 30min antes da abertura via Claude 3.5 Sonnet (fallback GPT-4o) — sem interação do usuário
- **Resumo pós-fechamento às 16:15 ET**: avaliação da sessão do dia e perspectiva para amanhã
- **Cooldown diário via Redis** (`cache:premarket_briefing:YYYY-MM-DD`, TTL 14h): o briefing é gerado uma única vez por dia; reinicializações do servidor restauram o briefing do cache sem nova chamada à API
- **Prompts institucionais** (`preMarketBriefing.ts`): constantes `PRE_MARKET_PROMPT` (Estrategista Quantitativo Chefe — GEX, IV Rank, VIX, Risco Macro, Veredito Sniper) e `POST_MARKET_PROMPT` (Gestor de Risco — Resumo do Fechamento, Auditoria de Portfólio, Ações Exigidas). Regras inegociáveis: zero ruído, concisão extrema (&lt;2.500 caracteres), estrutura obrigatória em bullet points.
- **IA:** Claude 3.5 Sonnet com `max_tokens: 4096`; fallback para GPT-4o com o mesmo limite. Resposta em Markdown.
- **Preço pré-market do SPY**: capturado via Tradier timesales (`session_filter=all`, último bar antes de 09:30 ET), com fallback para preço DXFeed disponível
- **Entrega via SSE** (`event: briefing`): clientes conectados recebem o briefing em tempo real; novos clientes recebem no snapshot inicial de conexão (se ainda válido)
- **Discord Webhook** (`DISCORD_WEBHOOK_URL`): briefing enviado em **embeds** (texto em `embeds[].description`, limite 4096 caracteres por embed). Cores da paleta: Pré-Market `#00ff88` (65416), Pós-Market `#ffcc00` (16763904). Se o texto ultrapassar 4.000 caracteres, divisão inteligente em dois embeds (quebra em `\n`). Fire-and-forget; falha não afeta o SSE.
- **Expiração automática**: briefing pre-market expira às 10:30 ET; pós-fechamento às 06:00 ET do dia seguinte
- Frontend: card destacado `PreMarketBriefing.tsx` com gradiente verde (design system: `#00ff88`), accordion collapse (inicia colapsado com preview da primeira linha), renderização Markdown via `react-markdown`, auto-dismiss às 10:00 ET, botão "×" manual; posicionado acima do `AIPanel`

### Motor de Gestão de Ciclo de Vida (Put Spreads)
- **Objetivo:** rastrear posições de Put Spreads abertas e aplicar a regra de saída: fechar em 50% do lucro máximo OU quando faltarem ≤21 dias para o vencimento (21 DTE), mitigando risco de cauda e convexidade do Gamma.
- **Tabela Supabase:** `portfolio_positions` (id, symbol, strategy_type, open_date, expiration_date, short_strike, long_strike, short_option_symbol, long_option_symbol, credit_received, status OPEN/CLOSED). Migration `20260305000000_portfolio_positions.sql`.
- **Serviço:** `portfolioTrackerService.ts` — executa **1x ao dia às 16:00 ET** (scheduler com verificação a cada 60s). Lock Redis `lock:portfolio_tracker:YYYY-MM-DD` (TTL 300s) evita duplicidade em HA.
- **Ciclo:** (1) Busca posições com status OPEN no Supabase; (2) Calcula DTE em dias úteis (`diasUteisEntre(hoje_ET, expiration_date)`); (3) Tradier `getQuotes()` para short/long (uma chamada batelada); (4) `current_debit = short_ask - long_bid`, `profit_percentage = ((credit_received - current_debit) / credit_received) * 100`; (5) Payload enriquecido enviado ao Claude (Gestor de Risco).
- **Agente Claude:** `portfolioLifecycleAgent.ts` — system prompt com regras: profit ≥50% → FECHAR_LUCRO; dte ≤21 → FECHAR_TEMPO ou ROLAR; senão MANTER. Resposta JSON com array `alerts` (position_id, recommendation, message).
- **Discord:** alertas enviados via webhook com **embeds** — cor verde (50% lucro) ou amarela (21 DTE); mensagem acionável para Tastytrade (recompra Debit a mercado). Usa o mesmo `DISCORD_WEBHOOK_URL` do briefing.
- **Snapshot para o dashboard:** o ciclo das 16:00 e o refresh manual gravam o último enriquecimento em memória (`getPortfolioSnapshot` / `refreshPortfolioSnapshot`). Evita chamadas Tradier a cada abertura do painel; cooldown de 60s no refresh.
- **Endpoints API:** `GET /api/portfolio` (retorna `positions` + `capturedAt` do cache), `POST /api/portfolio/refresh` (re-enriquece com Tradier e atualiza cache), `POST /api/portfolio/analyze` (usa snapshot atual e retorna `alerts` do Claude Gestor de Risco).
- **Painel no dashboard:** card "Carteira — Put Spreads" (`PortfolioPanel.tsx`) com tabela (estratégia, DTE, lucro %, crédito, custo fechar), badges 50% (verde) e ≤21 DTE (amarelo), botões Cadastrar, Atualizar e Analisar carteira; modal de cadastro (`AddPositionModal.tsx`) com **seletor de estratégia** (Put Spread, Call Spread, Iron Condor), formulário 2 pernas ou 4 pernas (Iron Condor gera duas linhas no banco), "Gerar símbolos OCC" (P/C); botão Excluir por linha. Hook `usePortfolio.ts` consome os endpoints.

### Análise de Risco/Retorno Assimétrica (Put Spread)
- **Objetivo:** avaliar propostas de Bull Put Spread (21–45 DTE) cruzando o payoff matemático com o calendário macroeconômico e a parede GEX, retornando decisão CRO (APPROVED / REJECTED / NEEDS_RESTRUCTURE) e justificativa técnica.
- **Motor de payoff:** `lib/putSpreadPayoff.ts` — `calculatePutSpreadPayoff(shortStrike, longStrike, creditReceived)` retorna `strike_width`, `max_profit`, `max_loss`, `risk_reward_ratio`, `breakeven`, `margin_required` (por contrato).
- **Calendário macro:** `macroCalendar.ts` — `getMacroEventsForWindow(startDate, endDate)` retorna apenas eventos de **alto impacto** (ex.: FOMC, CPI, NFP, GDP) entre hoje e a data de vencimento; fonte: `newsSnapshot.macroEvents` ou cache Redis.
- **Endpoint:** `POST /api/analyze/risk-review` (JWT + mesmo rate limit da análise). Body: `short_strike`, `long_strike`, `credit_received_per_contract`, `dte` (21–45), `expiration_date` opcional. Payload enviado ao Claude 3.5 Sonnet: `proposed_trade` (com payoff_profile), `market_context` (SPY, major_negative_gex_level do bucket GEX 21D/45D, IV Rank), `binary_risk_events`.
- **System prompt CRO:** o modelo atua como Diretor de Risco: (1) exige crédito ≥ 1/3 da largura do spread; (2) cruza DTE com eventos binários (FOMC/CPI perto do vencimento → exige prêmio maior); (3) aprova estrutura se breakeven acima da put wall GEX, senão sugere rolagem. Resposta JSON: `decision`, `justification`.

### Alertas de Preço em Tempo Real
- Após cada análise IA, o `alertEngine.ts` registra os `key_levels` do structured output como alertas ativos do usuário (até 10 alertas; nova análise substitui todos os anteriores)
- A cada tick de preço (via eventos `quote` do SSE), `checkAlerts(price)` avalia todos os alertas ativos:
  - `approaching`: preço dentro de 0.2% do nível (`PROXIMITY_WARN`)
  - `testing`: preço dentro de 0.05% do nível (`PROXIMITY_TEST`)
  - Debounce de 60s por alerta para evitar spam
  - Só dispara durante horário de mercado (NYSE 09:30–16:00 ET)
- Alertas enviados via `broadcastToUser(userId, 'alert', {...})` — roteamento por usuário no SSE
- Frontend: `AlertOverlay.tsx` exibe notificações em overlay fixo (top-right), slide-in/out com Framer Motion, auto-dismiss em 8s, dismissível por clique

### Feed de Mercado
Painel com cinco fontes de dados exibidas no frontend, agregadas via SSE (earnings apenas no backend/IA):

| Seção | Fonte | Frequência |
|---|---|---|
| **Dados Macro (FRED)** | Federal Reserve St. Louis | A cada 24h |
| **Dados Macro (BLS)** | Bureau of Labor Statistics | A cada 24h |
| **Eventos Macro** | Finnhub Economic Calendar | A cada 1h |
| **Headlines** | GNews | A cada 30min |
| **Fear & Greed** | CNN (endpoint público) | A cada 4h |

**Earnings (backend/IA):** poller a cada 6h com 50 símbolos em 5 setores (janela -7 a +90 dias); usado no pre-market briefing, tool calling da IA (DTE≤7) e contexto macro — sem componente visual no Feed de Mercado.

**Dados Macro FRED:** CPI All Items, Core CPI, PCE Deflator, Fed Funds Rate e Yield Curve (T10Y2Y), com direção vs. leitura anterior e color-coding semântico.

**Dados Macro BLS:** Unemployment Rate, Nonfarm Payrolls, Average Hourly Earnings e PPI Final Demand, via BLS API v2.

**Eventos Macro:** calendário prospectivo de eventos US de alto e médio impacto com horário em ET, consenso de analistas e valor anterior.

**Headlines:** 10 headlines recentes filtradas por Fed, FOMC, S&P 500, juros, CPI, NFP, SPY e volatilidade, com links diretos para a fonte.

**Fear & Greed:** gauge semicircular SVG com score 0–100 e 5 zonas de cor (Medo Extremo → Ganância Extrema).

### Dashboard UI
- Três cards principais: **SPY**, **VIX**, **IV Rank** (IV Rank % em destaque; IVx e Percentil como secundários)
- **GEX Panel:** gráfico de barras por strike (calls/puts), seletor de tabs por DTE (0DTE/1D/7D/21D/45D/ALL), métricas callWall/putWall/flipPoint, regime, P/C Ratio com barra visual, botão "Analisar Fluxo" para análise focada em GEX
- **Último sinal (10:30/15:00 ET):** widget compacto com trade_signal (Operar/Aguardar/Não operar), regime_score e no_trade_reasons (tooltip); alimentado pelo evento SSE `trade_signal_update`.
- **Carteira (Put Spreads):** painel com posições OPEN enriquecidas (DTE, lucro %, crédito, custo fechar), badges de regra 50%/21 DTE; botão "Cadastrar" abre modal com seletor de estratégia (Put Spread, Call Spread, Iron Condor), formulário 2 ou 4 pernas e geração de símbolos OCC; "Atualizar" (refresh com cooldown 60s); "Analisar carteira"; "Excluir" por linha.
- **Card "Estratégia Sugerida":** exibe pernas da estratégia (call/put, buy/sell, strike, DTE), badges de DTE/PoP/invalidação e métricas de risco/crédito/theta/breakeven
- **Cadeia de Opções:** calls e puts ATM ±n strikes com bid/ask + greeks completos **Δ γ θ ν** por strike (calculados via Black-Scholes no backend, exibidos por `OptionChainPanel.tsx`)
- **Alert Overlay:** notificações de alerta de preço em overlay fixo, animadas com Framer Motion
- Tema escuro customizado com Tailwind CSS
- Animações de entrada/saída com Framer Motion
- Skeletons de carregamento
- Indicador de status da conexão com contagem de reconexões

### Cadeia de Opções (Option Chain)
- Dados SPY: calls e puts por DTE (0, 1, 7, 21, 45 dias) — filtro ±3 dias em relação ao alvo
- Cache em memória de 5 minutos no backend (endpoint `GET /api/option-chain`)
- Greeks Δ (delta), γ (gamma), θ (theta), ν (vega) por strike — fonte primária: API Tradier; fallback: Black-Scholes (`blackScholes.ts` + `enrichLeg()`)
- Incluída automaticamente no prompt da IA ao clicar em "Analisar com IA": o hook `useAIAnalysis` busca `/api/option-chain`, seleciona os 5 strikes mais próximos do ATM para cada uma das 3 expirações mais próximas e inclui bid/ask de calls e puts no contexto enviado ao GPT-4o

### Autenticação
- Supabase Auth com email e senha
- JWT validado no backend em todas as rotas protegidas
- Token Bearer no header HTTP (ou query param `?token=` para SSE)
- **Persistência segura do refresh token Tastytrade:** armazenado no Redis com criptografia AES-256-GCM (`tokenManager.ts`), TTL 30 dias

### Rate Limiting
- Análise IA: **5 análises por hora por usuário** via sliding window (`rateLimiter.ts`) + cooldown entre requisições consecutivas

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
│       │   ├── openai.ts       # Análise GPT-4o streaming (Tool Calling + Structured Outputs)
│       │   ├── riskReview.ts   # POST /api/analyze/risk-review — CRO Put Spread (payoff + macro + GEX)
│       │   ├── sse.ts          # Stream de mercado SSE (broadcast global + por usuário; quote/vix; trade_signal_update)
│       │   ├── priceHistory.ts # GET /api/price-history
│       │   ├── gex.ts          # GET /api/gex (snapshot) + /api/gex/detail (full Redis cache)
│       │   ├── volumeProfile.ts # GET /api/volume-profile (snapshot) + /detail (full)
│       │   ├── analysisSearch.ts # POST /api/search — pesquisa semântica pgvector
│       │   └── portfolio.ts   # GET/POST /api/portfolio, POST/DELETE /api/portfolio/positions
│       ├── auth/               # OAuth2 Tastytrade
│       │   ├── tokenManager.ts # Refresh automático + AES-256-GCM encryption no Redis
│       │   └── streamerToken.ts
│       ├── middleware/
│       │   ├── authMiddleware.ts  # Validação JWT Supabase
│       │   └── rateLimiter.ts    # Sliding window 5 análises/hora por usuário
│       ├── stream/             # Conexão DXFeed
│       │   ├── dxfeedClient.ts # WebSocket + parser de quotes
│       │   └── reconnector.ts  # Reconexão com backoff
│       ├── data/               # Estado e polling
│       │   ├── marketState.ts       # Estado centralizado + EventEmitter + newsSnapshot
│       │   │                        # MAX_HISTORY=390 (6.5h de sessão, 1 bar/min)
│       │   ├── ivRankPoller.ts      # Poll IV Rank 60s (Tastytrade)
│       │   ├── optionChain.ts       # Fetch + cache de options (Tastytrade)
│       │   ├── priceHistory.ts      # Persistência Supabase + restoreFromTradier()
│       │   ├── earningsCalendar.ts  # Earnings 50 símbolos (Tastytrade, 6h; janela -7..90d; backend/IA)
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
│       │   ├── expectedMoveService.ts   # Expected Move (straddle ATM) 21/45 DTE via Tradier
│       │   ├── expectedMoveState.ts     # Snapshot Expected Move em memória (prompt IA)
│       │   ├── expectedMovePoller.ts   # Poll 60s/5min; primeiro tick 10s após startup
│       │   ├── vixTermStructure.ts      # inferTermStructure() a partir de option chain
│       │   ├── vixTermStructurePoller.ts # Poll 5min; aguarda option chain no startup
│       │   ├── vixTermStructureState.ts  # Snapshot VIX term structure em memória
│       │   ├── technicalIndicatorsPoller.ts # RSI/MACD/BBANDS calculados de priceHistory (local)
│       │   ├── technicalIndicatorsState.ts  # Snapshot indicadores técnicos em memória
│       │   ├── alertEngine.ts       # Alertas de preço por usuário (proximity + debounce)
│       │   ├── preMarketBriefing.ts      # Scheduler 9:00/16:15 ET + Claude 3.5 Sonnet briefing + Discord embeds
│       │   ├── scheduledSignalService.ts # Scheduler 10:30/15:00 ET + runAnalysisForPayload + Redis + SSE trade_signal_update
│       │   ├── portfolioTrackerService.ts # Scheduler 16:00 ET + DTE + Tradier + Claude Gestor Risco + Discord
│       │   ├── portfolioLifecycleAgent.ts  # Payload + system prompt + chamada Claude (alerts JSON)
│       │   └── analysisMemory.ts    # Persistência análise IA no Supabase + embeddings pgvector
│       ├── lib/                # Utilitários
│       │   ├── circuitBreaker.ts    # Opossum wrapper: CLOSED/HALF_OPEN/OPEN; registry global
│       │   ├── confidenceScorer.ts  # Score 0.0–1.0 por fonte (frescor × CB multiplier)
│       │   ├── cacheStore.ts        # Cache Redis (ioredis) + compressão Brotli (payloads >1KB)
│       │   ├── restoreCache.ts      # Restaura 8 chaves Redis no startup (incluindo ivrank + vix)
│       │   ├── sseBatcher.ts        # Batch de eventos newsfeed em janela de 500ms
│       │   ├── time.ts              # isMarketOpen() DST-aware ET — compartilhado entre pollers
│       │   ├── tradierClient.ts     # TradierClient singleton: getQuotes(), getTimeSales(), getOptionChain(), getExpirations()
│       │   ├── blackScholes.ts      # Black-Scholes: calcDelta, calcGamma, calcTheta, calcVega
│       │   ├── putSpreadPayoff.ts   # Payoff Bull Put Spread: strike_width, max_profit, max_loss, breakeven, risk_reward_ratio
│       │   └── gexCalculator.ts     # Black-Scholes gamma: Nd1(), calcGamma(), buildProfile()
│       └── types/
│           ├── market.ts       # Interfaces TypeScript (todos os tipos compartilhados)
│           └── portfolio.ts    # Tipos portfolio_positions, EnrichedPosition, GestorRiscoResponse
│
├── frontend/                   # React 18 SPA
│   └── src/
│       ├── App.tsx             # Componente raiz + auth gate
│       ├── store/
│       │   └── marketStore.ts  # Zustand (estado global: mercado + newsFeed + GEX + alerts)
│       ├── hooks/
│       │   ├── useMarketStream.ts  # EventSource → store (eventos SSE: macro, alertas, GEX, quote, vix)
│       │   ├── useAIAnalysis.ts    # Streaming GPT-4o + coleta option chain
│       │   ├── useAuth.ts          # Supabase Auth
│       │   ├── useMarketOpen.ts    # Horário de mercado EUA
│       │   └── usePortfolio.ts     # GET portfolio, refresh, analyze (Carteira Put Spreads)
│       ├── components/
│       │   ├── cards/          # SPYCard, VIXCard, IVRankCard
│       │   ├── ai/             # AIPanel + AnalysisResult + PreMarketBriefing + LastScheduledSignal
│       │   ├── options/
│       │   │   ├── GEXPanel.tsx        # Painel GEX: gráfico byStrike + callWall/putWall/flipPoint
│       │   │   └── OptionChainPanel.tsx # Cadeia de opções ATM com greeks Δ γ θ ν
│       │   ├── portfolio/
│       │   │   └── PortfolioPanel.tsx  # Carteira Put Spreads: tabela, badges, Analisar carteira
│       │   ├── news/           # NewsFeedPanel e subcomponentes
│       │   │   ├── NewsFeedPanel.tsx      # Container (5 seções visíveis; earnings só no backend)
│       │   │   ├── MacroData.tsx
│       │   │   ├── MacroCalendar.tsx
│       │   │   ├── NewsHeadlines.tsx
│       │   │   ├── FearGreedGauge.tsx
│       │   │   └── PutCallRatioCard.tsx   # P/C Ratio com barra visual
│       │   ├── charts/         # Recharts (GEXPanel)
│       │   ├── layout/         # Header + StatusBar
│       │   ├── ui/             # ConnectionDot, TickFlash, Skeleton, AlertOverlay
│       │   │   └── AlertOverlay.tsx       # Overlay de alertas de preço (Framer Motion)
│       │   └── auth/           # LoginPage (Supabase)
│       └── lib/
│           ├── formatters.ts   # Utilitários de formatação
│           └── supabase.ts     # Cliente Supabase
│
├── supabase/
│   ├── migrations/
│   │   ├── 20260228000000_enable_rls.sql        # RLS em ai_analyses + price_ticks
│   │   ├── 20260228000001_pgvector_search.sql   # pgvector, HNSW index, RPC search
│   │   ├── 20260304000000_ai_analyses_memory_columns.sql  # compact_summary, analysis_date, is_archived, analysis_session_id
│   │   └── 20260304000001_prune_old_analyses.sql # Função prune_old_analyses() — retenção e archive
│   └── functions/
│       └── prune-analyses/   # Edge Function: chama prune_old_analyses() (cron 02:00 UTC)
│
├── legacy/                     # Versão anterior HTML/JS
├── start.sh                    # Script de inicialização unificado
└── README.md
```

### Fluxo de Dados — Mercado em Tempo Real

```
DXFeed WebSocket → marketState (EventEmitter) → sse.ts (listeners quote + vix)
                                               → broadcast + snapshot na conexão
                                               → useMarketStream.ts → Zustand store

Startup (paralelo, sem bloquear listen()):
  ├─ initTokenManager (timeout 10s)
  ├─ restoreSnapshotsFromCache (timeout 8s)
  ├─ intraday chain (timeout 20s):
  │    restoreIntradayFromRedis() → restorePriceHistory() → restoreFromTradier()
  │    (filtra apenas hoje; Supabase busca 5 dias; Tradier sobrescreve com 390 bars)
  ├─ SPY quote chain (timeout 13s):
  │    restoreSPYQuoteFromCache() → restoreSPYQuoteFromTradier()
  │    (14h TTL no Redis; Tradier retorna last mesmo com mercado fechado)
  └─ restoreBriefingFromCache (timeout 5s):
       cache:premarket_briefing:YYYY-MM-DD ou cache:postclose_briefing:YYYY-MM-DD

Após restores: startIntradayCachePersistence() + pollers iniciam + startPreMarketScheduler() + startScheduledSignalScheduler() + startPortfolioTrackerScheduler()
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

### Fluxo de Dados — Expected Move (21/45 DTE)

```
Tradier API (getExpirations + getOptionChain por 21/45 DTE)
  → expectedMoveService.ts (straddle ATM = Call_mid + Put_mid por expiração)
  → expectedMovePoller.ts (60s mercado aberto / 5min fora; primeiro tick 10s)
  → expectedMoveState.ts (snapshot byExpiry + capturedAt)
  → openai.ts buildExpectedMoveBlock() → prompt IA + system prompt (alerta perna vendida dentro do cone)
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
  → Zustand store → AIPanel (injetado no prompt via fetch_24h_context)
```

### Fluxo de Dados — Indicadores Técnicos

```
marketState.spy.priceHistory (390 bars 1min — em memória)
  → technicalIndicatorsPoller.ts (cálculo local)
  → RSI(14) + MACD(12,26,9) + BBands(20,2σ) calculados via séries de closes
  → publishTechnicalData() quando todos 3 calculados
  → technicalIndicatorsState.ts (snapshot em memória)
  → openai.ts buildTechBlock() (injeta no prompt base ao clicar em Analisar)
     + deriveBBPosition(spyPrice, bbands) → posição relativa às bandas
```

### Fluxo de Dados — Análise IA (Tool Calling)

```
Usuário clica "Analisar com IA"
  → GET /api/option-chain  (cache 5min)
  → lê snapshots: gex, vixTermStructure, technicals, priceHistory
  → GET últimas análises do Supabase (analysisMemory, últimas 24h)
  → POST /api/analyze { marketSnapshot, optionChain, context, gex, technicals }
  → buildPrompt() monta texto com blocos base + confidence tags + CB statuses
    ├─ buildTechBlock() — RSI/MACD/BBands + VWAP + desvio VWAP%
    ├─ buildPriceHistoryBlock() — OHLC sessão, range%, curva ~15min, tendência 1h, HV intraday
    ├─ buildExpectedMoveBlock() — Expected Move (1σ) por vencimento 21/45 DTE, cone SPY±EM, regra perna vendida fora do cone
    └─ IV/HV(30d) ratio com flag [VOL CARA] se > 1.3
  + system prompt: aviso "mercado fechado" quando !isMarketOpen()

  Chamada 1 — GPT-4o stream (tool_choice: 'auto'):
    → Se modelo chamar fetch_24h_context:
        buildMacroContextBlock() → Fear&Greed, VIX TS, FRED, BLS, earnings, eventos
        Chamada 2 — GPT-4o stream (role: tool, conteúdo macro)
    → SSE stream token a token → Markdown em tempo real

  Após stream:
    → extractStructuredOutput() via json_schema Structured Outputs (única chamada GPT-4o)
    → event: structured → UI cards bias/confiança/levels/estratégia
  → saveAnalysis() → Supabase ai_analyses (embedding: vector(1536), async)
  → registerAlertsFromAnalysis() → alertEngine ativa alertas por userId
```

### Fluxo de Dados — Pesquisa Semântica

```
POST /api/search { query, threshold?, limit? }
  → openai.embeddings.create('text-embedding-3-small', query) → vector(1536)
  → supabase.rpc('search_historical_analyses', { query_embedding, threshold, limit, p_user_id })
  → HNSW index cosine similarity (<=> operator)
  → resultados ordenados por similaridade DESC
  → { results: [{ summary, bias, market_snapshot, similarity, ... }], count }
```

### Fluxo de Dados — Alertas de Preço

```
GPT-4o structured output { key_levels: { support, resistance, gex_flip } }
  → registerAlertsFromAnalysis(userId, structured)
  → alertsByUser Map<userId, ActiveAlert[]>

Evento quote do SSE (atualização de preço SPY/VIX)
  → checkAlerts(price)
  → priceDiff ≤ PROXIMITY_TEST (0.05%) → 'testing'
  → priceDiff ≤ PROXIMITY_WARN (0.2%) → 'approaching'
  → broadcastToUser(userId, 'alert', {...})
  → clientsByUser SSE routing
  → AlertOverlay.tsx exibe notificação
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

### Cache Redis — Cobertura e TTLs

| Chave | Dado | TTL | Fonte | Compressão Brotli | Restaurado no startup? |
|---|---|---|---|---|---|
| `tradier:chain:<sym>:<exp>` | Option chain completa | 5min | Tradier | ✓ | — |
| `tradier:timesales:<sym>` | Bars 1min (time & sales) | 30s | Tradier | ✓ | — |
| `tradier:quotes:<syms>` | Quotes (last, change) | 30s | Tradier | — | — |
| `tradier:expirations:<sym>` | Datas de expiração | 60s | Tradier | — | — |
| `gex:daily:<sym>` | GEX completo por strike | 5min | Tradier | ✓ | — |
| `volume_profile:<sym>` | POC / VAH / VAL / buckets | 2min | Tradier | ✓ | — |
| `put_call_ratio:<sym>` | Ratio puts/calls + label | 90s | Tradier | — | — |
| `spy_intraday` | PricePoint[] SPY (até 390 pts, 1min) | 14h | DXFeed/Tradier | ✓ | ✓ (hoje) |
| `vix_intraday` | PricePoint[] VIX (até 390 pts, 1min) | 14h | DXFeed | ✓ | ✓ (hoje) |
| `spy_quote_snapshot` | last/bid/ask/OHLCV/change/changePct SPY | 14h | Tradier | — | ✓ |
| `ivrank_snapshot` | IV Rank % + percentil + IVx + HV30 | 14h | Tastytrade | — | ✓ |
| `vix_snapshot` | VIX last + change | 14h | Finnhub/Tradier | — | ✓ |
| `technical_indicators:SPY` | RSI14 + MACD + BBANDS | 60min | Local (priceHistory) | ✓ | ✓ |
| `fear_greed` | Score CNN 0–100 | 4h | CNN | — | ✓ |
| `fred_macro` | CPI/PCE/Fed Rate/Yield | 24h | FRED | ✓ | ✓ |
| `bls_macro` | NFP/Desemprego/PPI/AHE | 24h | BLS | ✓ | ✓ |
| `gnews_headlines` | 10 headlines filtradas | 30min | GNews | — | ✓ |
| `macro_events` | Calendário econômico US | 1h | Finnhub | — | ✓ |
| `earnings` | Earnings top 10 SPY | 6h | Tastytrade | ✓ | ✓ |
| `cache:premarket_briefing:YYYY-MM-DD` | Briefing pre-market Claude/GPT-4o (markdown) | 14h | Anthropic/OpenAI | ✓ | ✓ |
| `cache:postclose_briefing:YYYY-MM-DD` | Resumo pós-fechamento Claude/GPT-4o (markdown) | 14h | Anthropic/OpenAI | ✓ | ✓ |
| `cache:trade_signal:latest` | Último sinal agendado (10:30/15:00 ET): trade_signal, regime_score, no_trade_reasons, bias, key_levels, timestamp | 14h | runAnalysisForPayload | ✓ | — (enviado no snapshot SSE) |
| `auth:tt_refresh_token` | Refresh token TT (AES-256-GCM) | 30d | Tastytrade | — | — |

> Payloads >1KB são automaticamente comprimidos com Brotli por `cacheStore.ts` (prefixo `b:` para retrocompatibilidade). Reduz consumo no Redis Cloud free tier (30MB).

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

### Segurança — Row Level Security (Supabase)

Migration `20260228000000_enable_rls.sql` ativa RLS nas tabelas principais:

| Tabela | RLS | Política |
|---|---|---|
| `ai_analyses` | ✓ | SELECT/INSERT/UPDATE/DELETE apenas para `user_id = auth.uid()` |
| `price_ticks` | ✓ | Sem políticas para clients — acesso exclusivo via service role key |
| `portfolio_positions` | ✓ | Sem políticas para clients — acesso exclusivo via service role key (Motor de Ciclo de Vida) |
| `price_sparkline` | — (matview) | Sem suporte a RLS; acesso via service role key |

O backend usa `SUPABASE_SERVICE_ROLE_KEY` (bypassa RLS) para todas as operações server-side.

---

## APIs e Endpoints

### HTTP

| Endpoint | Método | Auth | Descrição |
|---|---|---|---|
| `/health` | GET | — | Status binário: `{ "status": "ok" \| "degraded" }` |
| `/health/details` | GET | `X-Health-Token` | Detalhes completos: dataAge, circuit breakers, SSE clients, uptime |
| `/stream/market` | GET (SSE) | JWT | Stream de eventos macro, alertas, GEX, newsfeed, quote e vix (preço SPY/VIX) |
| `/api/analyze` | POST (SSE) | JWT | Análise GPT-4o em streaming (Tool Calling + Structured Outputs) |
| `/api/analyze/gex-flow` | POST (SSE) | JWT | Análise focada em GEX por DTE (streaming gpt-4o-mini) |
| `/api/analyze/risk-review` | POST | JWT | Crítica CRO de Put Spread: payoff + eventos macro na janela DTE → decision + justification (Claude 3.5 Sonnet) |
| `/api/search` | POST | JWT | Pesquisa semântica em análises históricas (pgvector) |
| `/api/option-chain` | GET | JWT | Snapshot da cadeia de opções SPY com greeks Δ γ θ ν |
| `/api/price-history` | GET | JWT | Histórico de preços por símbolo |
| `/api/gex` | GET | JWT | Snapshot GEX atual (in-memory, atualizado a cada 60s) |
| `/api/gex/detail` | GET | JWT | GEX completo com todos os strikes (lê do cache Redis) |
| `/api/volume-profile` | GET | JWT | Snapshot Volume Profile atual (in-memory, atualizado a cada 60s) |
| `/api/volume-profile/detail` | GET | JWT | Volume Profile completo com todos os buckets |
| `/api/portfolio` | GET | JWT | Snapshot das posições enriquecidas (cache em memória; atualizado no ciclo 16:00 ou em refresh) |
| `/api/portfolio/refresh` | POST | JWT | Re-enriquece posições OPEN via Tradier e atualiza cache (cooldown 60s) |
| `/api/portfolio/analyze` | POST | JWT | Retorna recomendações do Claude Gestor de Risco (`alerts`) para as posições atuais |
| `/api/portfolio/positions` | POST | JWT | Cadastra posição OPEN: 2 pernas (Put/Call spread) ou Iron Condor (4 pernas → 2 linhas no banco; body com put_*/call_* e credit_received total) |
| `/api/portfolio/positions/:id` | DELETE | JWT | Exclui posição (ex.: correção de cadastro com erro) |
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
| `ivrank` | IV Rank %, percentil, rótulo |
| `status` | Estado da conexão WebSocket, tentativas de reconexão |
| `advanced-metrics` | `{ gex: { total, callWall, putWall, flipPoint, regime, byStrike[] }, profile: { poc, vah, val }, putCallRatio: { ratio, putVolume, callVolume, label } }` |
| `vix-term-structure` | `{ structure: 'normal'\|'inverted'\|'flat', steepness: number, curve: [{ dte, iv }] }` |
| `alert` | `{ level, type: 'support'\|'resistance'\|'gex_flip', alertType: 'approaching'\|'testing', price, timestamp }` (apenas para o usuário dono do alerta) |
| `newsfeed-batch` | Batch de múltiplos tipos de newsfeed em uma única mensagem `{ batch: { [type]: payload } }` |
| `newsfeed` | Payload polimórfico com campo `type` (legacy): |
| ↳ `type: earnings` | `items: EarningsItem[]` — earnings dos top 10 SPY |
| ↳ `type: macro` | `items: MacroDataItem[]` — séries FRED |
| ↳ `type: bls` | `items: MacroDataItem[]` — séries BLS |
| ↳ `type: macro-events` | `items: MacroEvent[]` — calendário Finnhub |
| ↳ `type: headlines` | `items: NewsHeadline[]` — headlines GNews |
| ↳ `type: sentiment` | `fearGreed: FearGreedData` — score CNN Fear & Greed |
| `briefing` | `{ type: 'pre-market'\|'post-close', generatedAt, markdown, expiresAt }` — briefing automático 9:00/16:15 ET; enviado no snapshot inicial se válido |
| `trade_signal_update` | `{ trade_signal, regime_score, no_trade_reasons, bias, key_levels, timestamp }` — sinal agendado 10:30/15:00 ET; enviado no snapshot inicial se existir em Redis |
| `ping` | Heartbeat a cada 15s (timestamp) — mantém conexão viva em proxies |

> Preço SPY e VIX em tempo real são servidos via eventos `quote` e `vix` do SSE (`/stream/market`), com snapshot na conexão inicial.

---

## Stack Tecnológico

### Backend

| Tecnologia | Versão | Uso |
|---|---|---|
| Node.js | 20+ | Runtime |
| Fastify | 4.26 | Servidor HTTP |
| TypeScript | 5.3 | Linguagem |
| ws | — | WebSocket DXFeed |
| OpenAI SDK | — | GPT-4o (Tool Calling + Structured Outputs) + text-embedding-3-small |
| ioredis | — | Cache Redis com compressão Brotli automática |
| Supabase Admin SDK | — | Validação JWT + persistência análises + histórico de preços + pgvector |
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
| Recharts | 2.12 | Gráfico GEX (barras por strike) |
| Framer Motion | 11 | Animações + AlertOverlay |
| react-markdown | 9 | Renderização da IA |
| Supabase JS | — | Autenticação |

### Integrações Externas

| Serviço | Uso | Key necessária |
|---|---|---|
| Tastytrade API | OAuth2, IV Rank, option chain, earnings | Sim (OAuth2) |
| DXFeed | Quotes SPY/VIX em tempo real via WebSocket | Via Tastytrade |
| Tradier API | GEX (option chain), Volume Profile (time-sales), VIX fallback, SPY price history | Sim |
| OpenAI | GPT-4o (análise + Tool Calling), text-embedding-3-small (memória + pesquisa semântica) | Sim |
| Redis Cloud | Cache de dados de mercado com TTL + Brotli; token seguro (30MB gratuito) | Sim (gratuito em redis.io/try-free) |
| Supabase | Autenticação JWT + persistência análises IA + pgvector (busca semântica) + histórico de preços | Sim |
| FRED (Federal Reserve) | CPI, PCE, Fed Rate, Yield Curve | Sim (gratuita) |
| Finnhub | VIX quote (fallback), calendário econômico prospectivo | Sim (gratuita) |
| GNews | Headlines de mercado em tempo real | Sim (gratuita) |
| BLS | NFP, CPI, Desemprego (baixa latência) | Sim (gratuita) |
| CNN Fear & Greed | Score de sentimento 0–100 | Não (público) |

---

## Configuração e Instalação

### Pré-requisitos

- Node.js 20+
- Conta Tastytrade com acesso à API
- Conta Tradier com acesso à API (production: `api.tradier.com`)
- API Key OpenAI com acesso ao GPT-4o
- Banco Redis Cloud (gratuito em redis.io/try-free — 30MB, sem configuração adicional)
- Projeto Supabase (gratuito em supabase.com) com tabelas `price_ticks`, `price_sparkline`, `ai_analyses` e extensão `pgvector` ativada
- API Key FRED (gratuita em fred.stlouisfed.org/docs/api/fred/)
- API Key Finnhub (gratuita em finnhub.io)
- API Key GNews (gratuita em gnews.io)
- API Key BLS (gratuita em bls.gov/developers/)

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

# Redis (cache de dados de mercado — GEX, Tradier, FRED, CNN, etc.)
# Formato: redis://default:SENHA@HOST:PORTA  (obtido no painel Redis Cloud)
REDIS_URL=redis://default:<senha>@<host>:<porta>

# Chave de criptografia para o refresh token Tastytrade (AES-256-GCM)
# Gere com: openssl rand -hex 32
ENCRYPTION_KEY=<gere_com_openssl_rand_hex_32>

# Supabase (auth, AI memory, price history, pgvector)
SUPABASE_URL=https://<projeto>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>

# Discord Webhook — briefing pre-market/pós-fechamento + alertas do Motor de Ciclo de Vida (opcional)
# Crie em: Servidor Discord → Integrações → Webhooks
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
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
- Streaming DXFeed (SPY + VIX) em tempo real via SSE (eventos `quote` e `vix` no `/stream/market`; snapshot na conexão)
- VIX com fallback chain DXFeed → Finnhub → Tradier
- OAuth2 Tastytrade com refresh automático de token (refresh token criptografado AES-256-GCM no Redis)
- Polling IV Rank a cada 60s; inclui HV(30d) da Tastytrade
- Cadeia de opções SPY com cache em memória (5min) e greeks Δ γ θ ν via Black-Scholes
- Broadcast SSE para múltiplos clientes com reconexão automática
- Histórico de preços intraday SPY/VIX como `PricePoint[] ({t, p})` com restauração em cadeia: Redis (14h) → Supabase (5 dias) → Tradier (390 bars 1min); persistido no Redis a cada 60s
- Quote SPY restaurada no startup via Redis (14h) e Tradier (funciona com mercado fechado)
- Persistência de ticks de preço no Supabase (throttle 1min/símbolo)
- Bootstrap não-bloqueante: `listen()` sobe imediatamente; restores paralelos com `withTimeout()`

**GEX + Volume Profile + Indicadores + Expected Move:**
- GEX por strike (Black-Scholes gamma) via Tradier option data — callWall, putWall, flipPoint, regime
- Volume Profile intraday (POC, VAH, VAL) via Tradier time-sales
- Put/Call Ratio com barra visual por expiração
- **Expected Move (1σ)** para 21 e 45 DTE (straddle ATM via Tradier); bloco no prompt IA e regra de alerta quando perna vendida do Put Spread está dentro do cone
- VIX Term Structure inferida da option chain (normal/inverted/flat, steepness%)
- Indicadores técnicos RSI(14), MACD, BBANDS calculados localmente de `priceHistory` (sem API externa)

**Análise IA:**
- Painel "Análise IA" com GPT-4o streaming
- Tool Calling condicional `fetch_24h_context` — macro context apenas quando necessário
- Structured Outputs nativo via `json_schema` — objeto estruturado em única chamada GPT-4o
- Histórico intraday SPY injetado no prompt base (`buildPriceHistoryBlock`): OHLC, range%, curva ~15min, tendência 1h, HV intraday estimada
- VWAP da sessão injetado no bloco técnico (capturado da última barra Tradier)
- Ratio IV/HV(30d) no prompt com flag `[VOL CARA]` quando > 1.3
- Aviso explícito à IA quando mercado está fechado (system prompt dinâmico via `isMarketOpen()`)
- Confidence scores por fonte + marcação de dados desatualizados no prompt
- Circuit breaker statuses no contexto da IA
- Memória de análise: 3 análises recentes injetadas no próximo prompt (últimas 24h)
- Persistência de análises no Supabase com embeddings `vector(1536)` (pgvector)
- Alertas de preço em tempo real (support/resistance/gex_flip) por usuário
- Rate limiting: 5 análises/hora por usuário (sliding window)
- **Sinais de trade em horários fixos:** scheduler 10:30 e 15:00 ET (dias úteis); uma análise global por horário via `runAnalysisForPayload()`; resultado em Redis e broadcast SSE `trade_signal_update`; widget "Último sinal" no dashboard.
- **Motor de Gestão de Ciclo de Vida:** scheduler 16:00 ET para Put Spreads (posições OPEN em `portfolio_positions`); DTE + lucro % via Tradier; Claude Gestor de Risco (FECHAR_LUCRO / FECHAR_TEMPO / ROLAR / MANTER); alertas Discord com embeds (verde 50%, amarelo 21 DTE). Painel **Carteira** no dashboard com snapshot em memória, Cadastrar (modal com gerador OCC), Excluir por linha, endpoints GET/POST portfolio, POST analyze, POST/DELETE positions.
- **Análise de Risco/Retorno Assimétrica:** `POST /api/analyze/risk-review` — motor de payoff Put Spread (`putSpreadPayoff.ts`) + eventos macro de alto impacto na janela DTE (`getMacroEventsForWindow`) + contexto GEX; Claude 3.5 Sonnet como CRO retorna decisão (APPROVED/REJECTED/NEEDS_RESTRUCTURE) e justificativa técnica.

**Pesquisa Semântica:**
- `POST /api/search` — busca em análises históricas por similaridade cosine (pgvector HNSW)
- Filtro por usuário + threshold configurável

**Feed de Mercado:**
- Earnings via Tastytrade (6h; 50 símbolos em 5 setores; janela -7..90d) — backend/IA apenas; sem componente no frontend
- Dados Macro via FRED: CPI, Core CPI, PCE, Fed Funds Rate, Yield Curve T10Y2Y (24h)
- Dados Macro via BLS: Unemployment Rate, Nonfarm Payrolls, Avg Hourly Earnings, PPI Final Demand (24h)
- Calendário de Eventos Econômicos via Finnhub: US high/medium impact (1h)
- Headlines de mercado via GNews com query focada em Fed/macro/SPY (30min)
- Fear & Greed Index via CNN com gauge SVG semicircular (4h)
- Snapshot imediato para novos clientes SSE conectados (todos os tipos de dados)
- SSEBatcher: batching de eventos newsfeed em janela de 500ms

**Infraestrutura:**
- Circuit breakers para todas as APIs externas (opossum)
- Cache Redis com TTL + compressão Brotli automática em payloads >1KB (`cacheStore.ts`)
- Restauração de cache no startup (`restoreCache.ts`) — 8 chaves restauradas + intraday + quote SPY
- TTLs de 14h para `ivrank_snapshot`, `vix_snapshot`, `spy_intraday`, `vix_intraday`, `spy_quote_snapshot` — sobrevivem ao fechamento do mercado e reinícios overnight
- Bootstrap não-bloqueante: `withTimeout()` por operação garante que o servidor sobe mesmo se Redis/Supabase/Tradier estiverem lentos
- DXFeed watchdog com `lastFeedDataAt` — evita loops de reconexão em fins de semana
- `priceHistory` só acumula ponto quando `last` está explicitamente no payload (`updateSPY/VIX`) — elimina duplicatas em ticks de bid/ask
- `putCallRatio`: retorna `null` quando volume total = 0 (mercado fechado / sem dados Tradier)
- `OPTION_CHAIN_THRESHOLD` padrão alterado de 0.003 para 0.01
- Confidence scorer por fonte de dados (`confidenceScorer.ts`)
- SSE roteado por usuário (`broadcastToUser`) para alertas direcionados
- RLS em `ai_analyses` e `price_ticks` (migration `20260228000000_enable_rls.sql`)
- Endpoint `/admin/breakers` para gestão de circuit breakers

**UI & Autenticação:**
- Dashboard React com 3 cards de métricas (SPY, VIX, IV Rank)
- **TechnicalIndicatorsCard** (`TechnicalIndicatorsCard.tsx`): RSI(14) gauge, MACD histogram + crossover badge, BB position badge
- Painel GEX com gráfico de barras por strike (calls/puts)
- Cadeia de Opções com greeks Δ γ θ ν por strike
- Alert Overlay com animação slide-in/out (Framer Motion, auto-dismiss 8s)
- Painel "Feed de Mercado" com 6 seções em layout de 3 colunas
- Vite dev proxy para `/ws` com `ws: true` (WebSocket direto para backend sem CORS)
- Supabase Auth com email/senha (JWT validado no backend)
- Animações Framer Motion + Tailwind dark theme
- Skeletons de carregamento + Recharts (GEX)

### Planejado / Em Desenvolvimento

- Rastreamento de posições e portfólio
- Suporte a múltiplos ativos além do SPY
- Internacionalização (i18n)

### Limitações Conhecidas

- Fear & Greed usa endpoint CNN não oficial — pode mudar sem aviso (com fallback implementado)
- Finnhub free tier não autoriza uso comercial
- GNews free tier limitado a 100 req/dia
- VIX Term Structure depende da option chain estar fresca (≤6min); pula se stale
- Redis Cloud free tier (30MB) sem persistência garantida — restart do Redis limpa o cache, mas os pollers repopulam automaticamente na próxima execução. IV Rank, VIX, Volume Profile, P/C Ratio, Indicadores Técnicos, e histórico intraday têm cache Redis com TTL de 14h e são restaurados no startup quando disponíveis.
- DXFeed não emite Trade events para o SPY quando o mercado está fechado — `prevDayClosePrice` do Summary event é usado como fallback para `last`, mas os campos de bid/ask/change podem ser `null`. O `spy_quote_snapshot` (Redis 14h) garante que o card SPY exibe o preço correto após reinicialização.

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

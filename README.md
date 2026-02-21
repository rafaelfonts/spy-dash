# SPY Dash

Dashboard de trading em tempo real focado em opções de SPY, com streaming de dados de mercado ao vivo, análise gerada por IA e feed de contexto macroeconômico.

---

## Visão Geral

SPY Dash integra dados de mercado em tempo real via Tastytrade/DXFeed com análise GPT-4o e um feed de contexto completo (earnings, dados macro, eventos econômicos, headlines e sentimento de mercado), entregando um painel profissional para operadores de opções que precisam de velocidade e contexto ao mesmo tempo.

**Stack:** React 18 + Vite no frontend, Fastify + TypeScript no backend, comunicação via Server-Sent Events (SSE).

---

## Funcionalidades

### Dados de Mercado em Tempo Real
- Preço, bid/ask, volume e máx./mín. do dia do SPY via WebSocket DXFeed
- Índice VIX com histórico de sparkline (60 pontos)
- IV Rank percentual atualizado a cada 60 s via Tastytrade API
- Flash de tick animado a cada atualização de preço
- Indicador "AO VIVO" quando o mercado americano está aberto

### Streaming Resiliente
- Conexão WebSocket com reconexão automática (backoff exponencial, até 20 tentativas)
- Detecção de dados stale: reconecta automaticamente se não houver update por mais de 90 s
- Broadcast SSE para múltiplos clientes simultâneos
- Endpoint `/health` com idade do dado mais recente

### Análise por IA (GPT-4o)
- Análise gerada com contexto real: preço SPY, nível VIX, IV Rank e chain de opções
- Resposta em streaming via SSE — texto aparece em tempo real
- Renderização em Markdown com headers, listas e destaques
- Idioma padrão: Português

### Feed de Mercado
Painel abaixo da Análise IA com cinco fontes de dados agregadas via SSE:

| Seção | Fonte | Frequência |
|---|---|---|
| **Earnings Calendar** | Tastytrade API | A cada 6h |
| **Dados Macro (FRED)** | Federal Reserve St. Louis | A cada 24h |
| **Dados Macro (BLS)** | Bureau of Labor Statistics | A cada 24h |
| **Eventos Macro** | Finnhub Economic Calendar | A cada 1h |
| **Headlines** | GNews | A cada 30min |
| **Fear & Greed** | CNN (endpoint público) | A cada 4h |

**Earnings Calendar:** próximos earnings dos 10 maiores componentes do SPY, ordenados por DTE, com alertas de urgência (≤3 dias = vermelho, ≤14 dias = amarelo).

**Dados Macro FRED:** CPI All Items, Core CPI, PCE Deflator, Fed Funds Rate e Yield Curve (T10Y2Y), com direção vs. leitura anterior e color-coding semântico.

**Dados Macro BLS:** Unemployment Rate, Nonfarm Payrolls, Average Hourly Earnings e PPI Final Demand, via BLS API v2. Exibidos na mesma seção do FRED com sub-headers "FRED" e "BLS" e formatação por unidade (%, K jobs, $/h, idx).

**Eventos Macro:** calendário prospectivo de eventos US de alto e médio impacto com horário em ET, consenso de analistas e valor anterior.

**Headlines:** 10 headlines recentes filtradas por Fed, FOMC, S&P 500, juros, CPI, NFP, SPY e volatilidade, com links diretos para a fonte.

**Fear & Greed:** gauge semicircular SVG com score 0–100 e 5 zonas de cor (Medo Extremo → Ganância Extrema).

### Dashboard UI
- Três cards principais: **SPY**, **VIX**, **IV Rank**
- Sparklines com tooltips (Recharts)
- Tema escuro customizado com Tailwind CSS
- Animações de entrada/saída com Framer Motion
- Skeletons de carregamento
- Indicador de status da conexão com contagem de reconexões

### Cadeia de Opções (Option Chain)
- Dados SPY: calls e puts por DTE (0, 1, 7, 21, 45 dias)
- Cache em memória de 5 minutos
- Alimenta automaticamente o prompt de análise da IA

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
│       ├── config.ts           # Variáveis de ambiente
│       ├── api/                # Endpoints HTTP
│       │   ├── health.ts       # Status do servidor
│       │   ├── openai.ts       # Análise GPT-4o (SSE)
│       │   └── sse.ts          # Stream de mercado (SSE)
│       ├── auth/               # OAuth2 Tastytrade
│       │   ├── tokenManager.ts # Refresh automático de tokens
│       │   └── streamerToken.ts
│       ├── middleware/
│       │   └── authMiddleware.ts  # Validação JWT Supabase
│       ├── stream/             # Conexão DXFeed
│       │   ├── dxfeedClient.ts # WebSocket + parser de quotes
│       │   └── reconnector.ts  # Reconexão com backoff
│       ├── data/               # Estado e polling
│       │   ├── marketState.ts  # Estado centralizado + EventEmitter + newsSnapshot
│       │   ├── ivRankPoller.ts # Poll IV Rank 60s (Tastytrade)
│       │   ├── optionChain.ts  # Fetch + cache de options (Tastytrade)
│       │   ├── earningsCalendar.ts  # Earnings top 10 SPY (Tastytrade, 6h)
│       │   ├── fredPoller.ts   # CPI/PCE/Fed Rate/Yield Curve (FRED, 24h)
│       │   ├── blsPoller.ts    # NFP/Desemprego/PPI/Earnings (BLS, 24h)
│       │   ├── macroCalendar.ts     # Eventos econômicos EUA (Finnhub, 1h)
│       │   ├── newsAggregator.ts    # Headlines de mercado (GNews, 30min)
│       │   └── fearGreed.ts    # Fear & Greed score (CNN, 4h)
│       └── types/
│           └── market.ts       # Interfaces TypeScript
│
├── frontend/                   # React 18 SPA
│   └── src/
│       ├── App.tsx             # Componente raiz + auth gate
│       ├── store/
│       │   └── marketStore.ts  # Zustand (estado global: mercado + newsFeed)
│       ├── hooks/
│       │   ├── useMarketStream.ts  # EventSource → store (todos os eventos SSE)
│       │   ├── useAIAnalysis.ts    # Streaming GPT-4o
│       │   ├── useAuth.ts          # Supabase Auth
│       │   └── useMarketOpen.ts    # Horário de mercado EUA
│       ├── components/
│       │   ├── cards/          # SPYCard, VIXCard, IVRankCard
│       │   ├── ai/             # AIPanel + AnalysisResult
│       │   ├── news/           # NewsFeedPanel e subcomponentes
│       │   │   ├── NewsFeedPanel.tsx   # Container principal (5 seções)
│       │   │   ├── EarningsCalendar.tsx
│       │   │   ├── MacroData.tsx
│       │   │   ├── MacroCalendar.tsx
│       │   │   ├── NewsHeadlines.tsx
│       │   │   └── FearGreedGauge.tsx
│       │   ├── charts/         # PriceSparkline (Recharts)
│       │   ├── layout/         # Header + StatusBar
│       │   ├── ui/             # ConnectionDot, TickFlash, Skeleton
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
DXFeed WebSocket
  → Backend: marketState (EventEmitter)
  → SSE broadcast → Browser EventSource
  → Zustand store
  → React re-renders
```

### Fluxo de Dados — Feed de Mercado

```
Pollers independentes (6h / 24h / 1h / 30min / 4h) — 6 módulos
  → newsSnapshot (in-memory cache)
  → emitter.emit('newsfeed', { type, items })
  → SSE broadcast → Browser EventSource
  → Zustand newsFeed slice
  → NewsFeedPanel re-renders

Novo cliente SSE conectado:
  → snapshot imediato dos 5 tipos de dados em cache
```

### Fluxo de Dados — Análise IA

```
Usuário clica "Analisar com IA"
  → POST /api/analyze (snapshot: SPY, VIX, IV Rank, options chain)
  → GPT-4o stream
  → SSE response token a token
  → Markdown renderizado em tempo real
```

---

## APIs e Endpoints

### HTTP

| Endpoint | Método | Auth | Descrição |
|---|---|---|---|
| `/health` | GET | — | Status do servidor e idade do dado |
| `/stream/market` | GET (SSE) | JWT | Stream de todos os eventos de mercado |
| `/api/analyze` | POST (SSE) | JWT | Análise GPT-4o em streaming |
| `/api/option-chain` | GET | JWT | Snapshot da cadeia de opções SPY |

### Eventos SSE (`/stream/market`)

| Evento | Tipo / Payload |
|---|---|
| `quote` | Preço SPY, bid, ask, volume, máx/mín, priceHistory |
| `vix` | Preço VIX, variação, nível (low/moderate/high) |
| `ivrank` | IV Rank %, percentil, rótulo |
| `status` | Estado da conexão WebSocket, tentativas de reconexão |
| `newsfeed` | Payload polimórfico com campo `type`: |
| ↳ `type: earnings` | `items: EarningsItem[]` — earnings dos top 10 SPY |
| ↳ `type: macro` | `items: MacroDataItem[]` — séries FRED |
| ↳ `type: bls` | `items: MacroDataItem[]` — séries BLS (NFP, Desemprego, PPI, AHE) |
| ↳ `type: macro-events` | `items: MacroEvent[]` — calendário Finnhub |
| ↳ `type: headlines` | `items: NewsHeadline[]` — headlines GNews |
| ↳ `type: sentiment` | `fearGreed: FearGreedData` — score CNN Fear & Greed |

---

## Stack Tecnológico

### Backend

| Tecnologia | Versão | Uso |
|---|---|---|
| Node.js | 20+ | Runtime |
| Fastify | 4.26 | Servidor HTTP |
| TypeScript | 5.3 | Linguagem |
| ws | — | WebSocket DXFeed |
| OpenAI SDK | — | GPT-4o |
| Supabase Admin SDK | — | Validação JWT |
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
| Recharts | 2.12 | Sparklines |
| Framer Motion | 11 | Animações |
| react-markdown | 9 | Renderização da IA |
| Supabase JS | — | Autenticação |

### Integrações Externas

| Serviço | Uso | Key necessária |
|---|---|---|
| Tastytrade API | OAuth2, IV Rank, option chain, earnings | Sim (OAuth2) |
| DXFeed | Quotes SPY/VIX em tempo real via WebSocket | Via Tastytrade |
| OpenAI | GPT-4o para análise de mercado | Sim |
| Supabase | Autenticação JWT (email/senha) | Sim |
| FRED (Federal Reserve) | CPI, PCE, Fed Rate, Yield Curve | Sim (gratuita) |
| Finnhub | Calendário econômico prospectivo | Sim (gratuita) |
| GNews | Headlines de mercado em tempo real | Sim (gratuita) |
| BLS | NFP, CPI, Desemprego (baixa latência) | Sim (gratuita) |
| CNN Fear & Greed | Score de sentimento 0–100 | Não (público) |

---

## Configuração e Instalação

### Pré-requisitos

- Node.js 20+
- Conta Tastytrade com acesso à API
- API Key OpenAI com acesso ao GPT-4o
- Projeto Supabase (gratuito em supabase.com)
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
- OAuth2 Tastytrade com refresh automático de token
- Polling IV Rank a cada 60 s
- Cadeia de opções SPY com cache em memória (5 min)
- Broadcast SSE para múltiplos clientes com reconexão automática

**Feed de Mercado (News Feed):**
- Earnings Calendar dos top 10 componentes do SPY via Tastytrade (6h)
- Dados Macro via FRED: CPI, Core CPI, PCE, Fed Funds Rate, Yield Curve T10Y2Y (24h)
- Dados Macro via BLS: Unemployment Rate, Nonfarm Payrolls, Avg Hourly Earnings, PPI Final Demand (24h)
- Calendário de Eventos Econômicos via Finnhub: US high/medium impact (1h)
- Headlines de mercado via GNews com query focada em Fed/macro/SPY (30min)
- Fear & Greed Index via CNN com gauge SVG semicircular (4h)
- Snapshot imediato para novos clientes SSE conectados (6 tipos de dados)

**UI & Autenticação:**
- Dashboard React com 3 cards de métricas (SPY, VIX, IV Rank)
- Painel "Análise IA" com GPT-4o streaming
- Painel "Feed de Mercado" com 5 seções em layout responsivo
- Supabase Auth com email/senha (JWT validado no backend)
- Animações Framer Motion + Tailwind dark theme
- Skeletons de carregamento + Sparklines Recharts

### Planejado / Em Desenvolvimento

- Persistência de histórico de preços no banco Supabase
- Indicadores técnicos (RSI, MACD, Bandas de Bollinger)
- Alertas de preço e volatilidade
- Rastreamento de posições e portfólio
- Suporte a múltiplos ativos além do SPY
- Internacionalização (i18n)

### Limitações Conhecidas

- Greeks das opções (delta, gamma, theta) ainda não populados pela API Tastytrade
- Fear & Greed usa endpoint CNN não oficial — pode mudar sem aviso (com fallback implementado)
- Finnhub free tier não autoriza uso comercial
- GNews free tier limitado a 100 req/dia

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

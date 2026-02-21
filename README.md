# SPY Dash

Dashboard de trading em tempo real focado em opções de SPY, com streaming de dados de mercado ao vivo e análise gerada por IA.

---

## Visão Geral

SPY Dash integra dados de mercado em tempo real via Tastytrade/DXFeed com análise gerada por GPT-4o, entregando um painel profissional para operadores de opções que precisam de velocidade e contexto ao mesmo tempo.

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
- Idioma configurável (padrão: Português)

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
- Sistema local simples para fase alpha (sem banco de dados)
- Sessão com validade de 8 horas armazenada em `sessionStorage`
- Preparado para integração Supabase (código comentado presente)

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
│       ├── stream/             # Conexão DXFeed
│       │   ├── dxfeedClient.ts # WebSocket + parser de quotes
│       │   └── reconnector.ts  # Reconexão com backoff
│       ├── data/               # Estado e polling
│       │   ├── marketState.ts  # Estado centralizado + EventEmitter
│       │   ├── ivRankPoller.ts # Poll IV Rank 60s
│       │   └── optionChain.ts  # Fetch + cache de options
│       └── types/
│           └── market.ts       # Interfaces TypeScript
│
├── frontend/                   # React 18 SPA
│   └── src/
│       ├── App.tsx             # Componente raiz + auth gate
│       ├── store/
│       │   └── marketStore.ts  # Zustand (estado global de mercado)
│       ├── hooks/
│       │   ├── useMarketStream.ts  # EventSource → store
│       │   ├── useAIAnalysis.ts    # Streaming GPT-4o
│       │   ├── useAuth.ts          # Sessão local
│       │   └── useMarketOpen.ts    # Horário de mercado EUA
│       ├── components/
│       │   ├── cards/          # SPYCard, VIXCard, IVRankCard
│       │   ├── ai/             # AIPanel + AnalysisResult
│       │   ├── charts/         # PriceSparkline (Recharts)
│       │   ├── layout/         # Header + StatusBar
│       │   ├── ui/             # ConnectionDot, TickFlash, Skeleton
│       │   └── auth/           # LoginPage
│       └── lib/
│           └── formatters.ts   # Utilitários de formatação
│
├── legacy/                     # Versão anterior HTML/JS
├── start.sh                    # Script de inicialização unificado
└── README.md
```

### Fluxo de Dados

```
DXFeed WebSocket
  → Backend: marketState (EventEmitter)
  → SSE broadcast → Browser EventSource
  → Zustand store
  → React re-renders

Usuário clica "Analisar com IA"
  → POST /api/analyze (com snapshot de mercado)
  → GPT-4o stream
  → SSE response
  → Markdown renderizado em tempo real
```

---

## APIs e Endpoints

| Endpoint | Método | Descrição |
|---|---|---|
| `/health` | GET | Status do servidor e idade do dado |
| `/stream/market` | GET (SSE) | Stream de quotes, VIX, IV Rank e status |
| `/api/analyze` | POST (SSE) | Análise GPT-4o em streaming |
| `/api/option-chain` | GET | Snapshot da cadeia de opções SPY |

### Eventos SSE (`/stream/market`)

| Evento | Payload |
|---|---|
| `quote` | Preço SPY, bid, ask, volume, máx/mín |
| `vix` | Preço VIX, variação, nível (low/moderate/high) |
| `ivrank` | IV Rank %, percentil, rótulo |
| `status` | Estado da conexão, tentativas de reconexão |

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

### Integrações Externas
| Serviço | Uso |
|---|---|
| Tastytrade API | OAuth2, IV Rank, option chain |
| DXFeed | Quotes SPY/VIX em tempo real via WebSocket |
| OpenAI | GPT-4o para análise de mercado |
| Supabase | (preparado — não ativo) |

---

## Configuração e Instalação

### Pré-requisitos
- Node.js 20+
- Conta Tastytrade com acesso à API
- API Key OpenAI com acesso ao GPT-4o

### Variáveis de Ambiente (backend/.env)

```env
# Tastytrade
TT_BASE=https://api.tastytrade.com
TT_CLIENT_ID=<seu_client_id>
TT_CLIENT_SECRET=<seu_client_secret>
TT_REFRESH_TOKEN=<seu_refresh_token>

# OpenAI
OPENAI_API_KEY=sk-proj-...

# Servidor
PORT=3001
CORS_ORIGIN=http://localhost:5173

# Supabase (opcional — para fase futura)
SUPABASE_URL=https://<projeto>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
```

### Instalação

```bash
# Backend
cd backend
npm install

# Frontend
cd frontend
npm install
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

## Credenciais Alpha

Fase alpha com autenticação local simples (sem banco de dados):

| Usuário | Senha |
|---|---|
| `admin` | `spydash` |
| `spy` | `dash2024` |

Sessões expiram após 8 horas.

---

## Estado Atual de Desenvolvimento

### Implementado
- Streaming WebSocket DXFeed (SPY + VIX) em tempo real
- OAuth2 Tastytrade com refresh automático de token
- Polling IV Rank a cada 60 s
- Broadcast SSE para múltiplos clientes
- Dashboard React com 3 cards de métricas
- Animações Framer Motion + Tailwind dark theme
- Integração GPT-4o com streaming de resposta
- Autenticação local (sessão 8h)
- Reconexão automática com backoff exponencial
- Cadeia de opções SPY com cache em memória (5 min)
- Sparklines com Recharts
- Versão legada HTML/JS mantida em `/legacy`

### Em Desenvolvimento / Planejado
- Integração Supabase Auth (código preparado)
- Persistência de histórico de preços no banco
- Indicadores técnicos adicionais (RSI, MACD, Bandas de Bollinger)
- Alertas de preço e volatilidade
- Rastreamento de posições e portfólio
- Otimização mobile e layout responsivo
- Suporte a múltiplos ativos além do SPY
- Internacionalização (i18n) — idioma atualmente fixo em PT-BR
- Temas claro/escuro alternáveis
- Templates de estratégias de opções

### Limitações Conhecidas
- Credenciais Tastytrade no `.env` em texto (fase alpha)
- Sem persistência de sessão entre reloads (sessionStorage)
- Greeks das opções (delta, gamma, theta) ainda não populados pela API
- Idioma de análise IA fixo em Português
- Sem tratamento de erros em nível de UI (error boundaries)
- Multi-usuário não suportado (auth local simples)

---

## Tema Visual

Paleta customizada escura (definida em `tailwind.config.js`):

| Token | Cor | Uso |
|---|---|---|
| `bg-base` | `#0a0a0f` | Fundo global |
| `bg-card` | `#12121a` | Fundo dos cards |
| `bg-elevated` | `#1a1a26` | Elementos elevados |
| `accent-green` | `#00ff88` | Alta / bullish |
| `accent-red` | `#ff4444` | Baixa / bearish |
| `text-primary` | `#e8e8f0` | Texto principal |
| `text-secondary` | `#8888aa` | Texto secundário |

---

## Contribuindo

O projeto está em fase alpha ativa. Estrutura de branches sugerida:

- `main` — código estável
- `feature/*` — novas funcionalidades
- `fix/*` — correções

Abra uma issue antes de iniciar mudanças estruturais.

---

*SPY Dash — Construído para operadores de opções que precisam de velocidade e contexto.*

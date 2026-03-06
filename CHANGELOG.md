# Changelog

## [Unreleased]

### Corrigido
- **Silent failure Anthropic:** logs explícitos quando o Claude falha e o fallback OpenAI é acionado (`[FALLBACK TRIGGERED]`, `[CRITICAL] ANTHROPIC_API_KEY is missing`); fallback do circuit breaker (Opossum) passa a logar o motivo do erro; evento `done` da rota `/api/analyze` inclui `provider: "Anthropic"` ou `"OpenAI Fallback"`; embed Discord do briefing exibe footer "Gerado por: Claude 3.5 Sonnet" ou "GPT-4o (Fallback)".
- **404 modelo Anthropic:** substituição de `claude-3-5-sonnet-20241022` por `claude-3-5-sonnet-latest` em todo o backend (openai.ts, preMarketBriefing.ts, riskReview.ts, portfolioLifecycleAgent.ts) para evitar `not_found_error` no tier atual da API.

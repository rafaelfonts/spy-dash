# Changelog

## [Unreleased]

### Corrigido
- **Silent failure Anthropic:** logs explícitos quando o Claude falha e o fallback OpenAI é acionado (`[FALLBACK TRIGGERED]`, `[CRITICAL] ANTHROPIC_API_KEY is missing`); fallback do circuit breaker (Opossum) passa a logar o motivo do erro; evento `done` da rota `/api/analyze` inclui `provider: "Anthropic"` ou `"OpenAI Fallback"`; embed Discord do briefing exibe footer "Gerado por: Claude 3.5 Sonnet" ou "GPT-4o (Fallback)".
- **404 modelo Anthropic:** substituição de `claude-3-5-sonnet-20241022` por `claude-3-5-sonnet-latest` em todo o backend (openai.ts, preMarketBriefing.ts, riskReview.ts, portfolioLifecycleAgent.ts) para evitar `not_found_error` no tier atual da API.
- **Modelo Anthropic descontinuado:** default de `ANTHROPIC_MODEL` alterado para `claude-sonnet-4-6` (Claude Sonnet 4.6), pois a linha Claude 3.5 Sonnet foi descontinuada pela Anthropic; continua configurável via env no Fly.io.

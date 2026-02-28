interface SourceConfig {
  name: string
  publishCycleMs: number      // ciclo de publicação esperado
  maxAcceptableAgeMs: number  // idade máxima antes de degradar ao mínimo
}

const SOURCES: Record<string, SourceConfig> = {
  spy:         { name: 'SPY Quote',     publishCycleMs: 1_000,        maxAcceptableAgeMs: 30_000 },
  vix:         { name: 'VIX',           publishCycleMs: 1_000,        maxAcceptableAgeMs: 30_000 },
  ivRank:      { name: 'IV Rank',       publishCycleMs: 60_000,       maxAcceptableAgeMs: 180_000 },
  fearGreed:   { name: 'Fear & Greed',  publishCycleMs: 4*3600_000,   maxAcceptableAgeMs: 8*3600_000 },
  macro:       { name: 'Macro FRED',    publishCycleMs: 24*3600_000,  maxAcceptableAgeMs: 48*3600_000 },
  bls:         { name: 'Macro BLS',     publishCycleMs: 24*3600_000,  maxAcceptableAgeMs: 48*3600_000 },
  macroEvents: { name: 'Eventos Macro', publishCycleMs: 3600_000,     maxAcceptableAgeMs: 7200_000 },
  headlines:   { name: 'Headlines',     publishCycleMs: 1800_000,     maxAcceptableAgeMs: 3600_000 },
  earnings:    { name: 'Earnings',      publishCycleMs: 6*3600_000,   maxAcceptableAgeMs: 12*3600_000 },
  optionChain: { name: 'Option Chain',  publishCycleMs: 300_000,      maxAcceptableAgeMs: 600_000 },
  technicals:  { name: 'Indicadores Técnicos', publishCycleMs: 15 * 60_000, maxAcceptableAgeMs: 60 * 60_000 },
}

export interface ConfidenceResult {
  score: number                      // 0.00–1.00 (rounded to 2 decimal places; 0 = sem rastreabilidade)
  label: 'ALTA' | 'MÉDIA' | 'BAIXA'
}

/**
 * Calcula a confiança de uma fonte de dados baseado em:
 *   1. Frescor relativo ao ciclo de publicação esperado (degradação linear)
 *   2. Status do circuit breaker (OPEN/HALF_OPEN reduzem confiança)
 *
 * Pure function — sem side effects, sem async.
 * Retorna { score: 0, label: 'BAIXA' } quando capturedAt é null/undefined
 * (indica dado sem rastreabilidade, não necessariamente dado ruim).
 */
export function calculateConfidence(
  sourceKey: string,
  capturedAt: string | null | undefined,
  circuitBreakerStatus?: string,  // 'CLOSED' | 'HALF_OPEN' | 'OPEN'
): ConfidenceResult {
  const config = SOURCES[sourceKey]
  if (!config || !capturedAt) {
    return { score: 0, label: 'BAIXA' }
  }

  const ageMs = Date.now() - new Date(capturedAt).getTime()

  // Fator 1: Frescor relativo ao ciclo de publicação (0.2–1.0)
  let freshness: number
  if (ageMs <= config.publishCycleMs) {
    freshness = 1.0
  } else if (ageMs >= config.maxAcceptableAgeMs) {
    freshness = 0.2
  } else {
    // Degradação linear entre publishCycleMs e maxAcceptableAgeMs
    const ratio = (ageMs - config.publishCycleMs) /
      (config.maxAcceptableAgeMs - config.publishCycleMs)
    freshness = 1.0 - ratio * 0.8  // de 1.0 até 0.2
  }

  // Fator 2: Circuit breaker (multiplicador)
  const cbMultiplier =
    circuitBreakerStatus === 'OPEN'      ? 0.3 :
    circuitBreakerStatus === 'HALF_OPEN' ? 0.6 : 1.0

  const raw = Math.max(0.1, Math.min(1.0, freshness * cbMultiplier))
  const score = Math.round(raw * 100) / 100

  const label: ConfidenceResult['label'] =
    score >= 0.8 ? 'ALTA' : score >= 0.5 ? 'MÉDIA' : 'BAIXA'

  return { score, label }
}

import CircuitBreaker from 'opossum'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAsyncFn = (...args: any[]) => Promise<any>

const DEFAULT_OPTIONS = {
  timeout: 10_000,                 // 10s per request
  errorThresholdPercentage: 50,    // open if >50% fail
  resetTimeout: 60_000,            // try to close after 60s
  volumeThreshold: 3,              // minimum 3 calls before evaluating
}

const registry = new Map<string, CircuitBreaker>()

export function createBreaker(
  fn: AnyAsyncFn,
  name: string,
  options: Partial<typeof DEFAULT_OPTIONS> = {},
): CircuitBreaker {
  const breaker = new CircuitBreaker(fn, { ...DEFAULT_OPTIONS, ...options })

  const resetSec = (options.resetTimeout ?? DEFAULT_OPTIONS.resetTimeout) / 1000
  breaker.on('open', () =>
    console.warn(`[CB:${name}] ABERTO — pausando chamadas por ${resetSec}s`))
  breaker.on('halfOpen', () =>
    console.info(`[CB:${name}] HALF-OPEN — testando recuperação`))
  breaker.on('close', () =>
    console.info(`[CB:${name}] FECHADO — API recuperada`))
  breaker.fallback(() => {
    console.warn(`[CB:${name}] Usando fallback (último dado válido)`)
    return null
  })

  registry.set(name, breaker)
  return breaker
}

/** Returns a snapshot of every registered breaker's state for /health. */
export function getBreakerStatuses(): Record<string, string> {
  const statuses: Record<string, string> = {}
  for (const [name, breaker] of registry) {
    if (breaker.opened) statuses[name] = 'OPEN'
    else if (breaker.halfOpen) statuses[name] = 'HALF_OPEN'
    else statuses[name] = 'CLOSED'
  }
  return statuses
}

/**
 * Manually closes a breaker (transitions OPEN → CLOSED).
 * Returns false if the breaker name is not found.
 */
export function resetBreaker(name: string): boolean {
  const breaker = registry.get(name)
  if (!breaker) return false
  breaker.close()
  console.info(`[CB:${name}] Reset manual — forçado para CLOSED`)
  return true
}

/** Lists all registered breaker names. */
export function listBreakers(): string[] {
  return [...registry.keys()]
}

import { z } from 'zod'

/**
 * Fetches a URL, parses JSON, and validates against a Zod schema.
 * Returns the validated data and a flag indicating if stale/fallback data was used.
 *
 * @param url - The URL to fetch
 * @param schema - Zod schema to validate the response against
 * @param fallback - Fallback value used when fetch or validation fails
 * @param sourceName - Name used in error log prefixes (e.g. 'FearGreed')
 * @param init - Optional fetch options (e.g. for POST requests or custom headers)
 */
export async function fetchAndValidate<T>(
  url: string,
  schema: z.ZodSchema<T>,
  fallback: T,
  sourceName: string,
  init?: RequestInit,
): Promise<{ data: T; isStale: boolean }> {
  try {
    const res = await fetch(url, init)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw: unknown = await res.json()
    const result = schema.safeParse(raw)
    if (!result.success) {
      console.error(`[${sourceName}] Schema inválido:`, result.error.format())
      console.error(`[${sourceName}] Payload recebido:`, JSON.stringify(raw).slice(0, 500))
      return { data: fallback, isStale: true }
    }
    return { data: result.data, isStale: false }
  } catch (err) {
    console.error(`[${sourceName}] Fetch falhou:`, err)
    return { data: fallback, isStale: true }
  }
}

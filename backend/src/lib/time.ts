/**
 * Returns minutes since midnight ET (0–1439). DST-aware.
 * Uses Intl.DateTimeFormat with America/New_York — correct on any server timezone (including UTC).
 */
export function getETMinutes(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now)
  const h = parseInt(parts.find(p => p.type === 'hour')!.value, 10)
  const m = parseInt(parts.find(p => p.type === 'minute')!.value, 10)
  return h * 60 + m
}

/**
 * Returns current date in America/New_York as YYYY-MM-DD.
 */
export function getDateET(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/**
 * Returns true if US equity markets are currently open (09:30–16:00 ET, Mon–Fri).
 * DST-aware: detects EDT (UTC-4) vs EST (UTC-5) using January/July offset comparison.
 */
export function isMarketOpen(): boolean {
  const now = new Date()
  const day = now.getUTCDay()
  if (day === 0 || day === 6) return false
  const etMinutes = getETMinutes(now)
  return etMinutes >= 570 && etMinutes < 960 // 09:30–16:00 ET
}

/**
 * Converts an ISO 8601 date string to a human-readable freshness label
 * used inside AI prompts to communicate data age.
 *
 * Rules:
 *   < 60 seconds  → [AO VIVO]
 *   < 5 minutes   → [RECENTE - Xmin atrás]
 *   >= 5 minutes  → [SNAPSHOT - Xh Ymin atrás]
 */
export function humanizeAge(isoDate: string | null | undefined): string {
  if (!isoDate) return '[SNAPSHOT - dados indisponíveis]'

  const parsed = new Date(isoDate).getTime()
  if (isNaN(parsed)) return '[SNAPSHOT - dados indisponíveis]'

  const ageMs = Date.now() - parsed
  if (ageMs < 0) return '[AO VIVO]' // clock skew tolerance

  const ageSec = Math.floor(ageMs / 1000)
  if (ageSec < 60) return '[AO VIVO]'

  const ageMin = Math.floor(ageSec / 60)
  if (ageMin < 5) return `[RECENTE - ${ageMin}min atrás]`

  const h = Math.floor(ageMin / 60)
  const m = ageMin % 60
  return h === 0 ? `[SNAPSHOT - ${m}min atrás]` : `[SNAPSHOT - ${h}h ${m}min atrás]`
}

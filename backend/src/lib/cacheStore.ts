import Redis from 'ioredis'
import { CONFIG } from '../config'

export const redis = new Redis(CONFIG.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
})

redis.on('error', (err) => console.error('[Cache] Redis error:', err.message))

let lastSuccessAt: number | null = null
const UNAVAIL_THRESHOLD = 5 * 60 * 1000 // 5 minutes

function warnIfUnavailable(): void {
  if (lastSuccessAt !== null && Date.now() - lastSuccessAt > UNAVAIL_THRESHOLD) {
    console.error('[Cache] ⚠ Redis indisponível há mais de 5 minutos')
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(`cache:${key}`)
    if (!raw) {
      warnIfUnavailable()
      return null
    }
    lastSuccessAt = Date.now()
    return JSON.parse(raw) as T
  } catch {
    warnIfUnavailable()
    return null
  }
}

export async function cacheSet<T>(
  key: string,
  value: T,
  ttlMs: number,
  _source: string,
): Promise<void> {
  try {
    const ttlSec = Math.ceil(ttlMs / 1000)
    await redis.set(`cache:${key}`, JSON.stringify(value), 'EX', ttlSec)
    lastSuccessAt = Date.now()
  } catch (err) {
    console.error('[Cache] cacheSet error:', err)
  }
}

// Redis handles TTL automatically — no manual cleanup needed
export async function cleanupExpiredCache(): Promise<void> {
  console.log('[Cache] Redis TTL automático — cleanup não necessário')
}

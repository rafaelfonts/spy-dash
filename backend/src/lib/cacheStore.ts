import Redis from 'ioredis'
import { brotliCompress, brotliDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { CONFIG } from '../config'

const brotliCompressAsync = promisify(brotliCompress)
const brotliDecompressAsync = promisify(brotliDecompress)

// Only compress payloads >= 1 KB — small values (VIX, IV Rank, P/C) don't benefit
const COMPRESS_THRESHOLD = 1024
// Sentinel prefix to distinguish Brotli-compressed values from legacy plaintext
const COMPRESSED_PREFIX = 'b:'

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

async function compress(json: string): Promise<string> {
  if (json.length < COMPRESS_THRESHOLD) return json
  const buf = await brotliCompressAsync(Buffer.from(json, 'utf8'))
  return COMPRESSED_PREFIX + buf.toString('base64')
}

async function decompress(stored: string): Promise<string> {
  if (!stored.startsWith(COMPRESSED_PREFIX)) return stored // legacy plaintext
  const buf = await brotliDecompressAsync(
    Buffer.from(stored.slice(COMPRESSED_PREFIX.length), 'base64'),
  )
  return buf.toString('utf8')
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(`cache:${key}`)
    if (!raw) {
      warnIfUnavailable()
      return null
    }
    lastSuccessAt = Date.now()
    return JSON.parse(await decompress(raw)) as T
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
    const json = JSON.stringify(value)
    const stored = await compress(json)
    await redis.set(`cache:${key}`, stored, 'EX', ttlSec)
    lastSuccessAt = Date.now()
  } catch (err) {
    console.error('[Cache] cacheSet error:', err)
  }
}

// Redis handles TTL automatically — no manual cleanup needed
export async function cleanupExpiredCache(): Promise<void> {
  console.log('[Cache] Redis TTL automático — cleanup não necessário')
}

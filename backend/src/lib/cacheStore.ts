import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

let lastSuccessAt: number | null = null
const UNAVAIL_THRESHOLD = 5 * 60 * 1000 // 5 minutes

function warnIfUnavailable(): void {
  if (lastSuccessAt !== null && Date.now() - lastSuccessAt > UNAVAIL_THRESHOLD) {
    console.error('[Cache] ⚠ Supabase indisponível há mais de 5 minutos')
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const { data, error } = await supabase
      .from('market_cache')
      .select('data, expires_at')
      .eq('key', key)
      .single()

    if (error || !data) {
      warnIfUnavailable()
      return null
    }
    if (new Date(data.expires_at) < new Date()) return null // expired
    lastSuccessAt = Date.now()
    return data.data as T
  } catch {
    warnIfUnavailable()
    return null
  }
}

export async function cacheSet<T>(
  key: string,
  value: T,
  ttlMs: number,
  source: string,
): Promise<void> {
  try {
    const now = new Date()
    const { error } = await supabase.from('market_cache').upsert(
      {
        key,
        data: value,
        fetched_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ttlMs).toISOString(),
        source,
      },
      { onConflict: 'key' },
    )

    if (!error) lastSuccessAt = Date.now()
    else console.error('[Cache] cacheSet error:', error.message)
  } catch (err) {
    console.error('[Cache] cacheSet exception:', err)
  }
}

export async function cleanupExpiredCache(): Promise<void> {
  try {
    const { error } = await supabase
      .from('market_cache')
      .delete()
      .lt('expires_at', new Date().toISOString())

    if (error) console.error('[Cache] cleanup error:', error.message)
    else {
      console.log('[Cache] Expired entries cleaned')
      lastSuccessAt = Date.now()
    }
  } catch (err) {
    console.error('[Cache] cleanup exception:', err)
  }
}

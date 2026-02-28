import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import { CONFIG } from '../config'
import { redis } from '../lib/cacheStore'

interface TokenState {
  accessToken: string | null
  expiresAt: number
  refreshToken: string
}

const state: TokenState = {
  accessToken: null,
  expiresAt: 0,
  refreshToken: CONFIG.TT_REFRESH_TOKEN,
}

// Redis key outside the `cache:` namespace so it never expires via cache TTL logic
const REDIS_KEY = 'auth:tt_refresh_token'
const TOKEN_TTL_SEC = 30 * 24 * 60 * 60 // 30 days

// ---------------------------------------------------------------------------
// Encryption helpers — AES-256-GCM via Node.js built-in crypto
// ---------------------------------------------------------------------------

function getEncryptionKey(): Buffer | null {
  const raw = CONFIG.ENCRYPTION_KEY
  if (!raw || raw.length < 32) return null
  return createHash('sha256').update(raw).digest()
}

function encryptToken(token: string): string {
  const key = getEncryptionKey()
  if (!key) return token
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

function decryptToken(stored: string): string {
  const key = getEncryptionKey()
  if (!key) return stored
  const parts = stored.split(':')
  if (parts.length !== 3) return stored // not encrypted format, return as-is
  const [ivHex, authTagHex, encHex] = parts
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const encrypted = Buffer.from(encHex, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8')
}

// ---------------------------------------------------------------------------
// Redis persistence
// ---------------------------------------------------------------------------

async function saveRefreshToken(token: string): Promise<void> {
  try {
    await redis.set(REDIS_KEY, encryptToken(token), 'EX', TOKEN_TTL_SEC)
    console.log('[TokenManager] Refresh token persistido no Redis')
  } catch (err) {
    console.error('[TokenManager] Falha ao persistir refresh token:', (err as Error).message)
  }
}

async function loadRefreshToken(): Promise<string | null> {
  try {
    const stored = await redis.get(REDIS_KEY)
    if (!stored) return null
    return decryptToken(stored)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Core token logic
// ---------------------------------------------------------------------------

async function fetchAccessToken(): Promise<string> {
  const url = `${CONFIG.TT_BASE}/oauth/token`

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: state.refreshToken,
    client_id: CONFIG.TT_CLIENT_ID,
    client_secret: CONFIG.TT_CLIENT_SECRET,
  })

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'SPYDash/1.0',
    },
    body: body.toString(),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`[TokenManager] HTTP ${res.status}: ${text}`)
  }

  const json = (await res.json()) as {
    access_token: string
    expires_in: number
    refresh_token?: string
  }

  state.accessToken = json.access_token
  // Refresh 2 minutes before expiry
  state.expiresAt = Date.now() + (json.expires_in - 120) * 1000

  // If the API returns a new refresh token (token rotation), persist it
  if (json.refresh_token && json.refresh_token !== state.refreshToken) {
    state.refreshToken = json.refresh_token
    await saveRefreshToken(json.refresh_token)
  }

  console.log('[TokenManager] Access token refreshed successfully')
  return state.accessToken
}

export async function ensureAccessToken(): Promise<string> {
  if (state.accessToken && Date.now() < state.expiresAt) {
    return state.accessToken
  }
  return fetchAccessToken()
}

export async function initTokenManager(): Promise<void> {
  const persisted = await loadRefreshToken()
  if (persisted) {
    state.refreshToken = persisted
    console.log('[TokenManager] Refresh token restaurado do Redis')
  } else {
    console.log('[TokenManager] A usar refresh token do .env (sem token persistido)')
    await saveRefreshToken(CONFIG.TT_REFRESH_TOKEN)
  }

  await fetchAccessToken()

  // Auto-refresh: check every 60s, refresh when within 5 minutes of expiry
  setInterval(async () => {
    if (state.expiresAt > 0 && Date.now() > state.expiresAt - 300_000) {
      try {
        await fetchAccessToken()
      } catch (err) {
        console.error('[TokenManager] Auto-refresh failed:', (err as Error).message)
      }
    }
  }, 60_000)
}

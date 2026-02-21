import { CONFIG } from '../config'

interface TokenState {
  accessToken: string | null
  expiresAt: number
}

const state: TokenState = {
  accessToken: null,
  expiresAt: 0,
}

async function fetchAccessToken(): Promise<string> {
  const url = `${CONFIG.TT_BASE}/oauth/token`

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: CONFIG.TT_REFRESH_TOKEN,
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

  const json = (await res.json()) as { access_token: string; expires_in: number }
  state.accessToken = json.access_token
  // Refresh 2 minutes before expiry
  state.expiresAt = Date.now() + (json.expires_in - 120) * 1000

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

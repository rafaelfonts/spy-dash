import { CONFIG } from '../config'
import { ensureAccessToken } from './tokenManager'

export interface StreamerCredentials {
  token: string
  dxlinkUrl: string
}

export async function getStreamerCredentials(): Promise<StreamerCredentials> {
  const accessToken = await ensureAccessToken()

  const res = await fetch(`${CONFIG.TT_BASE}/api-quote-tokens`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'SPYDash/1.0',
    },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to get streamer token: HTTP ${res.status} — ${text}`)
  }

  const json = (await res.json()) as {
    data: {
      token: string
      'dxlink-url'?: string
      'websocket-url'?: string
    }
  }

  const { token, 'dxlink-url': dxlinkUrl, 'websocket-url': wsUrl } = json.data

  if (!token) throw new Error('No streamer token in response')

  return {
    token,
    dxlinkUrl: dxlinkUrl ?? wsUrl ?? 'wss://tasty-openapi-ws.dxfeed.com/realtime',
  }
}

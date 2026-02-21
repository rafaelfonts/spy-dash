import { useState, useCallback } from 'react'

// ---------------------------------------------------------------------------
// Auth hook — credenciais genéricas para fase alpha
// TODO: substituir por Supabase Auth quando disponível:
//   import { createClient } from '@supabase/supabase-js'
//   const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
//   const { data, error } = await supabase.auth.signInWithPassword({ email, password })
// ---------------------------------------------------------------------------

const SESSION_KEY = 'spy_dash_auth'

// Credenciais genéricas — alpha
const VALID_CREDENTIALS = [
  { username: 'admin', password: 'spydash' },
  { username: 'spy', password: 'dash2024' },
]

function isSessionValid(): boolean {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return false
    const { expiresAt } = JSON.parse(raw) as { expiresAt: number }
    return Date.now() < expiresAt
  } catch {
    return false
  }
}

function saveSession(username: string): void {
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      username,
      // Session valid for 8 hours
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
    }),
  )
}

function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY)
}

export interface UseAuth {
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
  login: (username: string, password: string) => Promise<void>
  logout: () => void
}

export function useAuth(): UseAuth {
  const [isAuthenticated, setIsAuthenticated] = useState(() => isSessionValid())
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const login = useCallback(async (username: string, password: string) => {
    setIsLoading(true)
    setError(null)

    // Simula latência de rede (será substituído por Supabase)
    await new Promise((r) => setTimeout(r, 600))

    const valid = VALID_CREDENTIALS.some(
      (c) =>
        c.username === username.trim().toLowerCase() &&
        c.password === password,
    )

    if (valid) {
      saveSession(username.trim())
      setIsAuthenticated(true)
    } else {
      setError('Credenciais inválidas. Verifique usuário e senha.')
    }

    setIsLoading(false)
  }, [])

  const logout = useCallback(() => {
    clearSession()
    setIsAuthenticated(false)
  }, [])

  return { isAuthenticated, isLoading, error, login, logout }
}

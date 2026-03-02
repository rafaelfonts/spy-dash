import type { FastifyRequest, FastifyReply } from 'fastify'
import { createClient } from '@supabase/supabase-js'

// Lazy singleton — initialized on first authenticated request so missing env vars
// don't crash the module at load time (allows backend to start without Supabase locally).
let _supabaseAdmin: ReturnType<typeof createClient> | null = null

function getSupabaseAdmin(): ReturnType<typeof createClient> {
  if (!_supabaseAdmin) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    _supabaseAdmin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  }
  return _supabaseAdmin
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Authorization header para endpoints HTTP normais
  const authHeader = request.headers.authorization
  // Query param para SSE (EventSource não suporta headers customizados)
  const queryToken = (request.query as Record<string, string>)?.token

  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : queryToken

  if (!token) {
    reply.status(401).send({ error: 'Token não fornecido' })
    return
  }

  const {
    data: { user },
    error,
  } = await getSupabaseAdmin().auth.getUser(token)

  if (error || !user) {
    reply.status(401).send({ error: 'Token inválido ou expirado' })
    return
  }

  // Attach user to request so downstream handlers can access req.user.sub
  ;(request as any).user = user
}

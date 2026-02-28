import type { FastifyRequest, FastifyReply } from 'fastify'
import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

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
  } = await supabaseAdmin.auth.getUser(token)

  if (error || !user) {
    reply.status(401).send({ error: 'Token inválido ou expirado' })
    return
  }

  // Attach user to request so downstream handlers can access req.user.sub
  ;(request as any).user = user
}

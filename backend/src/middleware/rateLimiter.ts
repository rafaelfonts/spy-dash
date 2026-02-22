import type { FastifyRequest, FastifyReply } from 'fastify'
import { CONFIG } from '../config'

const analysisLastCall = new Map<string, number>() // userId → timestamp

export function analysisRateLimit(
  req: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  const userId = (req as any).user?.sub as string | undefined
  if (!userId) {
    reply.code(401).send({ error: 'Unauthorized' })
    return
  }

  const last = analysisLastCall.get(userId) ?? 0
  const elapsed = Date.now() - last

  if (elapsed < CONFIG.ANALYZE_COOLDOWN_MS) {
    const retryAfter = Math.ceil((CONFIG.ANALYZE_COOLDOWN_MS - elapsed) / 1000)
    reply
      .code(429)
      .header('Retry-After', String(retryAfter))
      .send({
        error: 'Rate limit',
        retryAfter,
        message: `Aguarde ${retryAfter}s antes de gerar nova análise.`,
      })
    return
  }

  analysisLastCall.set(userId, Date.now())

  // Limpeza periódica do Map para evitar memory leak
  if (analysisLastCall.size > 10_000) {
    const cutoff = Date.now() - 300_000 // 5 min
    for (const [id, ts] of analysisLastCall) {
      if (ts < cutoff) analysisLastCall.delete(id)
    }
  }

  done()
}

import type { FastifyRequest, FastifyReply } from 'fastify'
import { CONFIG } from '../config'

const analysisLastCall = new Map<string, number>()        // userId → last call ts
const analysisCallTimestamps = new Map<string, number[]>() // userId → [ts, ts, ...]

const HOUR_MS = 60 * 60 * 1000
const HOURLY_LIMIT = 5

export function analysisRateLimit(
  req: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  const userId = (req as any).user?.id as string | undefined
  if (!userId) {
    reply.code(401).send({ error: 'Unauthorized' })
    return
  }

  const now = Date.now()

  // 1. Cooldown fixo (anti-spam rápido)
  const last = analysisLastCall.get(userId) ?? 0
  const elapsed = now - last
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

  // 2. Sliding window 1h (quota de custo)
  const windowStart = now - HOUR_MS
  const timestamps = (analysisCallTimestamps.get(userId) ?? []).filter(t => t > windowStart)
  if (timestamps.length >= HOURLY_LIMIT) {
    const oldestInWindow = timestamps[0]
    const retryAfter = Math.ceil((oldestInWindow + HOUR_MS - now) / 1000)
    reply
      .code(429)
      .header('Retry-After', String(retryAfter))
      .send({
        error: 'Quota excedida',
        retryAfter,
        message: `Limite de ${HOURLY_LIMIT} análises por hora atingido. Tente em ${Math.ceil(retryAfter / 60)} min.`,
      })
    return
  }

  // Regista chamada
  analysisLastCall.set(userId, now)
  timestamps.push(now)
  analysisCallTimestamps.set(userId, timestamps)

  // Limpeza periódica para evitar memory leak
  if (analysisLastCall.size > 10_000) {
    const cutoff = now - 300_000
    const hourCutoff = now - HOUR_MS
    for (const [id, ts] of analysisLastCall) {
      if (ts < cutoff) analysisLastCall.delete(id)
    }
    for (const [id, arr] of analysisCallTimestamps) {
      const filtered = arr.filter(t => t > hourCutoff)
      if (filtered.length === 0) analysisCallTimestamps.delete(id)
      else analysisCallTimestamps.set(id, filtered)
    }
  }

  done()
}

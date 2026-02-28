import type { FastifyInstance } from 'fastify'
import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

interface SearchBody {
  query: string
  threshold?: number  // cosine similarity threshold, default 0.7
  limit?: number      // max results, default 5
}

export async function registerAnalysisSearch(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: SearchBody }>('/api/search', async (request, reply) => {
    const { query, threshold = 0.7, limit = 5 } = request.body ?? {}

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return reply.code(400).send({ error: 'Campo "query" é obrigatório' })
    }

    const userId = (request as any).user?.sub ?? null

    try {
      const embRes = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: query.trim(),
      })
      const queryEmbedding = embRes.data[0].embedding

      const { data, error } = await supabase.rpc('search_historical_analyses', {
        query_embedding: queryEmbedding,
        similarity_threshold: Math.max(0, Math.min(1, threshold)),
        match_count: Math.max(1, Math.min(20, limit)),
        p_user_id: userId,
      })

      if (error) {
        console.error('[Search] RPC error:', error.message)
        return reply.code(500).send({ error: 'Erro na pesquisa semântica' })
      }

      return reply.send({ results: data ?? [], count: (data ?? []).length })
    } catch (err) {
      console.error('[Search] Error:', (err as Error).message)
      return reply.code(500).send({ error: 'Erro interno na pesquisa' })
    }
  })
}

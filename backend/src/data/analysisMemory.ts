import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'
import type { AnalysisStructuredOutput } from '../types/market'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

export async function saveAnalysis(
  userId: string,
  fullText: string,
  marketSnapshot: { spyPrice: number; vix: number; ivRank: number },
  structured?: AnalysisStructuredOutput,
): Promise<void> {
  try {
    const summaryRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 150,
      messages: [
        {
          role: 'user',
          content: `Resuma esta análise de mercado em 2-3 frases, incluindo bias (bullish/bearish/neutral), níveis-chave e estratégia sugerida:\n\n${fullText}`,
        },
      ],
    })
    const summary = summaryRes.choices[0].message.content ?? ''

    const embRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: summary,
    })
    const embedding = embRes.data[0].embedding

    await supabase.from('ai_analyses').insert({
      user_id: userId,
      summary,
      full_text: fullText,
      embedding: embedding,
      market_snapshot: marketSnapshot,
      bias: structured?.bias ?? null,
      structured_output: structured ?? null,
    })

    console.log(`[AnalysisMemory] Salva para user=${userId} bias=${structured?.bias ?? 'N/A'}`)
  } catch (err) {
    console.error('[AnalysisMemory] Erro ao salvar:', err)
    // Não lançar — falha de memória não bloqueia o fluxo principal
  }
}

export async function getRecentAnalyses(
  userId: string,
  limit = 3,
): Promise<
  Array<{
    summary: string
    bias: string | null
    market_snapshot: { spyPrice: number }
    created_at: string
  }>
> {
  try {
    const { data, error } = await supabase
      .from('ai_analyses')
      .select('summary, bias, market_snapshot, created_at')
      .eq('user_id', userId)
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error || !data) return []
    return data as Array<{
      summary: string
      bias: string | null
      market_snapshot: { spyPrice: number }
      created_at: string
    }>
  } catch {
    return []
  }
}

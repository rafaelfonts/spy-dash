import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'
import type { AnalysisStructuredOutput } from '../types/market'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

const COMPACT_SUMMARY_MAX_CHARS = 400

/**
 * Generates a compact summary (50-80 words) for prompt injection and semantic search.
 * Replaces the previous longer summary.
 */
export async function generateCompactSummary(
  analysisText: string,
  structuredOutput: AnalysisStructuredOutput | null,
): Promise<string> {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 120,
      messages: [
        {
          role: 'user',
          content: [
            'Crie um resumo compacto desta análise de opções SPY em exatamente 1-2 frases (máx 80 palavras).',
            'Inclua: bias direcional, estratégia recomendada (se houver), DTE, strikes, níveis-chave de invalidação.',
            'Não inclua cumprimentos ou contexto desnecessário. Seja técnico e direto.',
            '',
            '--- ANÁLISE ---',
            analysisText.slice(0, 2000),
            '',
            '--- STRUCTURED ---',
            structuredOutput ? JSON.stringify(structuredOutput) : '{}',
          ].join('\n'),
        },
      ],
    })
    const raw = res.choices[0].message.content?.trim() ?? ''
    return raw.slice(0, COMPACT_SUMMARY_MAX_CHARS)
  } catch (err) {
    console.error('[AnalysisMemory] generateCompactSummary failed:', (err as Error).message)
    return ''
  }
}

export async function saveAnalysis(
  userId: string,
  fullText: string,
  marketSnapshot: { spyPrice: number; vix: number; ivRank: number },
  structured?: AnalysisStructuredOutput,
): Promise<void> {
  try {
    const compactSummary = await generateCompactSummary(fullText, structured ?? null)

    const embRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: compactSummary || fullText.slice(0, 1000),
    })
    const embedding = embRes.data[0].embedding

    await supabase.from('ai_analyses').insert({
      user_id: userId,
      summary: compactSummary,
      full_text: fullText,
      embedding: embedding,
      market_snapshot: marketSnapshot,
      bias: structured?.bias ?? null,
      structured_output: structured ?? null,
      compact_summary: compactSummary || null,
      analysis_date: new Date().toISOString().slice(0, 10),
    })

    console.log(`[AnalysisMemory] Salva para user=${userId} bias=${structured?.bias ?? 'N/A'}`)
  } catch (err) {
    console.error('[AnalysisMemory] Erro ao salvar:', err)
    // Não lançar — falha de memória não bloqueia o fluxo principal
  }
}

const RECENT_WINDOW_HOURS = 24
const SEMANTIC_SEARCH_LIMIT = 2

export interface RecentAnalysisRow {
  id: string
  summary: string
  compact_summary: string | null
  bias: string | null
  market_snapshot: { spyPrice?: number; vix?: number; ivRank?: number }
  structured_output: { confidence?: number } | null
  created_at: string
}

export async function getRecentAnalyses(
  userId: string,
  limit = 2,
  withinHours = RECENT_WINDOW_HOURS,
): Promise<RecentAnalysisRow[]> {
  try {
    const since = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString()
    const { data, error } = await supabase
      .from('ai_analyses')
      .select('id, summary, compact_summary, bias, market_snapshot, structured_output, created_at')
      .eq('user_id', userId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error || !data) return []
    return data as RecentAnalysisRow[]
  } catch {
    return []
  }
}

export interface SimilarAnalysisRow {
  id: string
  summary: string
  bias: string | null
  market_snapshot: Record<string, unknown>
  created_at: string
  similarity: number
}

/**
 * Semantic search for analyses similar to current market context.
 * Uses OpenAI embedding for query and Supabase RPC search_historical_analyses.
 */
export async function searchSimilarAnalyses(
  userId: string,
  queryText: string,
  limit = SEMANTIC_SEARCH_LIMIT,
  excludeIds: string[] = [],
): Promise<SimilarAnalysisRow[]> {
  try {
    const embRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: queryText.slice(0, 8000),
    })
    const queryEmbedding = embRes.data[0].embedding

    const { data, error } = await supabase.rpc('search_historical_analyses', {
      query_embedding: queryEmbedding,
      similarity_threshold: 0.5,
      match_count: limit + excludeIds.length + 5,
      p_user_id: userId,
    })

    if (error || !data) return []
    const exclude = new Set(excludeIds)
    const filtered = (data as SimilarAnalysisRow[]).filter((row) => !exclude.has(row.id))
    return filtered.slice(0, limit)
  } catch (err) {
    console.error('[AnalysisMemory] searchSimilarAnalyses failed:', (err as Error).message)
    return []
  }
}

export interface MarketSnapshotContext {
  ivRank: number
  vix: number
  gexRegime?: string
}

function formatRelativeTime(isoDate: string): string {
  const ms = new Date(isoDate).getTime()
  if (isNaN(ms)) return '?'
  const ageMin = Math.floor((Date.now() - ms) / 60_000)
  if (ageMin < 1) return 'agora'
  if (ageMin < 60) return `${ageMin}min atrás`
  const ageH = Math.floor(ageMin / 60)
  if (ageH < 24) return `${ageH}h atrás`
  return `${Math.floor(ageH / 24)}d atrás`
}

function formatDate(isoDate: string): string {
  const d = new Date(isoDate)
  if (isNaN(d.getTime())) return '?'
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

/**
 * Builds the memory block for the AI prompt: recent analyses (compact) + optional semantic matches.
 * Keeps token cost ~500 max vs ~3600 with raw injection.
 */
export async function buildMemoryBlock(
  userId: string,
  currentMarketContext: MarketSnapshotContext,
): Promise<string> {
  const recent = await getRecentAnalyses(userId, 2, RECENT_WINDOW_HOURS)

  let semanticMatches: SimilarAnalysisRow[] = []
  const shouldSearchSemantic =
    currentMarketContext.ivRank > 60 ||
    currentMarketContext.vix > 20 ||
    (currentMarketContext.gexRegime != null && recent.length > 0 && recent.some(
      (r) => (r.market_snapshot as { gexRegime?: string })?.gexRegime !== currentMarketContext.gexRegime,
    ))

  if (shouldSearchSemantic && recent.length > 0) {
    const queryText = `${currentMarketContext.gexRegime ?? ''} regime ivrank ${currentMarketContext.ivRank} vix ${currentMarketContext.vix}`
    semanticMatches = await searchSimilarAnalyses(
      userId,
      queryText,
      SEMANTIC_SEARCH_LIMIT,
      recent.map((r) => r.id),
    )
  }

  let block = `### 🧠 MEMÓRIA DE ANÁLISES ANTERIORES\n\n`

  if (recent.length === 0) {
    return block + `_Nenhuma análise anterior disponível._\n`
  }

  block += `**Recentes:**\n`
  for (const r of recent) {
    const age = formatRelativeTime(r.created_at)
    const spyPrice = r.market_snapshot?.spyPrice ?? 0
    const vixVal = r.market_snapshot?.vix ?? 0
    const summary = r.compact_summary ?? r.summary
    block += `- [${age}] Bias: ${r.bias ?? 'N/A'} | SPY: $${spyPrice.toFixed(2)} | VIX: ${vixVal.toFixed(1)}\n`
    block += `  ${summary}\n\n`
  }

  if (semanticMatches.length > 0) {
    block += `**Análises similares ao contexto atual:**\n`
    for (const r of semanticMatches) {
      block += `- [${formatDate(r.created_at)}] ${r.summary}\n`
    }
  }

  return block
}

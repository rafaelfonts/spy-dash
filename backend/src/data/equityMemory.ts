import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'
import { CONFIG } from '../config'

const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY })
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

const COMPACT_SUMMARY_MAX_CHARS = 400

/**
 * Generates a compact summary (50-80 words) for swing trade context.
 */
async function generateEquitySummary(
  symbol: string,
  fullText: string,
  structured: Record<string, unknown> | null,
): Promise<string> {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 120,
      messages: [
        {
          role: 'user',
          content: [
            `Crie um resumo compacto desta análise de swing trade para ${symbol} em exatamente 1-2 frases (máx 80 palavras).`,
            'Inclua: bias direcional, setup técnico, suportes/resistências chave, níveis de invalidação.',
            'Não inclua cumprimentos ou contexto desnecessário. Seja técnico e direto.',
            '',
            '--- ANÁLISE ---',
            fullText.slice(0, 2000),
            '',
            '--- STRUCTURED ---',
            structured ? JSON.stringify(structured) : '{}',
          ].join('\n'),
        },
      ],
    })
    const raw = res.choices[0].message.content?.trim() ?? ''
    return raw.slice(0, COMPACT_SUMMARY_MAX_CHARS)
  } catch (err) {
    console.error('[equityMemory] generateEquitySummary failed:', (err as Error).message)
    return ''
  }
}

/**
 * Saves an equity analysis to Supabase with embedding for semantic search.
 * Fire-and-forget: catches and logs errors, never throws.
 */
export async function saveEquityAnalysis(
  userId: string,
  symbol: string,
  fullText: string,
  structured: Record<string, unknown> | null,
  marketSnapshot: Record<string, unknown>,
): Promise<void> {
  try {
    const summary = await generateEquitySummary(symbol, fullText, structured)

    const embRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: summary || fullText.slice(0, 1000),
    })
    const embedding = embRes.data[0].embedding

    await supabase.from('equity_analyses').insert({
      user_id: userId,
      symbol,
      summary,
      full_text: fullText,
      embedding,
      market_snapshot: marketSnapshot,
      structured_output: structured ?? null,
      analysis_date: new Date().toISOString().slice(0, 10),
    })

    console.log(`[equityMemory] saved analysis for ${symbol}`)
  } catch (err) {
    console.error('[equityMemory] error saving analysis:', err)
    // Do NOT throw — fire-and-forget pattern
  }
}

interface EquityAnalysisRow {
  id: string
  summary: string | null
  created_at: string
}

interface EquitySimilarRow {
  id: string
  summary: string | null
  similarity: number
  created_at: string
}

function formatDate(isoDate: string): string {
  const d = new Date(isoDate)
  if (isNaN(d.getTime())) return '?'
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

/**
 * Builds a markdown memory block for injection into the equity AI prompt.
 * Fetches 2 most recent analyses for symbol+user in the last 24h.
 * If RSI is extreme (< 30 or > 70), also runs semantic search.
 */
export async function buildEquityMemoryBlock(
  userId: string,
  symbol: string,
  rsi?: number | null,
): Promise<string> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    const { data: recent, error } = await supabase
      .from('equity_analyses')
      .select('id, summary, created_at')
      .eq('user_id', userId)
      .eq('symbol', symbol)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(2)

    if (error) {
      console.error('[equityMemory] error fetching recent analyses:', error.message)
    }

    const recentRows: EquityAnalysisRow[] = (recent as EquityAnalysisRow[] | null) ?? []

    let semanticRows: EquitySimilarRow[] = []
    const shouldSearchSemantic = rsi != null && (rsi < 30 || rsi > 70)

    if (shouldSearchSemantic) {
      try {
        const queryText = `${symbol} technical setup swing trade`
        const embRes = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: queryText,
        })
        const queryEmbedding = embRes.data[0].embedding

        const { data: semData, error: semError } = await supabase.rpc('search_equity_analyses', {
          query_embedding: queryEmbedding,
          p_user_id: userId,
          p_symbol: symbol,
          similarity_threshold: 0.5,
          match_count: 3,
        })

        if (semError) {
          console.error('[equityMemory] semantic search error:', semError.message)
        } else if (semData) {
          const existingIds = new Set(recentRows.map((r) => r.id))
          semanticRows = (semData as EquitySimilarRow[]).filter((r) => !existingIds.has(r.id))
        }
      } catch (err) {
        console.error('[equityMemory] semantic search failed:', (err as Error).message)
      }
    }

    const totalCount = recentRows.length + semanticRows.length
    console.log(`[equityMemory] loaded ${totalCount} previous analyses for ${symbol}`)

    if (recentRows.length === 0 && semanticRows.length === 0) {
      return ''
    }

    const allRows: EquityAnalysisRow[] = [
      ...recentRows,
      ...semanticRows.map((r) => ({ id: r.id, summary: r.summary, created_at: r.created_at })),
    ]

    let block = `### MEMÓRIA — ${symbol}\n`
    allRows.forEach((row, i) => {
      const date = formatDate(row.created_at)
      const summary = row.summary ?? ''
      block += `**Análise ${i + 1}** (${date}): ${summary}\n`
    })

    return block
  } catch (err) {
    console.error('[equityMemory] buildEquityMemoryBlock failed:', (err as Error).message)
    return ''
  }
}

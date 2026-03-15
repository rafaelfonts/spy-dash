// backend/src/lib/equityNewsDigest.ts
import OpenAI from 'openai'
import { CONFIG } from '../config.js'
import type { TavilyResult } from './tavilyClient.js'

const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY })

/**
 * Adapts buildNewsDigest for equity swing trade context.
 * Unlike the SPY version (which focuses on SPY options), this focuses on 1-5 day
 * impact on the individual ticker. Uses OpenAI SDK (same pattern as analysisMemory.ts).
 */
export async function buildEquityNewsDigest(
  results: TavilyResult[],
  symbol: string,
  reason: string,
): Promise<string | null> {
  if (results.length === 0) return null

  const snippets = results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.content}`)
    .join('\n\n')

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content:
            `Você é um analista de swing trade. Resuma os snippets abaixo em no máximo 80 palavras, ` +
            `focando no impacto direto para uma operação de 1–5 dias em ${symbol}. Seja objetivo e direto.`,
        },
        {
          role: 'user',
          content: `Motivo da busca: ${reason}\n\nSnippets:\n${snippets}`,
        },
      ],
    })
    return res.choices[0]?.message?.content ?? null
  } catch (err) {
    console.warn('[equityNewsDigest] gpt-4o-mini falhou, usando fallback:', (err as Error).message)
    return `[FONTE EXTERNA — conteúdo não verificado]: ${results[0].content.slice(0, 150)}`
  }
}

import { CONFIG } from '../config'
import type { TavilyResult } from './tavilyClient'

export async function buildNewsDigest(
  results: TavilyResult[],
  reason: string,
): Promise<string | null> {
  if (results.length === 0) return null

  const snippets = results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.content}`)
    .join('\n\n')

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 200,
        messages: [
          {
            role: 'system',
            content:
              'Você é um analista quantitativo. Resuma os snippets abaixo em no máximo 80 palavras, ' +
              'focando no impacto direto para SPY options trading. Seja objetivo e direto.',
          },
          {
            role: 'user',
            content: `Motivo da busca: ${reason}\n\nSnippets:\n${snippets}`,
          },
        ],
      }),
    })

    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`)
    const data = await res.json() as { choices: Array<{ message: { content: string } }> }
    return data.choices[0]?.message?.content ?? null
  } catch (err) {
    console.warn('[newsDigest] gpt-4o-mini falhou, usando fallback de snippet raw:', (err as Error).message)
    // Prefixo de sanitização para evitar prompt injection de fonte externa
    return `[FONTE EXTERNA — conteúdo não verificado]: ${results[0].content.slice(0, 150)}`
  }
}

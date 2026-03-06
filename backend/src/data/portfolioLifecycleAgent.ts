/**
 * Portfolio Lifecycle Agent — Claude Gestor de Risco Quantitativo.
 * Builds payload from enriched positions and calls Anthropic for FECHAR/ROLAR/MANTER recommendations.
 */

import Anthropic from '@anthropic-ai/sdk'
import { CONFIG } from '../config'
import type { EnrichedPosition, GestorRiscoAlert, GestorRiscoResponse, PortfolioPayload } from '../types/portfolio'

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT_GESTOR_RISCO = `Você é o Gestor de Risco Quantitativo do SPY Dash. Sua única função é analisar a carteira de opções abertas e decidir se uma posição deve ser fechada, rolada ou mantida.

Regras inegociáveis:
1. Se 'profit_percentage' >= 50%, a recomendação OBRIGATÓRIA é 'FECHAR_LUCRO'.
2. Se 'dte_current' <= 21, a recomendação OBRIGATÓRIA é 'FECHAR_TEMPO' ou 'ROLAR', independentemente do lucro ou prejuízo, para evitar exposição ao Gamma na reta final do vencimento.
3. Caso contrário, a recomendação é 'MANTER'.

Você deve retornar EXCLUSIVAMENTE um JSON rigoroso contendo um array 'alerts'. Para cada posição que exigir ação, crie uma mensagem direta e profissional para o Discord instruindo o fechamento. Exemplo de tom desejado: "🚨 ALERTA DE SAÍDA: O Put Spread SPY 490/480 atingiu 52% de lucro máximo. Abra sua plataforma Tastytrade e envie uma ordem de recompra (Debit) a mercado para travar o lucro, anulando o risco de cauda." A justificativa técnica (Theta decay ou captura de prêmio) deve ser clara e orientada à ação.

Formato de saída obrigatório (sem markdown, sem explicação fora do JSON):
{
  "alerts": [
    {
      "position_id": "uuid-da-posição",
      "recommendation": "FECHAR_LUCRO" | "FECHAR_TEMPO" | "ROLAR" | "MANTER",
      "message": "Texto da mensagem para o Discord, direto e acionável."
    }
  ]
}

Inclua apenas posições que exigem ação (FECHAR_LUCRO, FECHAR_TEMPO ou ROLAR). Posições MANTER podem ser omitidas do array.`

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

export function buildPortfolioPayload(positions: EnrichedPosition[]): PortfolioPayload {
  return { positions }
}

// ---------------------------------------------------------------------------
// Claude call (non-streaming, no tools)
// ---------------------------------------------------------------------------

const CLAUDE_MODEL = 'claude-3-5-sonnet-latest'
const CLAUDE_MAX_TOKENS = 2048

export async function callGestorRisco(payload: PortfolioPayload): Promise<GestorRiscoResponse> {
  if (!CONFIG.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set')
  }

  const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY })
  const userContent = JSON.stringify(payload)

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    system: SYSTEM_PROMPT_GESTOR_RISCO,
    messages: [{ role: 'user', content: userContent }],
  })

  const content = response.content
  if (!Array.isArray(content) || content.length === 0) {
    return { alerts: [] }
  }

  const textBlock = content.find((block: { type: string }) => block.type === 'text')
  const raw = textBlock && typeof (textBlock as { text?: string }).text === 'string'
    ? (textBlock as { text: string }).text.trim()
    : ''

  if (!raw) return { alerts: [] }

  // Strip optional markdown code fence
  let jsonStr = raw
  const codeMatch = raw.match(/^```(?:json)?\s*([\s\S]*?)```$/m)
  if (codeMatch) jsonStr = codeMatch[1].trim()

  const validRecs: GestorRiscoAlert['recommendation'][] = ['FECHAR_LUCRO', 'FECHAR_TEMPO', 'ROLAR', 'MANTER']
  try {
    const parsed = JSON.parse(jsonStr) as { alerts?: unknown[] }
    const alerts = Array.isArray(parsed?.alerts) ? parsed.alerts : []
    return {
      alerts: alerts.map((a: unknown) => {
        const item = a as Record<string, unknown>
        const rec = typeof item.recommendation === 'string' && validRecs.includes(item.recommendation as GestorRiscoAlert['recommendation'])
          ? (item.recommendation as GestorRiscoAlert['recommendation'])
          : 'MANTER'
        return {
          position_id: typeof item.position_id === 'string' ? item.position_id : undefined,
          recommendation: rec,
          message: typeof item.message === 'string' ? item.message : String(item.message ?? ''),
        }
      }),
    }
  } catch (err) {
    console.error('[GestorRisco] Parse JSON failed:', (err as Error).message)
    return { alerts: [] }
  }
}

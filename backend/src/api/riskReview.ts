/**
 * Risk Review API — CRO (Chief Risk Officer) evaluation of Bull Put Spread proposals.
 * POST /api/analyze/risk-review: receives proposed trade, enriches with payoff + macro
 * events in DTE window, sends to Claude 3.5 Sonnet and returns decision + justification.
 */

import type { FastifyInstance } from 'fastify'
import Anthropic from '@anthropic-ai/sdk'
import { CONFIG } from '../config'
import { marketState } from '../data/marketState'
import { getAdvancedMetricsSnapshot } from '../data/advancedMetricsState'
import { getMacroEventsForWindow } from '../data/macroCalendar'
import { calculatePutSpreadPayoff } from '../lib/putSpreadPayoff'
import { analysisRateLimit } from '../middleware/rateLimiter'

// ---------------------------------------------------------------------------
// Helpers: today and expiration in ET
// ---------------------------------------------------------------------------

function getTodayDateET(): string {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const y = et.getFullYear()
  const m = String(et.getMonth() + 1).padStart(2, '0')
  const d = String(et.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Derives expiration_date (YYYY-MM-DD) from today ET + DTE calendar days. */
function expirationDateFromDTE(dte: number): string {
  const todayStr = getTodayDateET()
  const [y, m, d] = todayStr.split('-').map(Number)
  const date = new Date(y!, m! - 1, d!)
  date.setDate(date.getDate() + dte)
  const ye = date.getFullYear()
  const mo = String(date.getMonth() + 1).padStart(2, '0')
  const da = String(date.getDate()).padStart(2, '0')
  return `${ye}-${mo}-${da}`
}

// ---------------------------------------------------------------------------
// CRO System Prompt (Etapa 4)
// ---------------------------------------------------------------------------

const CRO_SYSTEM_PROMPT = `Você é o Diretor de Risco (CRO) do SPY Dash. Sua função é criticar propostas de Put Spreads baseando-se no Payoff Profile e no Risco de Eventos Binários.

Regras Analíticas:
1. Avalie o 'risk_reward_ratio'. Se a margem travada (max_loss) for excessivamente alta para o crédito recebido (geralmente, buscamos receber ao menos 1/3 da largura do spread em crédito), aponte a ineficiência.
2. Cruze a data de vencimento (DTE) com os 'binary_risk_events'. Se houver uma reunião do FOMC ou dados do CPI poucos dias antes do vencimento, exija um prêmio (credit) maior para compensar a exposição a esse risco de cauda iminente.
3. Se o 'breakeven' estiver acima do 'major_negative_gex_level' (a parede de liquidez de suporte), aprove a estrutura mecânica. Se estiver desprotegido, sugira a rolagem dos strikes para baixo.

O output deve ser um JSON contendo a decisão ('APPROVED', 'REJECTED', 'NEEDS_RESTRUCTURE') e um parágrafo denso e técnico com a justificativa de Risco/Retorno. Responda APENAS com esse JSON, sem texto adicional. Exemplo:
{"decision":"NEEDS_RESTRUCTURE","justification":"O breakeven em 487.50 está abaixo da put wall GEX em 500, expondo a operação a aceleração de gamma em queda. Recomenda-se rolar os strikes para 485/475 ou exigir crédito adicional de pelo menos $0.30 por contrato."}`

// ---------------------------------------------------------------------------
// Request body and payload types
// ---------------------------------------------------------------------------

interface RiskReviewBody {
  short_strike: number
  long_strike: number
  credit_received_per_contract: number
  dte: number
  expiration_date?: string
}

function parseRiskReviewOutput(text: string): { decision: string; justification: string } {
  const trimmed = text.trim()
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { decision?: string; justification?: string }
      return {
        decision: parsed.decision ?? 'NEEDS_RESTRUCTURE',
        justification: typeof parsed.justification === 'string' ? parsed.justification : trimmed,
      }
    } catch {
      // fallback
    }
  }
  return {
    decision: 'NEEDS_RESTRUCTURE',
    justification: trimmed || 'Análise de risco não pôde ser extraída.',
  }
}

export async function registerRiskReview(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: RiskReviewBody }>(
    '/api/analyze/risk-review',
    { preHandler: [analysisRateLimit] },
    async (request, reply) => {
      const body = request.body
      if (
        body == null ||
        typeof body.short_strike !== 'number' ||
        typeof body.long_strike !== 'number' ||
        typeof body.credit_received_per_contract !== 'number' ||
        typeof body.dte !== 'number'
      ) {
        return reply.code(400).send({
          error: 'Body must include short_strike, long_strike, credit_received_per_contract, dte',
        })
      }

      const { short_strike, long_strike, credit_received_per_contract, dte } = body
      if (dte < 21 || dte > 45) {
        return reply.code(400).send({ error: 'dte must be between 21 and 45' })
      }

      let payoff: ReturnType<typeof calculatePutSpreadPayoff>
      try {
        payoff = calculatePutSpreadPayoff(short_strike, long_strike, credit_received_per_contract)
      } catch (err) {
        return reply.code(400).send({
          error: (err as Error).message,
        })
      }

      const todayET = getTodayDateET()
      const expiration_date = body.expiration_date ?? expirationDateFromDTE(dte)

      const binary_risk_events = await getMacroEventsForWindow(todayET, expiration_date)

      const metrics = getAdvancedMetricsSnapshot()
      let major_negative_gex_level: number | null = null
      if (metrics?.gexByExpiration) {
        const bucket = dte <= 30 ? metrics.gexByExpiration.dte21 : metrics.gexByExpiration.dte45
        major_negative_gex_level = bucket?.minGexStrike ?? metrics.gex?.minGexStrike ?? null
      } else if (metrics?.gex) {
        major_negative_gex_level = metrics.gex.minGexStrike
      }

      const payload = {
        proposed_trade: {
          strategy: 'Bull Put Spread',
          symbol: 'SPY',
          dte,
          short_strike,
          long_strike,
          credit_received_per_contract,
          payoff_profile: {
            max_profit_usd: payoff.max_profit,
            max_loss_usd: payoff.max_loss,
            breakeven: payoff.breakeven,
            risk_reward_ratio: payoff.risk_reward_ratio,
          },
        },
        market_context: {
          current_spy_price: marketState.spy.last ?? null,
          major_negative_gex_level,
          iv_rank: marketState.ivRank.value ?? null,
        },
        binary_risk_events,
      }

      if (!CONFIG.ANTHROPIC_API_KEY) {
        return reply.code(503).send({
          error: 'Risk review requires ANTHROPIC_API_KEY',
        })
      }

      try {
        const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY })
        const userContent = `Avalie a seguinte proposta de Put Spread e os eventos macro na janela do trade. Responda apenas com o JSON de decisão e justificativa.\n\n${JSON.stringify(payload, null, 2)}`

        const msg = await anthropic.messages.create({
          model: CONFIG.ANTHROPIC_MODEL,
          max_tokens: 1024,
          system: CRO_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userContent }],
        })

        const textBlock = msg.content.find((b): b is { type: 'text'; text: string } => b.type === 'text')
        const rawText = textBlock?.text?.trim() ?? ''
        const { decision, justification } = parseRiskReviewOutput(rawText)

        return reply.send({
          decision,
          justification,
        })
      } catch (err) {
        console.error('[RiskReview] Anthropic error:', err)
        return reply.code(502).send({
          error: 'Risk review service temporarily unavailable',
          details: (err as Error).message,
        })
      }
    },
  )
}

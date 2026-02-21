import type { FastifyInstance } from 'fastify'
import type { ServerResponse } from 'http'
import { CONFIG } from '../config'
import { marketState } from '../data/marketState'
import type { OptionExpiry } from '../data/optionChain'

interface AnalyzeBody {
  marketSnapshot?: {
    spy?: { last: number; change: number; changePct: number }
    vix?: { last: number; level: string }
    ivRank?: { value: number; percentile: number; label: string }
  }
  optionChain?: OptionExpiry[]
}

function buildPrompt(snapshot: AnalyzeBody['marketSnapshot'], chain?: OptionExpiry[]): string {
  const spy = snapshot?.spy
  const vix = snapshot?.vix
  const ivRank = snapshot?.ivRank

  let prompt = `Análise de mercado atual:\n\n`

  if (spy) {
    prompt += `**SPY**: $${spy.last?.toFixed(2)} | Variação: ${spy.change >= 0 ? '+' : ''}${spy.change?.toFixed(2)} (${spy.changePct?.toFixed(2)}%)\n`
  }

  if (vix) {
    prompt += `**VIX**: ${vix.last?.toFixed(2)} | Nível: ${vix.level}\n`
  }

  if (ivRank) {
    prompt += `**IV Rank SPY**: ${ivRank.value?.toFixed(1)}% | Percentil: ${ivRank.percentile?.toFixed(1)}% | Classificação: ${ivRank.label}\n`
  }

  if (chain && chain.length > 0) {
    prompt += `\n**Cadeia de opções SPY (DTE relevantes):**\n`
    for (const exp of chain.slice(0, 3)) {
      prompt += `- Expiração ${exp.expirationDate} (${exp.dte} DTE): ${exp.calls.length} calls, ${exp.puts.length} puts disponíveis\n`
    }
  }

  prompt += `\nCom base nessas condições de mercado, forneça:\n`
  prompt += `1. Análise do ambiente de volatilidade atual\n`
  prompt += `2. Estratégias de opções mais adequadas para este momento\n`
  prompt += `3. Considerações de risco específicas para SPY hoje\n`
  prompt += `4. Níveis técnicos importantes para monitorar\n`

  return prompt
}

export async function registerOpenAI(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: AnalyzeBody }>('/api/analyze', async (request, reply) => {
    const body = request.body ?? {}
    const snapshot = body.marketSnapshot ?? {
      spy: marketState.spy.last
        ? {
            last: marketState.spy.last,
            change: marketState.spy.change ?? 0,
            changePct: marketState.spy.changePct ?? 0,
          }
        : undefined,
      vix: marketState.vix.last
        ? { last: marketState.vix.last, level: marketState.vix.level ?? 'unknown' }
        : undefined,
      ivRank: marketState.ivRank.value
        ? {
            value: marketState.ivRank.value,
            percentile: marketState.ivRank.percentile ?? 0,
            label: marketState.ivRank.label ?? 'unknown',
          }
        : undefined,
    }

    const res = reply.raw as ServerResponse
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    try {
      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          stream: true,
          max_tokens: 1000,
          messages: [
            {
              role: 'system',
              content:
                'Você é um especialista sênior em opções americanas, com foco em SPY e ETFs de grande liquidez. ' +
                'Suas análises são concisas, objetivas e acionáveis. ' +
                'Use markdown para formatar suas respostas com headers, listas e destaques.',
            },
            {
              role: 'user',
              content: buildPrompt(snapshot, body.optionChain),
            },
          ],
        }),
      })

      if (!openaiRes.ok) {
        const text = await openaiRes.text()
        sendEvent('error', { message: `OpenAI error: ${openaiRes.status} — ${text}` })
        res.end()
        return
      }

      const reader = openaiRes.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data === '[DONE]') {
              sendEvent('done', {})
              res.end()
              reply.hijack()
              return
            }
            try {
              const parsed = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string } }>
              }
              const content = parsed.choices?.[0]?.delta?.content
              if (content) {
                sendEvent('token', { text: content })
              }
            } catch {
              // skip malformed lines
            }
          }
        }
      }

      sendEvent('done', {})
      res.end()
    } catch (err) {
      sendEvent('error', { message: (err as Error).message })
      res.end()
    }

    reply.hijack()
  })
}

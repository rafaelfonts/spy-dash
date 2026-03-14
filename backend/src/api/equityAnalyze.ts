// backend/src/api/equityAnalyze.ts
import type { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { getTradierClient } from '../lib/tradierClient.js';
import { CONFIG } from '../config.js';

const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY });

const EQUITY_ANALYSIS_SCHEMA = {
  name: 'equity_analysis_output',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      symbol:       { type: 'string' },
      setup:        { type: 'string' },
      entry_range:  { type: 'string' },
      target:       { type: 'string' },
      stop:         { type: 'string' },
      risk_reward:  { type: 'string' },
      confidence:   { type: 'string', enum: ['ALTA', 'MÉDIA', 'BAIXA'] },
      warning:      { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['symbol', 'setup', 'entry_range', 'target', 'stop', 'risk_reward', 'confidence', 'warning'],
    additionalProperties: false,
  },
};

async function buildEquityPrompt(symbol: string): Promise<string> {
  const tradier = getTradierClient();

  // Cotação atual
  const quotes = await tradier.getQuotes([symbol]).catch(() => []);
  const q = quotes[0];
  const quoteBlock = q
    ? `Preço: $${q.last ?? q.close ?? 'N/A'} | Var: ${q.change_percentage?.toFixed(2) ?? 'N/A'}% | Vol: ${q.volume?.toLocaleString() ?? 'N/A'} | AvgVol: ${q.average_volume?.toLocaleString() ?? 'N/A'}`
    : 'Cotação indisponível';

  // Histórico intraday 1min
  const timesales = await tradier.getTimeSales(symbol).catch(() => []);
  const last10 = timesales.slice(-10).map((t) => `${t.time}: $${t.close}`).join(' | ');
  const priceBlock = last10 || 'Histórico indisponível';

  // Notícias Finnhub
  let newsBlock = 'Notícias indisponíveis';
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${today}&to=${today}&token=${CONFIG.FINNHUB_API_KEY}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const news: Array<{ headline: string }> = await res.json();
      newsBlock = news.slice(0, 3).map((n) => `- ${n.headline}`).join('\n') || 'Sem notícias hoje';
    }
  } catch { /* ignora */ }

  return `Você é um analista quantitativo de swing trade. Analise ${symbol} para uma operação de 1 dia (compra hoje, venda amanhã) com capital de $50.

DADOS DO MERCADO (${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/New_York' })} ET):
${quoteBlock}

HISTÓRICO DE PREÇO (últimos 10 min):
${priceBlock}

NOTÍCIAS HOJE:
${newsBlock}

Forneça análise concisa. setup deve ter no máximo 2 frases em pt-BR. entry_range, target e stop em formato "$X.XX". risk_reward como "1.5:1". warning pode ser null se não houver alerta específico.`;
}

export async function registerEquityAnalyzeRoute(app: FastifyInstance): Promise<void> {
  app.post('/api/equity/analyze', {
    preHandler: [(app as any).requireAuth],
  }, async (request, reply) => {
    const { symbol } = request.body as { symbol?: string };
    if (!symbol || typeof symbol !== 'string' || !/^[A-Z]{1,5}$/.test(symbol.trim().toUpperCase())) {
      return reply.status(400).send({ error: 'symbol inválido' });
    }

    const prompt = await buildEquityPrompt(symbol.toUpperCase());

    let response;
    try {
      response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        response_format: {
          type: 'json_schema',
          json_schema: EQUITY_ANALYSIS_SCHEMA,
        },
        max_tokens: 400,
      });
    } catch (e) {
      console.error('[equityAnalyze] OpenAI error:', e);
      return reply.status(500).send({ error: 'Falha na análise IA' });
    }

    const content = response.choices[0]?.message?.content;
    if (!content) return reply.status(500).send({ error: 'IA sem resposta' });

    try {
      return reply.send(JSON.parse(content));
    } catch {
      return reply.status(500).send({ error: 'Resposta da IA inválida' });
    }
  });
}

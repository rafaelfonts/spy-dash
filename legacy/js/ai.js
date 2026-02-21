// ─── ANÁLISE DE ESTRATÉGIA COM GPT-4o ────────────────────────
async function analyzeWithAI() {
  const btn   = document.getElementById('btn-analyze');
  const errEl = document.getElementById('ai-error');
  const resEl = document.getElementById('ai-result');
  const ph    = document.getElementById('ai-placeholder');

  btn.classList.add('loading');
  btn.disabled = true;
  btn.querySelector('.btn-text').textContent = 'Analisando...';
  errEl.style.display = 'none';
  resEl.style.display = 'none';
  ph.style.display    = 'flex';
  ph.textContent      = '🤖 GPT-4o processando dados de mercado...';

  // Resumo da cadeia de opções por DTE-alvo
  let chainSummary = 'Cadeia de opções: não disponível';
  if (marketData.optionChain) {
    try {
      const items = marketData.optionChain?.items ?? marketData.optionChain ?? [];
      if (Array.isArray(items) && items.length) {
        const tgt = [0, 1, 7, 21, 45];
        const s   = {};
        items.forEach(exp => {
          const dte = exp?.dte ?? exp?.['days-to-expiration'];
          if (dte == null) return;
          const c = tgt.reduce((a, b) => Math.abs(b - dte) < Math.abs(a - dte) ? b : a);
          if (!s[c]) s[c] = {
            dte,
            vol: exp?.volume ?? 0,
            oi:  exp?.['open-interest'] ?? 0,
            iv:  exp?.iv ?? exp?.['implied-volatility'] ?? null,
          };
        });
        if (Object.keys(s).length) chainSummary = `Chain SPY (DTE→vol/OI/IV): ${JSON.stringify(s)}`;
      }
    } catch {}
  }

  const userMsg = `Dados de mercado:
- SPY: ${fPrice(marketData.spyPrice)} | Variação: ${fPct(marketData.spyChange)}
- IV Rank: ${marketData.ivRank != null ? f(marketData.ivRank, 0) + '%' : 'N/D'} | IV Percentile: ${marketData.ivPercentile != null ? f(marketData.ivPercentile, 0) + '%' : 'N/D'}
- VIX: ${marketData.vix != null ? f(marketData.vix) : 'N/D'} | Variação: ${fPct(marketData.vixChange)}
- Mercado: ${isMarketOpen() ? 'ABERTO' : 'FECHADO'}
- ${chainSummary}

Recomende a melhor estratégia entre 0DTE, 1DTE, 7DTE, 21DTE ou 45DTE.

Resposta DEVE incluir:
1. **Estratégia Recomendada** (nome + DTE)
2. **Strikes sugeridos**
3. **Crédito/Débito e Risco máximo**
4. **Probabilidade de lucro** (cálculo via delta)
5. **Justificativa** (IV Rank, VIX, momentum)
6. **Alertas de risco**`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model:      'gpt-4o',
        max_tokens: 1400,
        messages: [
          {
            role:    'system',
            content: 'Você é especialista sênior em opções SPY. Analise os dados e recomende a MELHOR estratégia com justificativa quantitativa. Formate em Markdown estruturado.',
          },
          { role: 'user', content: userMsg },
        ],
      }),
    });

    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e?.error?.message || `OpenAI ${res.status}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? 'Sem resposta.';
    ph.style.display    = 'none';
    resEl.style.display = 'block';
    document.getElementById('md-content').innerHTML = marked.parse(text);
  } catch (err) {
    ph.style.display    = 'none';
    errEl.textContent   = `⚠ Erro OpenAI: ${err.message}`;
    errEl.style.display = 'block';
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
    btn.querySelector('.btn-text').textContent = '✦ Analisar com IA';
  }
}

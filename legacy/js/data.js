// ─── CARREGAMENTO DE DADOS DE MERCADO ────────────────────────
async function loadData() {
  updateMarketStatus();
  startSpinner();

  try {
    const [qR, vR, cR, vxR] = await Promise.allSettled([
      ttGet('/market-data/by-type?equity[]=SPY'),
      ttGet('/market-metrics?symbols=SPY'),
      ttGet('/option-chains/SPY'),
      ttGet('/market-data/by-type?index[]=%24VIX.X'),
    ]);

    // SPY Quote — /market-data/by-type retorna camelCase (prevClose, last, mark…)
    if (qR.status === 'fulfilled') {
      const items  = qR.value?.data?.items;
      const q      = (Array.isArray(items) && items.length) ? items[0] : (qR.value?.data ?? qR.value);
      const price  = q?.last ?? q?.mark ?? q?.close ?? null;
      const pClose = q?.prevClose ?? q?.['prev-close'] ?? null;
      const chg    = pClose && price != null ? ((price - pClose) / pClose * 100) : null;
      if (price != null) { marketData.spyPrice = price; marketData.spyChange = chg; renderSPY(price, chg); }
      else { console.warn('[SPY] price nulo — resposta:', JSON.stringify(qR.value)); renderSPYEmpty(); }
    } else { console.error('[SPY] requisição falhou:', qR.reason?.message); renderSPYEmpty(); }

    // IV Rank/Percentile — /market-metrics retorna implied-volatility-rank (0–1)
    if (vR.status === 'fulfilled') {
      const items = vR.value?.data?.items;
      const v     = (Array.isArray(items) && items.length) ? items[0] : (vR.value?.data ?? vR.value);
      const ivr   = v?.['implied-volatility-rank'] ?? v?.['iv-rank'] ?? v?.ivRank ?? null;
      const ivp   = v?.['implied-volatility-percentile'] ?? v?.['iv-percentile'] ?? v?.ivPercentile ?? null;
      // Normaliza decimal (0–1) para percentual (0–100)
      const ivrN  = ivr != null ? (ivr <= 1 ? ivr * 100 : ivr) : null;
      const ivpN  = ivp != null ? (ivp <= 1 ? ivp * 100 : ivp) : null;
      if (ivrN != null) { marketData.ivRank = ivrN; marketData.ivPercentile = ivpN; renderIV(ivrN, ivpN); }
      else { console.warn('[IV] campos IV ausentes — resposta:', JSON.stringify(vR.value)); renderIVEmpty(); }
    } else { console.error('[IV] requisição falhou:', vR.reason?.message); renderIVEmpty(); }

    // Option Chain
    if (cR.status === 'fulfilled') marketData.optionChain = cR.value?.data ?? cR.value;
    else console.warn('[Chain] requisição falhou:', cR.reason?.message);

    // VIX — índice via /market-data/by-type?index[]=...
    if (vxR.status === 'fulfilled') {
      const items  = vxR.value?.data?.items;
      const q      = (Array.isArray(items) && items.length) ? items[0] : (vxR.value?.data ?? vxR.value);
      const price  = q?.last ?? q?.mark ?? q?.close ?? null;
      const pClose = q?.prevClose ?? q?.['prev-close'] ?? null;
      const chg    = pClose && price != null ? ((price - pClose) / pClose * 100) : null;
      if (price != null) { marketData.vix = price; marketData.vixChange = chg; renderVIX(price, chg); }
      else { console.warn('[VIX] price nulo — resposta:', JSON.stringify(vxR.value)); renderVIXEmpty(); }
    } else { console.error('[VIX] requisição falhou:', vxR.reason?.message); renderVIXEmpty(); }

    if (marketData.spyPrice) {
      document.getElementById('btn-analyze').disabled = false;
      document.getElementById('ai-placeholder').textContent =
        'Dados prontos. Clique em "Analisar com IA" para recomendação estratégica.';
    }
    updateTimestamp();
    setApiStatus('ok', '● API OK');
  } catch (err) {
    if (err.code === 401) {
      try { await fetchAccessToken(); loadData(); } catch { setApiStatus('err', '✕ SESSÃO EXPIRADA'); }
    }
  } finally {
    stopSpinner();
  }
}

// ─── FORMATADORES ─────────────────────────────────────────────
const f      = (n, d=2) => n != null ? Number(n).toFixed(d) : '—';
const fPct   = n => n != null ? (n >= 0 ? `+${f(n)}%` : `${f(n)}%`) : '—';
const fPrice = n => n != null ? `$${f(n)}` : '—';
const cls    = n => n > 0 ? 'up' : n < 0 ? 'down' : 'neutral';
const arr    = n => n > 0 ? '▲' : n < 0 ? '▼' : '';

// ─── CARDS DE MERCADO ─────────────────────────────────────────
function renderSPY(price, chg) {
  document.getElementById('spy-price').textContent = fPrice(price);
  document.getElementById('spy-change').innerHTML  =
    `<span class="${cls(chg)}">${arr(chg)} ${fPct(chg)}</span>
     <span style="color:var(--text-muted);margin-left:6px;font-size:.7rem">${isMarketOpen() ? 'tempo real' : 'fechamento'}</span>`;
}

function renderSPYEmpty() {
  document.getElementById('spy-price').textContent = '—';
  document.getElementById('spy-change').innerHTML  = '<span class="neutral">Indisponível</span>';
}

function renderIV(ivr, ivp) {
  document.getElementById('iv-rank').textContent     = `${f(ivr, 0)}%`;
  document.getElementById('iv-percentile').innerHTML = `<span class="neutral">Percentil: ${ivp != null ? f(ivp, 0) + '%' : '—'}</span>`;
  document.getElementById('iv-fill').style.width     = `${Math.min(100, Math.max(0, ivr))}%`;
  const b = document.getElementById('iv-badge');
  b.style.display = 'block';
  if      (ivr < 30) { b.textContent = 'BAIXO'; b.className = 'card-badge badge-low'; }
  else if (ivr < 70) { b.textContent = 'MÉDIO'; b.className = 'card-badge badge-med'; }
  else               { b.textContent = 'ALTO';  b.className = 'card-badge badge-hi';  }
}

function renderIVEmpty() {
  document.getElementById('iv-rank').textContent     = '—';
  document.getElementById('iv-percentile').innerHTML = '<span class="neutral">IV indisponível</span>';
}

function renderVIX(price, chg) {
  document.getElementById('vix-price').textContent = f(price);
  document.getElementById('vix-change').innerHTML  =
    `<span class="${cls(chg)}">${arr(chg)} ${fPct(chg)}</span>`;
  const b = document.getElementById('vix-badge');
  b.style.display = 'block';
  if      (price < 15) { b.textContent = 'BAIXA VOL'; b.className = 'card-badge badge-low'; }
  else if (price < 25) { b.textContent = 'VOL MOD.';  b.className = 'card-badge badge-med'; }
  else                 { b.textContent = 'ALTA VOL';  b.className = 'card-badge badge-hi';  }
}

function renderVIXEmpty() {
  document.getElementById('vix-price').textContent = '—';
  document.getElementById('vix-change').innerHTML  = '<span class="neutral">VIX indisponível</span>';
}

// ─── FALLBACK GLOBAL (falha de OAuth) ────────────────────────
function renderFallback() {
  ['spy-price', 'iv-rank', 'vix-price'].forEach(id => {
    document.getElementById(id).textContent = '—';
  });
  ['spy-change', 'iv-percentile', 'vix-change'].forEach(id => {
    document.getElementById(id).innerHTML = '<span class="neutral">API indisponível</span>';
  });
  document.getElementById('ai-placeholder').textContent =
    'API Tastytrade indisponível. A análise IA pode ser usada com dados limitados.';
  document.getElementById('btn-analyze').disabled = false;
  updateTimestamp();
}

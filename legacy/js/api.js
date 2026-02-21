// ─── TASTYTRADE OAUTH2 — REFRESH TOKEN ───────────────────────
async function fetchAccessToken() {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: CONFIG.TT_REFRESH_TOKEN,
    client_id:     CONFIG.TT_CLIENT_ID,
    client_secret: CONFIG.TT_CLIENT_SECRET,
  });

  const endpoints = [
    `${CONFIG.TT_BASE}/oauth/token`,
    `${CONFIG.TT_BASE}/sessions/oauth/token`,
  ];

  let lastErr = null;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      let json;
      try { json = await res.json(); } catch { json = {}; }

      if (!res.ok) {
        lastErr = new Error(json.error_description || json['error-message'] || json.error || `HTTP ${res.status}`);
        continue;
      }

      const token = json.access_token;
      if (!token) { lastErr = new Error('access_token ausente'); continue; }

      const exp         = json.expires_in || 3600;
      accessToken       = token;
      accessTokenExpiry = Date.now() + (exp - 60) * 1000;
      sessionStorage.setItem('tt_access', token);
      sessionStorage.setItem('tt_expiry', String(accessTokenExpiry));
      return token;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('OAuth2 falhou em todos os endpoints');
}

async function ensureToken() {
  if (accessToken && Date.now() < accessTokenExpiry) return accessToken;
  return fetchAccessToken();
}

// ─── HTTP GET AUTENTICADO ─────────────────────────────────────
async function ttGet(path) {
  const token = await ensureToken();
  const res   = await fetch(`${CONFIG.TT_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
  });
  if (res.status === 401) throw Object.assign(new Error('401'), { code: 401 });
  if (res.status === 429) {
    showToast(`Rate limit. Aguarde ${res.headers.get('Retry-After') || '30'}s`);
    throw Object.assign(new Error('429'), { code: 429 });
  }
  if (!res.ok) {
    let m = `HTTP ${res.status}`;
    try { const j = await res.json(); m = j['error-message'] || j.error || m; } catch {}
    throw new Error(m);
  }
  return res.json();
}

// ─── INICIALIZAÇÃO DA API ─────────────────────────────────────
async function initTastytradeAPI() {
  setApiStatus('loading', '⟳ CONECTANDO');
  const initEl = document.getElementById('api-init');
  initEl.classList.add('show');
  document.getElementById('api-init-msg').textContent = 'Autenticando via OAuth2...';

  try {
    await fetchAccessToken();
    setApiStatus('ok', '● API OK');
    initEl.classList.remove('show');
    loadData();
    refreshTimer = setInterval(loadData, CONFIG.REFRESH_INTERVAL);
  } catch (err) {
    initEl.classList.remove('show');
    setApiStatus('err', '✕ API ERRO');
    console.error('OAuth2:', err);
    showToast(`OAuth2 erro: ${err.message}`);
    renderFallback();
  }
}

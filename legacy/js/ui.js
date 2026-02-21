// ─── MODAL DE LOGIN ───────────────────────────────────────────
function showLoginModal() { document.getElementById('modal-overlay').classList.add('show'); }
function hideLoginModal() { document.getElementById('modal-overlay').classList.remove('show'); }

// ─── STATUS DA API ────────────────────────────────────────────
function setApiStatus(state, msg) {
  const el = document.getElementById('api-status-badge');
  el.style.display = 'block';
  el.textContent   = msg;
  el.className     = `api-${state}`;
}

// ─── STATUS DO MERCADO ────────────────────────────────────────
function isMarketOpen() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  if (et.getDay() === 0 || et.getDay() === 6) return false;
  const t = et.getHours() * 60 + et.getMinutes();
  return t >= 570 && t < 960; // 09:30–16:00 ET
}

function updateMarketStatus() {
  const open = isMarketOpen();
  const el   = document.getElementById('market-status');
  el.style.display = 'block';
  el.textContent   = open ? '● AO VIVO' : '● FECHADO';
  el.className     = open ? 'status-open' : 'status-closed';
}

// ─── SPINNER DE REFRESH ───────────────────────────────────────
function startSpinner() { document.getElementById('refresh-spinner').style.display = 'block'; }
function stopSpinner()  { document.getElementById('refresh-spinner').style.display = 'none';  }

// ─── TOAST ────────────────────────────────────────────────────
let toastT;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), 5000);
}

// ─── TIMESTAMP ────────────────────────────────────────────────
function updateTimestamp() {
  document.getElementById('update-time').textContent = new Date().toLocaleTimeString('pt-BR');
}

// ─── UTILITÁRIOS ──────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function logout() {
  sessionStorage.clear();
  clearInterval(refreshTimer);
  location.reload();
}

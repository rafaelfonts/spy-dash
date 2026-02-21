// ─── PÓS-LOGIN ────────────────────────────────────────────────
async function onPlatformLogin() {
  document.getElementById('btn-logout').style.display  = 'block';
  document.getElementById('btn-refresh').style.display = 'block';
  document.getElementById('last-update').style.display = 'flex';
  await initTastytradeAPI();
}

// ─── EVENTOS DE LOGIN ─────────────────────────────────────────
document.getElementById('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-login').click();
});

document.getElementById('btn-login').addEventListener('click', async () => {
  const user  = document.getElementById('login-user').value.trim();
  const pass  = document.getElementById('login-password').value.trim();
  const errEl = document.getElementById('modal-error');
  const btn   = document.getElementById('btn-login');
  errEl.style.display = 'none';

  if (!user || !pass) {
    errEl.textContent   = 'Preencha usuário e senha.';
    errEl.style.display = 'block';
    return;
  }

  btn.classList.add('loading');
  btn.disabled = true;
  btn.querySelector('.btn-text').textContent = 'Entrando...';

  await sleep(500); // simula latência — substituir por Supabase

  sessionStorage.setItem('app_auth', '1');
  hideLoginModal();
  onPlatformLogin();

  btn.classList.remove('loading');
  btn.disabled = false;
  btn.querySelector('.btn-text').textContent = 'Entrar';
});

// ─── BOOT ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  if (isLoggedIn()) onPlatformLogin();
  else showLoginModal();
});

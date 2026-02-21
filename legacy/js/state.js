// ─── ESTADO GLOBAL ────────────────────────────────────────────
// Variáveis mutáveis compartilhadas entre os módulos.
let accessToken       = sessionStorage.getItem('tt_access') || null;
let accessTokenExpiry = parseInt(sessionStorage.getItem('tt_expiry') || '0');
let marketData        = {};
let refreshTimer      = null;

const isLoggedIn = () => sessionStorage.getItem('app_auth') === '1';

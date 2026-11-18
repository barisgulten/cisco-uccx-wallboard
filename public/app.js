// Cisco UCCX 12.5 Wallboard Client Application

const i18n = window.WALLBOARD_I18N;
const LANG_STORAGE_KEY = 'uccx_wallboard_lang';
const ADMIN_TOKEN_KEY = 'uccx_admin_token';
const ADMIN_USER_KEY = 'uccx_admin_user';

let socket = null;
let currentCSQ = 'SALES';
let currentTeam = 'Default';
let currentLang = 'tr';
let slideShowActive = false;
let progressIntervalId = null;
let soundEnabled = true;
let audioContext = null;
let availableCSQs = [];
let lastStatus = null;
let lastPayload = null;
let pendingAdminAction = null;

// DOM Elements
const teamSelect = document.getElementById('teamSelect');
const csqSelect = document.getElementById('csqSelect');
const slideShowBtn = document.getElementById('slideShowBtn');
const slideDurationSelect = document.getElementById('slideDuration');
const themeSelect = document.getElementById('themeSelect');
const langSelect = document.getElementById('langSelect');
const addCsqQuickBtn = document.getElementById('addCsqQuickBtn');
const cfgCsqList = document.getElementById('cfgCsqList');
const darkModeToggleBtn = document.getElementById('darkModeToggleBtn');
const soundToggleBtn = document.getElementById('soundToggleBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const adminBtn = document.getElementById('adminBtn');
const logoutBtn = document.getElementById('logoutBtn');
const connectionStatusBadge = document.getElementById('connectionStatusBadge');
const slideProgressBar = document.getElementById('slideProgressBar');
const slideProgressFill = document.getElementById('slideProgressFill');
const footerClock = document.getElementById('footerClock');
const footerHost = document.getElementById('footerHost');

// Admin Modal Elements
const adminModal = document.getElementById('adminModal');
const closeModalBtn = document.getElementById('closeModalBtn');
const settingsForm = document.getElementById('settingsForm');
const testConnBtn = document.getElementById('testConnBtn');
const testResultBox = document.getElementById('testResultBox');
const updateAdminCredsBtn = document.getElementById('updateAdminCredsBtn');
const adminCredsResultBox = document.getElementById('adminCredsResultBox');

// Login Modal Elements
const loginModal = document.getElementById('loginModal');
const closeLoginModalBtn = document.getElementById('closeLoginModalBtn');
const cancelLoginBtn = document.getElementById('cancelLoginBtn');
const loginForm = document.getElementById('loginForm');
const loginUsernameInput = document.getElementById('loginUsername');
const loginPasswordInput = document.getElementById('loginPassword');
const toggleLoginPassBtn = document.getElementById('toggleLoginPassBtn');
const loginErrorBox = document.getElementById('loginErrorBox');
const loginSubmitBtn = document.getElementById('loginSubmitBtn');

function t(key, vars) {
  return i18n.translate(currentLang, key, vars);
}

function getAdminToken() {
  return sessionStorage.getItem(ADMIN_TOKEN_KEY);
}

function getAdminUser() {
  return sessionStorage.getItem(ADMIN_USER_KEY) || '';
}

function setAdminSession(token, username) {
  sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
  sessionStorage.setItem(ADMIN_USER_KEY, username || 'admin');
  updateAdminNavUI();
}

function clearAdminSession() {
  sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  sessionStorage.removeItem(ADMIN_USER_KEY);
  updateAdminNavUI();
}

function updateAdminNavUI() {
  if (!logoutBtn) return;
  const token = getAdminToken();
  const user = getAdminUser();
  if (token) {
    logoutBtn.style.display = '';
    logoutBtn.textContent = user ? `🔓 ${t('nav.logout')} (${user})` : `🔓 ${t('nav.logout')}`;
  } else {
    logoutBtn.style.display = 'none';
    logoutBtn.textContent = t('nav.logout');
  }
}

function openLoginModal(errorMsg, onSuccess) {
  pendingAdminAction = typeof onSuccess === 'function' ? onSuccess : null;
  if (loginPasswordInput) {
    loginPasswordInput.value = '';
    loginPasswordInput.type = 'password';
  }
  if (toggleLoginPassBtn) {
    toggleLoginPassBtn.textContent = '👁️';
  }
  if (loginErrorBox) {
    if (errorMsg) {
      loginErrorBox.textContent = errorMsg;
      loginErrorBox.style.display = 'block';
    } else {
      loginErrorBox.textContent = '';
      loginErrorBox.style.display = 'none';
    }
  }
  if (loginModal) {
    loginModal.classList.add('open');
    setTimeout(() => {
      if (loginUsernameInput && !loginUsernameInput.value) {
        loginUsernameInput.focus();
      } else if (loginPasswordInput) {
        loginPasswordInput.focus();
      }
    }, 30);
  }
}

function closeLoginModal() {
  if (loginModal) {
    loginModal.classList.remove('open');
  }
  pendingAdminAction = null;
}

async function adminFetch(url, options = {}) {
  const token = getAdminToken();
  const headers = Object.assign({}, options.headers || {});
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, Object.assign({}, options, { headers }));
  if (res.status === 401) {
    let body = null;
    try {
      body = await res.clone().json();
    } catch (_) {
      body = null;
    }
    if (!body || body.code === 'UNAUTHORIZED') {
      clearAdminSession();
      if (adminModal) adminModal.classList.remove('open');
      openLoginModal(t('msg.sessionExpired'));
    }
  }
  return res;
}

async function ensureAdminAuthenticated(onSuccess) {
  const token = getAdminToken();
  if (!token) {
    openLoginModal('', onSuccess);
    return;
  }
  try {
    const res = await fetch('/api/admin/session', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.username) {
        sessionStorage.setItem(ADMIN_USER_KEY, data.username);
        updateAdminNavUI();
      }
      onSuccess();
      return;
    }
  } catch (err) {
    console.warn('Admin session check failed:', err);
  }
  clearAdminSession();
  openLoginModal(t('msg.sessionExpired'), onSuccess);
}

async function verifyAdminSessionSilently() {
  const token = getAdminToken();
  if (!token) {
    updateAdminNavUI();
    return;
  }
  try {
    const res = await fetch('/api/admin/session', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.username) {
        setAdminSession(token, data.username);
        return;
      }
    }
  } catch (_) {
    // Ignore transient network errors on initial check
  }
  clearAdminSession();
}

function getQueryLang() {
  const params = new URLSearchParams(window.location.search);
  const lang = params.get('lang');
  return i18n.isSupportedLang(lang) ? lang.toLowerCase() : null;
}

function resolveInitialLang(serverDefaultLang) {
  const queryLang = getQueryLang();
  if (queryLang) return queryLang;

  const savedLang = localStorage.getItem(LANG_STORAGE_KEY);
  if (i18n.isSupportedLang(savedLang)) return savedLang.toLowerCase();

  if (i18n.isSupportedLang(serverDefaultLang)) return serverDefaultLang.toLowerCase();
  return 'tr';
}

function updateClock() {
  const now = new Date();
  footerClock.textContent = now.toLocaleTimeString(i18n.getLocale(currentLang));
}

function updateDarkModeButton() {
  if (!darkModeToggleBtn) return;
  const isDark = document.body.classList.contains('theme-dark');
  darkModeToggleBtn.textContent = isDark ? t('nav.lightMode') : t('nav.darkMode');
  darkModeToggleBtn.classList.toggle('active', isDark);
}

function updateSoundButton() {
  if (!soundToggleBtn) return;
  soundToggleBtn.textContent = soundEnabled ? '🔊' : '🔇';
  soundToggleBtn.title = soundEnabled ? t('nav.soundOn') : t('nav.soundOff');
}

function updateSlideDurationLabels() {
  if (!slideDurationSelect) return;
  const unit = t('nav.secUnit');
  Array.from(slideDurationSelect.options).forEach((opt) => {
    opt.textContent = `${opt.value} ${unit}`;
  });
}

function updateFooterHost(status) {
  if (!footerHost || !status) return;
  const modeLabel = status.mode === 'live' ? t('status.modeLiveShort') : t('status.modeMockShort');
  footerHost.textContent = status.host
    ? `UCCX: ${status.host}:${status.port} (${status.database}) [${modeLabel}]`
    : `UCCX Informix [${modeLabel}]`;
}

function updatePercentageDisplays(payload) {
  const slVal = payload && payload.metrics ? payload.metrics.slOraniVal : 100;
  const arVal = payload && payload.metrics ? payload.metrics.arOraniVal : 100;
  setCardValue('val-slOrani', i18n.formatPercent(slVal, currentLang));
  setCardValue('val-arOrani', i18n.formatPercent(arVal, currentLang));
}

function applyLanguage(lang, persist = true) {
  currentLang = i18n.isSupportedLang(lang) ? lang.toLowerCase() : 'tr';
  document.documentElement.lang = currentLang;
  document.title = t('app.title');

  if (langSelect) {
    langSelect.value = currentLang;
  }
  if (persist) {
    localStorage.setItem(LANG_STORAGE_KEY, currentLang);
  }

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });

  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    el.setAttribute('title', t(key));
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    el.setAttribute('placeholder', t(key));
  });

  updateSlideDurationLabels();

  if (csqSelect) {
    const allOpt = Array.from(csqSelect.options).find((opt) => opt.value === 'ALL');
    if (allOpt) {
      allOpt.textContent = t('csq.all');
    }
  }

  updateDarkModeButton();
  updateSoundButton();
  updateAdminNavUI();
  updateClock();
  updateStatusBadge(lastStatus);
  updateFooterHost(lastStatus);
  updatePercentageDisplays(lastPayload);
}

// Web Audio API Beep Generator for Alerts
function playAlertBeep() {
  if (!soundEnabled) return;
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioContext.currentTime); // A5 note
    gain.gain.setValueAtTime(0.15, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.4);
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start();
    osc.stop(audioContext.currentTime + 0.4);
  } catch (e) {
    console.warn('Audio alert error:', e);
  }
}

setInterval(updateClock, 1000);

// Initialize Theme from localStorage
function initTheme() {
  const savedTheme = localStorage.getItem('uccx_wallboard_theme') || 'theme-sunny';
  applyTheme(savedTheme);

  themeSelect.addEventListener('change', (e) => {
    applyTheme(e.target.value);
  });

  if (darkModeToggleBtn) {
    darkModeToggleBtn.addEventListener('click', () => {
      const isDark = document.body.classList.contains('theme-dark');
      const nextTheme = isDark ? 'theme-sunny' : 'theme-dark';
      applyTheme(nextTheme);
    });
  }
}

function applyTheme(themeName) {
  document.body.className = themeName;
  themeSelect.value = themeName;
  localStorage.setItem('uccx_wallboard_theme', themeName);
  updateDarkModeButton();
}

function initLanguage() {
  const initialLang = resolveInitialLang();
  applyLanguage(initialLang, Boolean(getQueryLang()));

  if (langSelect) {
    langSelect.addEventListener('change', (e) => {
      applyLanguage(e.target.value, true);
    });
  }
}

// Fetch initial metadata (CSQs, Teams, Status)
async function fetchMetadata() {
  try {
    const [csqRes, teamRes, statusRes] = await Promise.all([
      fetch('/api/csqs'),
      fetch('/api/teams'),
      fetch('/api/status')
    ]);

    const csqs = await csqRes.json();
    const teams = await teamRes.json();
    const status = await statusRes.json();

    lastStatus = status;

    if (!getQueryLang() && !i18n.isSupportedLang(localStorage.getItem(LANG_STORAGE_KEY)) && status.defaultLang) {
      applyLanguage(status.defaultLang, false);
    }

    availableCSQs = csqs.map((c) => c.csqname);

    // Populate CSQ Dropdown
    csqSelect.innerHTML = '';
    availableCSQs.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name === 'ALL' ? t('csq.all') : name;
      csqSelect.appendChild(opt);
    });
    if (availableCSQs.includes(currentCSQ)) {
      csqSelect.value = currentCSQ;
    } else if (availableCSQs.length > 0) {
      currentCSQ = availableCSQs[0];
      csqSelect.value = currentCSQ;
    }

    if (cfgCsqList) {
      cfgCsqList.value = availableCSQs.filter((name) => name !== 'ALL').join(', ');
    }

    // Populate Team Dropdown
    teamSelect.innerHTML = '';
    teams.forEach((team) => {
      const opt = document.createElement('option');
      opt.value = team.teamname;
      opt.textContent = team.teamname;
      teamSelect.appendChild(opt);
    });
    teamSelect.value = currentTeam;

    // Update Footer Host Info
    updateFooterHost(status);
    updateStatusBadge(status);
  } catch (err) {
    console.error('Error fetching metadata:', err);
  }
}

function updateStatusBadge(status) {
  if (!connectionStatusBadge) return;
  connectionStatusBadge.className = 'status-badge';
  const textSpan = connectionStatusBadge.querySelector('.status-text');

  if (!status) {
    textSpan.textContent = t('status.connecting');
    return;
  }

  if (status.mode === 'live') {
    connectionStatusBadge.classList.add('live');
    textSpan.textContent = t('status.live');
    connectionStatusBadge.title = status.host
      ? `${t('status.connectedTo')}: ${status.host}:${status.port}`
      : t('status.connectedTo');
  } else {
    connectionStatusBadge.classList.add('mock');
    textSpan.textContent = t('status.mock');
    connectionStatusBadge.title = status.lastError || t('status.mockActive');
  }
}

// Update DOM cards with incoming metric payload
function updateWallboardUI(payload) {
  if (!payload || !payload.metrics) return;
  lastPayload = payload;
  const m = payload.metrics;

  setCardValue('val-toplamCagri', m.toplamCagri);
  setCardValue('val-musaitOlmayanMT', m.musaitOlmayanMT);
  setCardValue('val-musaitMT', m.musaitMT);
  setCardValue('val-gorusenMT', m.gorusenMT);
  setCardValue('val-cevaplananCagrilar', m.cevaplananCagrilar);
  setCardValue('val-kacanCagrilar', m.kacanCagrilar);
  setCardValue('val-bekleyenCagrilar', m.bekleyenCagrilar);
  setCardValue('val-slCevaplanan', m.slCevaplanan);
  setCardValue('val-slKacan', m.slKacan);

  setCardValue('val-enUzunBekleme', m.enUzunBekleme);
  setCardValue('val-ortalamaGorusme', m.ortalamaGorusme);
  setCardValue('val-ortalamaKacan', m.ortalamaKacan);
  setCardValue('val-ortalamaBekleme', m.ortalamaBekleme);

  updatePercentageDisplays(payload);

  const cardBekleyen = document.getElementById('card-bekleyenCagrilar');
  if (m.bekleyenCagrilar >= 3) {
    cardBekleyen.className = 'metric-card alert-danger';
    playAlertBeep();
  } else if (m.bekleyenCagrilar > 0) {
    cardBekleyen.className = 'metric-card alert-warning';
  } else {
    cardBekleyen.className = 'metric-card';
  }

  const cardUzunBekleme = document.getElementById('card-enUzunBekleme');
  if (m.enUzunBeklemeSeconds >= 60) {
    cardUzunBekleme.className = 'metric-card alert-danger';
  } else {
    cardUzunBekleme.className = 'metric-card';
  }

  const cardSL = document.getElementById('card-slOrani');
  if (m.slOraniVal < 80) {
    cardSL.className = 'metric-card alert-warning';
  } else {
    cardSL.className = 'metric-card';
  }
}

function setCardValue(elementId, newValue) {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (el.textContent !== String(newValue)) {
    el.textContent = newValue;
    el.style.transform = 'scale(1.08)';
    setTimeout(() => {
      el.style.transform = 'scale(1)';
    }, 180);
  }
}

// WebSocket Connection Management
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    console.log('[WS] Connected');
    subscribeCurrentFilter();
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'METRICS_UPDATE') {
        updateWallboardUI(msg.data);
      }
    } catch (e) {
      console.error('[WS Data Parse Error]', e);
    }
  };

  socket.onclose = () => {
    console.warn('[WS] Disconnected, retrying in 3 seconds...');
    setTimeout(connectWebSocket, 3000);
  };

  socket.onerror = (err) => {
    console.error('[WS Error]', err);
  };
}

function subscribeCurrentFilter() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'SUBSCRIBE',
      csq: currentCSQ,
      team: currentTeam
    }));
  }
}

async function promptAndAddCsq() {
  const name = prompt(t('msg.promptAddCsq'));
  if (!name || !name.trim()) return;
  const cleanName = name.trim();
  if (!availableCSQs.includes(cleanName)) {
    const persisted = availableCSQs.filter((c) => c !== 'ALL');
    persisted.push(cleanName);
    const res = await adminFetch('/api/csqs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csqs: persisted })
    });
    if (!res.ok) return;
    currentCSQ = cleanName;
    await fetchMetadata();
    subscribeCurrentFilter();
  } else {
    csqSelect.value = cleanName;
    currentCSQ = cleanName;
    subscribeCurrentFilter();
  }
}

// Quick Add CSQ Button (Protected)
if (addCsqQuickBtn) {
  addCsqQuickBtn.addEventListener('click', () => {
    ensureAdminAuthenticated(promptAndAddCsq);
  });
}

// Dropdown change handlers
csqSelect.addEventListener('change', (e) => {
  currentCSQ = e.target.value;
  subscribeCurrentFilter();
});

teamSelect.addEventListener('change', (e) => {
  currentTeam = e.target.value;
  subscribeCurrentFilter();
});

// Slide Show Manager
function startSlideShow() {
  if (availableCSQs.length <= 1) return;
  slideShowActive = true;
  slideShowBtn.classList.add('active');
  slideProgressBar.classList.add('active');

  const durationSec = parseInt(slideDurationSelect.value, 10) || 10;
  let elapsedMs = 0;
  const tickMs = 100;

  progressIntervalId = setInterval(() => {
    elapsedMs += tickMs;
    const pct = Math.min(100, (elapsedMs / (durationSec * 1000)) * 100);
    slideProgressFill.style.width = `${pct}%`;

    if (elapsedMs >= durationSec * 1000) {
      elapsedMs = 0;
      slideProgressFill.style.width = '0%';
      const currentIndex = availableCSQs.indexOf(currentCSQ);
      const nextIndex = (currentIndex + 1) % availableCSQs.length;
      currentCSQ = availableCSQs[nextIndex];
      csqSelect.value = currentCSQ;
      subscribeCurrentFilter();
    }
  }, tickMs);
}

function stopSlideShow() {
  slideShowActive = false;
  slideShowBtn.classList.remove('active');
  slideProgressBar.classList.remove('active');
  slideProgressFill.style.width = '0%';
  if (progressIntervalId) clearInterval(progressIntervalId);
}

slideShowBtn.addEventListener('click', () => {
  if (slideShowActive) {
    stopSlideShow();
  } else {
    startSlideShow();
  }
});

slideDurationSelect.addEventListener('change', () => {
  if (slideShowActive) {
    stopSlideShow();
    startSlideShow();
  }
});

// Sound Toggle
soundToggleBtn.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  updateSoundButton();
});

// Fullscreen Toggle
fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch((err) => {
      console.warn('Fullscreen error:', err);
    });
    fullscreenBtn.textContent = '🗗';
  } else if (document.exitFullscreen) {
    document.exitFullscreen();
    fullscreenBtn.textContent = '⛶';
  }
});

// Admin Panel Open & Handlers
async function openAdminPanel() {
  testResultBox.style.display = 'none';
  if (adminCredsResultBox) adminCredsResultBox.style.display = 'none';

  try {
    const res = await adminFetch('/api/admin/settings');
    if (!res.ok) return;
    const cfg = await res.json();

    document.getElementById('cfgHost').value = cfg.host || '';
    document.getElementById('cfgPort').value = cfg.port || 1504;
    document.getElementById('cfgServer').value = cfg.server || '';
    document.getElementById('cfgDb').value = cfg.database || '';
    document.getElementById('cfgUser').value = cfg.user || '';
    document.getElementById('cfgPassword').value = '';
    document.getElementById('cfgRefresh').value = cfg.refreshIntervalMs || 10000;
    document.getElementById('cfgMockMode').value = cfg.mockMode || 'auto';

    if (cfgCsqList) {
      cfgCsqList.value = availableCSQs.filter((name) => name !== 'ALL').join(', ');
    }

    const admNewUser = document.getElementById('admNewUser');
    const admCurrentPass = document.getElementById('admCurrentPass');
    const admNewPass = document.getElementById('admNewPass');
    if (admNewUser) admNewUser.value = cfg.adminUser || getAdminUser() || '';
    if (admCurrentPass) admCurrentPass.value = '';
    if (admNewPass) admNewPass.value = '';

    adminModal.classList.add('open');
  } catch (err) {
    console.error('Error loading admin settings:', err);
  }
}

adminBtn.addEventListener('click', () => {
  ensureAdminAuthenticated(openAdminPanel);
});

closeModalBtn.addEventListener('click', () => {
  adminModal.classList.remove('open');
});

window.addEventListener('click', (e) => {
  if (e.target === adminModal) {
    adminModal.classList.remove('open');
  }
  if (e.target === loginModal) {
    closeLoginModal();
  }
});

if (closeLoginModalBtn) {
  closeLoginModalBtn.addEventListener('click', closeLoginModal);
}
if (cancelLoginBtn) {
  cancelLoginBtn.addEventListener('click', closeLoginModal);
}

if (toggleLoginPassBtn && loginPasswordInput) {
  toggleLoginPassBtn.addEventListener('click', () => {
    const isPassword = loginPasswordInput.type === 'password';
    loginPasswordInput.type = isPassword ? 'text' : 'password';
    toggleLoginPassBtn.textContent = isPassword ? '🙈' : '👁️';
  });
}

if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (loginErrorBox) loginErrorBox.style.display = 'none';
    if (loginSubmitBtn) {
      loginSubmitBtn.disabled = true;
      loginSubmitBtn.textContent = t('login.submittingBtn');
    }

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: loginUsernameInput ? loginUsernameInput.value : '',
          password: loginPasswordInput ? loginPasswordInput.value : ''
        })
      });
      const data = await res.json();

      if (res.ok && data.success && data.token) {
        const nextAction = pendingAdminAction;
        setAdminSession(data.token, data.username);
        closeLoginModal();
        if (typeof nextAction === 'function') {
          nextAction();
        }
      } else if (loginErrorBox) {
        loginErrorBox.textContent = data.code === 'RATE_LIMITED' ? t('msg.rateLimited') : t('msg.invalidCredentials');
        loginErrorBox.style.display = 'block';
        if (loginPasswordInput) {
          loginPasswordInput.value = '';
          loginPasswordInput.focus();
        }
      }
    } catch (err) {
      if (loginErrorBox) {
        loginErrorBox.textContent = t('msg.connError', { error: err.message });
        loginErrorBox.style.display = 'block';
      }
    } finally {
      if (loginSubmitBtn) {
        loginSubmitBtn.disabled = false;
        loginSubmitBtn.textContent = t('login.submitBtn');
      }
    }
  });
}

logoutBtn.addEventListener('click', async (e) => {
  e.preventDefault();
  const token = getAdminToken();
  if (token) {
    try {
      await fetch('/api/admin/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch (_) {
      // Ignore logout network error
    }
  }
  clearAdminSession();
  if (adminModal) adminModal.classList.remove('open');
  alert(t('msg.loggedOut'));
});

// Update Admin Credentials Action
if (updateAdminCredsBtn) {
  updateAdminCredsBtn.addEventListener('click', async () => {
    const newUsername = document.getElementById('admNewUser').value.trim();
    const currentPassword = document.getElementById('admCurrentPass').value;
    const newPassword = document.getElementById('admNewPass').value;

    adminCredsResultBox.style.display = 'block';

    if (!newUsername || newPassword.length < 8) {
      adminCredsResultBox.className = 'test-result-box error';
      adminCredsResultBox.textContent = t('msg.adminPassTooShort');
      return;
    }

    try {
      const res = await adminFetch('/api/admin/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newUsername, newPassword })
      });
      if (res.status === 401) {
        const errData = await res.json().catch(() => ({}));
        if (errData.code === 'UNAUTHORIZED') return;
        adminCredsResultBox.className = 'test-result-box error';
        adminCredsResultBox.textContent = t('msg.invalidCurrentPass');
        return;
      }

      const data = await res.json();
      if (res.ok && data.success) {
        adminCredsResultBox.className = 'test-result-box success';
        adminCredsResultBox.textContent = t('msg.adminCredsSaved');
        sessionStorage.setItem(ADMIN_USER_KEY, data.username);
        updateAdminNavUI();
        document.getElementById('admCurrentPass').value = '';
        document.getElementById('admNewPass').value = '';
      } else {
        adminCredsResultBox.className = 'test-result-box error';
        adminCredsResultBox.textContent = data.code === 'PASSWORD_TOO_SHORT'
          ? t('msg.adminPassTooShort')
          : t('msg.invalidCurrentPass');
      }
    } catch (err) {
      adminCredsResultBox.className = 'test-result-box error';
      adminCredsResultBox.textContent = t('msg.connError', { error: err.message });
    }
  });
}

// Test Connection Action
testConnBtn.addEventListener('click', async () => {
  testConnBtn.disabled = true;
  testConnBtn.textContent = t('modal.testingBtn');
  testResultBox.style.display = 'block';
  testResultBox.className = 'test-result-box';
  testResultBox.textContent = t('msg.connectingInformix');

  try {
    const res = await adminFetch('/api/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: document.getElementById('cfgHost').value,
        port: document.getElementById('cfgPort').value,
        serverName: document.getElementById('cfgServer').value,
        database: document.getElementById('cfgDb').value,
        user: document.getElementById('cfgUser').value,
        password: document.getElementById('cfgPassword').value
      })
    });
    if (res.status === 401) return;

    const data = await res.json();
    if (data.success) {
      testResultBox.className = 'test-result-box success';
      testResultBox.textContent = t('msg.testSuccess', {
        host: data.host || document.getElementById('cfgHost').value,
        port: data.port || document.getElementById('cfgPort').value,
        count: data.activeCsqCount !== undefined ? data.activeCsqCount : 0
      });
    } else {
      testResultBox.className = 'test-result-box error';
      testResultBox.textContent = t('msg.testFail', {
        error: data.error || data.message || ''
      });
    }
  } catch (err) {
    testResultBox.className = 'test-result-box error';
    testResultBox.textContent = t('msg.connError', { error: err.message });
  } finally {
    testConnBtn.disabled = false;
    testConnBtn.textContent = t('modal.testBtn');
  }
});

// Save Settings Action
settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    host: document.getElementById('cfgHost').value,
    port: document.getElementById('cfgPort').value,
    serverName: document.getElementById('cfgServer').value,
    database: document.getElementById('cfgDb').value,
    user: document.getElementById('cfgUser').value,
    password: document.getElementById('cfgPassword').value,
    refreshInterval: document.getElementById('cfgRefresh').value,
    mockMode: document.getElementById('cfgMockMode').value
  };

  const csqString = cfgCsqList ? cfgCsqList.value : '';
  const newCsqs = csqString
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'ALL' && !s.includes('TÜMÜ') && !s.includes('OverAll'));

  try {
    const [settingsRes, csqRes] = await Promise.all([
      adminFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }),
      adminFetch('/api/csqs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csqs: newCsqs })
      })
    ]);

    if (settingsRes.status === 401 || csqRes.status === 401) return;

    const data = await settingsRes.json();
    if (data.success) {
      alert(t('msg.settingsSaved'));
      adminModal.classList.remove('open');
      fetchMetadata();
    }
  } catch (err) {
    alert(t('msg.settingsSaveError', { error: err.message }));
  }
});

// Bootstrap
window.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initLanguage();
  verifyAdminSessionSilently();
  fetchMetadata();
  connectWebSocket();
});

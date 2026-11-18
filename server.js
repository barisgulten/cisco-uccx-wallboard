const http = require('http');
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const path = require('path');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
  );
  next();
});

const allowedOrigins = config.corsOrigin
  ? config.corsOrigin.split(',').map((o) => o.trim()).filter(Boolean)
  : [];
if (allowedOrigins.length > 0) {
  app.use(cors({ origin: allowedOrigins }));
}

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 4 * 1024 });

// Track connected WebSocket clients with their requested CSQ & Team filters
const clients = new Map();

wss.on('connection', (ws) => {
  clients.set(ws, {
    csq: config.defaultCsq,
    team: config.defaultTeam
  });

  // Send initial data immediately
  db.getMetrics(config.defaultCsq, config.defaultTeam).then((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'METRICS_UPDATE', data }));
    }
  }).catch((err) => {
    console.error('[WS Init Error]', err.message);
  });

  ws.on('message', async (message) => {
    try {
      const parsed = JSON.parse(message);
      if (parsed && typeof parsed === 'object' && parsed.type === 'SUBSCRIBE') {
        const clientPrefs = clients.get(ws) || {};
        if (typeof parsed.csq === 'string' && parsed.csq.trim()) {
          clientPrefs.csq = parsed.csq.trim().slice(0, 64);
        }
        if (typeof parsed.team === 'string' && parsed.team.trim()) {
          clientPrefs.team = parsed.team.trim().slice(0, 64);
        }
        clients.set(ws, clientPrefs);

        const freshData = await db.getMetrics(clientPrefs.csq, clientPrefs.team);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'METRICS_UPDATE', data: freshData }));
        }
      }
    } catch (err) {
      console.error('[WS Error]', err.message);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

// Periodic broadcast of real-time metrics (single DB snapshot shared across all clients)
setInterval(async () => {
  if (clients.size === 0) return;

  try {
    await db.queryInformixCached(true);
  } catch (err) {
    console.error('[Broadcast Fetch Error]', err.message);
  }

  for (const [ws, prefs] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        const data = await db.getMetrics(prefs.csq, prefs.team);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'METRICS_UPDATE', data }));
        }
      } catch (err) {
        console.error('[Broadcast Error]', err.message);
      }
    }
  }
}, config.refreshIntervalMs).unref();

// REST API Endpoints

app.get('/api/status', (req, res) => {
  res.json({
    connected: db.isConnected,
    mode: db.connectionMode,
    lastChecked: db.lastChecked,
    refreshIntervalMs: config.refreshIntervalMs,
    defaultLang: config.defaultLang
  });
});

// Admin Authentication & Settings Endpoints

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (auth.isRateLimited(ip)) {
    return res.status(429).json({
      success: false,
      code: 'RATE_LIMITED',
      message: 'Too many failed login attempts'
    });
  }

  const { username, password } = req.body || {};
  if (!auth.verifyCredentials(username, password)) {
    auth.recordFailedAttempt(ip);
    return res.status(401).json({
      success: false,
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid username or password'
    });
  }

  auth.clearFailedAttempts(ip);
  const session = auth.createSession(auth.getAdminUsername());
  return res.json({
    success: true,
    token: session.token,
    username: session.username,
    expiresAt: session.expiresAt
  });
});

app.post('/api/admin/logout', (req, res) => {
  const token = auth.extractToken(req);
  auth.revokeSession(token);
  res.json({ success: true });
});

app.get('/api/admin/session', auth.requireAdmin, (req, res) => {
  res.json({
    authenticated: true,
    username: req.adminSession.username
  });
});

app.get('/api/admin/settings', auth.requireAdmin, (req, res) => {
  res.json({
    host: config.uccx.host,
    port: config.uccx.port,
    server: config.uccx.server,
    database: config.uccx.database,
    user: config.uccx.user,
    refreshIntervalMs: config.refreshIntervalMs,
    mockMode: config.mockMode,
    adminUser: auth.getAdminUsername(),
    connected: db.isConnected,
    mode: db.connectionMode,
    lastError: db.lastError
  });
});

app.post('/api/admin/credentials', auth.requireAdmin, (req, res) => {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (auth.isRateLimited(ip)) {
    return res.status(429).json({
      success: false,
      code: 'RATE_LIMITED',
      message: 'Too many failed attempts'
    });
  }

  const { currentPassword, newUsername, newPassword } = req.body || {};
  const result = auth.updateAdminCredentials(currentPassword, newUsername, newPassword);
  if (!result.ok) {
    if (result.code === 'INVALID_CURRENT_PASSWORD') {
      auth.recordFailedAttempt(ip);
      return res.status(401).json({
        success: false,
        code: result.code
      });
    }
    return res.status(400).json({
      success: false,
      code: result.code
    });
  }

  auth.clearFailedAttempts(ip);
  auth.revokeOtherSessions(req.adminToken, result.username);
  return res.json({
    success: true,
    username: result.username
  });
});

app.get('/api/csqs', async (req, res) => {
  try {
    const csqs = await db.getCSQs();
    res.json(csqs);
  } catch (err) {
    console.error('[GET /api/csqs Error]', err.message);
    res.status(500).json({ success: false, error: 'Failed to load CSQs' });
  }
});

app.post('/api/csqs', auth.requireAdmin, async (req, res) => {
  const { csqs } = req.body || {};
  if (Array.isArray(csqs)) {
    const updated = db.saveCSQs(csqs);
    res.json({ success: true, csqs: updated });
  } else {
    res.status(400).json({ success: false, message: 'csqs must be an array of strings' });
  }
});

app.get('/api/teams', async (req, res) => {
  try {
    const teams = await db.getTeams();
    res.json(teams);
  } catch (err) {
    console.error('[GET /api/teams Error]', err.message);
    res.status(500).json({ success: false, error: 'Failed to load teams' });
  }
});

app.get('/api/metrics', async (req, res) => {
  try {
    const csq = typeof req.query.csq === 'string' ? req.query.csq : config.defaultCsq;
    const team = typeof req.query.team === 'string' ? req.query.team : config.defaultTeam;
    const metrics = await db.getMetrics(csq, team);
    res.json(metrics);
  } catch (err) {
    console.error('[GET /api/metrics Error]', err.message);
    res.status(500).json({ success: false, error: 'Failed to load metrics' });
  }
});

app.post('/api/test-connection', auth.requireAdmin, async (req, res) => {
  const { host, port, serverName, database, user, password } = req.body || {};
  const candidate = {
    host: host || config.uccx.host,
    port: port || config.uccx.port,
    server: serverName || config.uccx.server,
    database: database || config.uccx.database,
    user: user || config.uccx.user
  };
  const validation = db.validateConnParams(candidate);
  if (!validation.valid) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_PARAMS',
      error: validation.error,
      message: validation.error
    });
  }

  const result = await db.testConnection(
    validation.clean.host,
    validation.clean.port,
    validation.clean.server,
    validation.clean.database,
    validation.clean.user,
    password || config.uccx.password
  );
  return res.json(result);
});

app.post('/api/settings', auth.requireAdmin, async (req, res) => {
  const { host, port, serverName, database, user, password, refreshInterval, mockMode } = req.body || {};
  const candidate = {
    host: host !== undefined && String(host).trim() ? host : config.uccx.host,
    port: port !== undefined && String(port).trim() ? port : config.uccx.port,
    server: serverName !== undefined && String(serverName).trim() ? serverName : config.uccx.server,
    database: database !== undefined && String(database).trim() ? database : config.uccx.database,
    user: user !== undefined && String(user).trim() ? user : config.uccx.user
  };
  const validation = db.validateConnParams(candidate);
  if (!validation.valid) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_PARAMS',
      error: validation.error,
      message: validation.error
    });
  }

  config.uccx.host = validation.clean.host;
  config.uccx.port = validation.clean.port;
  config.uccx.server = validation.clean.server;
  config.uccx.database = validation.clean.database;
  config.uccx.user = validation.clean.user;
  if (password) config.uccx.password = password;
  if (refreshInterval) config.refreshIntervalMs = Math.max(1000, parseInt(refreshInterval, 10) || 10000);
  if (mockMode !== undefined) config.mockMode = mockMode;

  await db.init();

  return res.json({
    success: true,
    message: 'Ayarlar güncellendi.',
    config: {
      host: config.uccx.host,
      port: config.uccx.port,
      server: config.uccx.server,
      database: config.uccx.database,
      user: config.uccx.user,
      refreshIntervalMs: config.refreshIntervalMs,
      mockMode: config.mockMode,
      mode: db.connectionMode
    }
  });
});

app.get('/api/sql-queries', auth.requireAdmin, (req, res) => {
  res.json(db.getSqlTemplate());
});

// Start Server
async function start() {
  if (config.admin.passwordGenerated && !auth.hasStoredAuth()) {
    console.warn(`[Auth] ⚠ ADMIN_PASSWORD tanımlı değil! Bu oturum için geçici yönetici şifresi: ${config.admin.password}`);
  }
  await db.init();
  server.listen(config.port, () => {
    console.log(`====================================================`);
    console.log(`🚀 Cisco UCCX 12.5 Wallboard Dashboard Başlatıldı!`);
    console.log(`📡 URL: http://localhost:${config.port}`);
    console.log(`🗄️  Informix Target: ${config.uccx.host || '(not configured)'}:${config.uccx.port} (${config.uccx.database})`);
    console.log(`⚡ Çalışma Modu: ${db.connectionMode.toUpperCase()}`);
    console.log(`====================================================`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, server, start };

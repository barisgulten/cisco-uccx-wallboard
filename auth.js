const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const AUTH_FILE = path.join(__dirname, 'admin-auth.json');
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 60 * 1000;
const BLOCK_DURATION_MS = 60 * 1000;
const MAX_SESSIONS = 100;

const sessions = new Map();
const attempts = new Map();

function safeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function loadStoredAuth() {
  try {
    if (!fs.existsSync(AUTH_FILE)) return null;
    const raw = fs.readFileSync(AUTH_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.username === 'string' && typeof parsed.salt === 'string' && typeof parsed.passwordHash === 'string') {
      return parsed;
    }
  } catch (err) {
    console.error('[Auth] Error reading admin-auth.json:', err.message);
  }
  return null;
}

function getAdminUsername() {
  const stored = loadStoredAuth();
  return stored ? stored.username : config.admin.user;
}

function hasStoredAuth() {
  return Boolean(loadStoredAuth());
}

function verifyCredentials(username, password) {
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return false;
  }

  const cleanUser = username.trim();
  const stored = loadStoredAuth();

  if (stored) {
    const userOk = safeEqualStrings(cleanUser, stored.username);
    const derived = crypto.scryptSync(password, Buffer.from(stored.salt, 'hex'), 64);
    const expected = Buffer.from(stored.passwordHash, 'hex');
    if (derived.length !== expected.length) return false;
    return userOk && crypto.timingSafeEqual(derived, expected);
  }

  return safeEqualStrings(cleanUser, config.admin.user) && safeEqualStrings(password, config.admin.password);
}

function updateAdminCredentials(currentPassword, newUsername, newPassword) {
  const currentUser = getAdminUsername();
  if (!verifyCredentials(currentUser, currentPassword)) {
    return { ok: false, code: 'INVALID_CURRENT_PASSWORD' };
  }

  const cleanUser = String(newUsername || '').trim();
  const passStr = String(newPassword || '');
  if (!cleanUser || passStr.length < 8) {
    return { ok: false, code: 'PASSWORD_TOO_SHORT' };
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.scryptSync(passStr, Buffer.from(salt, 'hex'), 64).toString('hex');
  const payload = {
    username: cleanUser,
    salt,
    passwordHash,
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(AUTH_FILE, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { ok: true, username: cleanUser };
}

function pruneAttempts(now) {
  for (const [key, entry] of attempts.entries()) {
    const expiredWindow = now - entry.firstAttemptAt > ATTEMPT_WINDOW_MS + BLOCK_DURATION_MS;
    const unblocked = !entry.blockedUntil || entry.blockedUntil <= now;
    if (expiredWindow && unblocked) {
      attempts.delete(key);
    }
  }
}

function isRateLimited(ip) {
  const now = Date.now();
  pruneAttempts(now);
  const key = String(ip || 'unknown');
  const entry = attempts.get(key);
  if (!entry) return false;

  if (entry.blockedUntil && entry.blockedUntil > now) {
    return true;
  }
  if (entry.blockedUntil && entry.blockedUntil <= now) {
    attempts.delete(key);
    return false;
  }
  return false;
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  pruneAttempts(now);
  const key = String(ip || 'unknown');
  let entry = attempts.get(key);

  if (!entry || (now - entry.firstAttemptAt > ATTEMPT_WINDOW_MS && (!entry.blockedUntil || entry.blockedUntil <= now))) {
    entry = { count: 1, firstAttemptAt: now, blockedUntil: 0 };
  } else {
    entry.count += 1;
    if (entry.count >= MAX_ATTEMPTS) {
      entry.blockedUntil = now + BLOCK_DURATION_MS;
    }
  }
  attempts.set(key, entry);
}

function clearFailedAttempts(ip) {
  attempts.delete(String(ip || 'unknown'));
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (!session || session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function createSession(username) {
  pruneExpiredSessions();
  while (sessions.size >= MAX_SESSIONS) {
    const oldestKey = sessions.keys().next().value;
    sessions.delete(oldestKey);
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + config.admin.sessionTtlMs;
  sessions.set(token, { username, expiresAt });
  return { token, username, expiresAt };
}

function extractToken(req) {
  if (!req || !req.headers) return null;
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim() || null;
  }
  const headerToken = req.headers['x-admin-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  return null;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const session = sessions.get(token);
  if (!session) return null;

  const now = Date.now();
  if (session.expiresAt <= now) {
    sessions.delete(token);
    return null;
  }

  session.expiresAt = now + config.admin.sessionTtlMs;
  return session;
}

function revokeSession(token) {
  if (!token) return;
  sessions.delete(token);
}

function revokeOtherSessions(keepToken, updatedUsername) {
  for (const [token, session] of sessions.entries()) {
    if (token === keepToken) {
      if (updatedUsername) {
        session.username = updatedUsername;
      }
    } else {
      sessions.delete(token);
    }
  }
}

function requireAdmin(req, res, next) {
  const token = extractToken(req);
  const session = verifyToken(token);
  if (!session) {
    return res.status(401).json({
      success: false,
      code: 'UNAUTHORIZED',
      message: 'Unauthorized'
    });
  }
  req.adminSession = session;
  req.adminToken = token;
  return next();
}

module.exports = {
  AUTH_FILE,
  getAdminUsername,
  hasStoredAuth,
  verifyCredentials,
  updateAdminCredentials,
  isRateLimited,
  recordFailedAttempt,
  clearFailedAttempts,
  createSession,
  extractToken,
  verifyToken,
  revokeSession,
  revokeOtherSessions,
  requireAdmin
};

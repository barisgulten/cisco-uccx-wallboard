require('dotenv').config();
const crypto = require('crypto');

const envAdminPass = process.env.ADMIN_PASSWORD || '';
const generatedAdminPass = envAdminPass ? '' : crypto.randomBytes(12).toString('base64url');

const config = {
  port: parseInt(process.env.PORT, 10) || 8080,
  uccx: {
    host: process.env.UCCX_HOST || '',
    port: parseInt(process.env.UCCX_PORT, 10) || 1504,
    server: process.env.UCCX_SERVER || '',
    database: process.env.UCCX_DATABASE || 'db_cra',
    user: process.env.UCCX_USER || 'uccxwallboard',
    password: process.env.UCCX_PASSWORD || ''
  },
  refreshIntervalMs: parseInt(process.env.REFRESH_INTERVAL_MS, 10) || 10000,
  defaultCsq: process.env.DEFAULT_CSQ || 'SALES',
  defaultTeam: process.env.DEFAULT_TEAM || 'Default',
  defaultLang: (process.env.DEFAULT_LANG || 'tr').toLowerCase(),
  mockMode: process.env.MOCK_MODE || 'false',
  corsOrigin: process.env.CORS_ORIGIN || '',
  admin: {
    user: process.env.ADMIN_USER || 'admin',
    password: envAdminPass || generatedAdminPass,
    passwordGenerated: !envAdminPass,
    sessionTtlMs: parseInt(process.env.ADMIN_SESSION_TTL_MS, 10) || 8 * 60 * 60 * 1000
  }
};

module.exports = config;

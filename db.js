const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const HOST_REGEX = /^[A-Za-z0-9._-]{1,253}$/;
const IDENT_REGEX = /^[A-Za-z0-9_]{1,128}$/;

function resolveJavaPath() {
  if (process.env.JAVA_PATH) {
    return process.env.JAVA_PATH;
  }
  if (process.platform === 'win32') {
    const javaBase = path.join('C:', 'Program Files', 'Java');
    try {
      if (fs.existsSync(javaBase)) {
        const dirs = fs.readdirSync(javaBase).sort().reverse();
        for (const dir of dirs) {
          const candidate = path.join(javaBase, dir, 'bin', 'java.exe');
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
      }
    } catch (_) {
      // Fallback to PATH java
    }
  }
  return 'java';
}

const JAVA_PATH = resolveJavaPath();
const APP_DIR = __dirname;
const CSQ_FILE = path.join(APP_DIR, 'csqs.json');
const SNAPSHOT_CACHE_TTL_MS = 2000;

function hasControlChars(str) {
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) < 0x20 || str.charCodeAt(i) === 0x7f) {
      return true;
    }
  }
  return false;
}

function validateConnParams(params) {
  const host = String(params && params.host !== undefined ? params.host : '').trim();
  const portRaw = params && params.port !== undefined ? params.port : '';
  const portNum = parseInt(String(portRaw), 10);
  const server = String(params && params.server !== undefined ? params.server : '').trim();
  const database = String(params && params.database !== undefined ? params.database : '').trim();
  const user = String(params && params.user !== undefined ? params.user : '').trim();

  if (!HOST_REGEX.test(host)) {
    return { valid: false, error: 'Invalid host format' };
  }
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return { valid: false, error: 'Port must be an integer between 1 and 65535' };
  }
  if (!IDENT_REGEX.test(server)) {
    return { valid: false, error: 'Invalid Informix server name format' };
  }
  if (!IDENT_REGEX.test(database)) {
    return { valid: false, error: 'Invalid database name format' };
  }
  if (!user || user.length > 128 || hasControlChars(user)) {
    return { valid: false, error: 'Invalid database username' };
  }

  return {
    valid: true,
    clean: { host, port: portNum, server, database, user }
  };
}

function formatDuration(seconds) {
  if (isNaN(seconds) || seconds === null || seconds === undefined || seconds < 0) {
    return '00:00:00';
  }
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(secs).padStart(2, '0')
  ].join(':');
}

/**
 * Normalizes duration string from UCCX (e.g. "0:01:20" or ms number 80843) to "00:01:20"
 */
function normalizeDuration(convStr, msVal) {
  if (convStr && typeof convStr === 'string' && convStr.includes(':')) {
    const parts = convStr.trim().split(':');
    if (parts.length === 3) {
      return [
        parts[0].padStart(2, '0'),
        parts[1].padStart(2, '0'),
        parts[2].padStart(2, '0')
      ].join(':');
    }
  }
  if (msVal !== undefined && msVal !== null && !isNaN(msVal)) {
    return formatDuration(Math.floor(msVal / 1000));
  }
  return '00:00:00';
}

function isVirtualAllCsq(name) {
  const s = String(name || '').trim();
  return !s || s === 'ALL' || s.includes('TÜMÜ') || s.includes('OverAll');
}

function loadPersistedCSQs() {
  try {
    if (fs.existsSync(CSQ_FILE)) {
      const data = fs.readFileSync(CSQ_FILE, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return parsed.map(s => String(s).trim()).filter(s => !isVirtualAllCsq(s));
      }
    }
  } catch (e) {
    console.error('Error loading csqs.json:', e);
  }
  return ['SALES', 'SERVICE'];
}

function savePersistedCSQs(list) {
  try {
    fs.writeFileSync(CSQ_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving csqs.json:', e);
  }
}

function execJavaBridge(connParams, password) {
  return new Promise((resolve) => {
    const validation = validateConnParams(connParams);
    if (!validation.valid) {
      resolve({ success: false, error: validation.error });
      return;
    }

    const passStr = String(password || '');
    if (!passStr) {
      resolve({ success: false, error: 'Missing database password' });
      return;
    }

    const { host, port, server, database, user } = validation.clean;
    const classPath = `.${path.delimiter}${path.join(APP_DIR, 'ifxjdbc.jar')}`;
    const childEnv = Object.assign({}, process.env, {
      UCCX_DB_HOST: host,
      UCCX_DB_PORT: String(port),
      UCCX_DB_SERVER: server,
      UCCX_DB_NAME: database,
      UCCX_DB_USER: user,
      UCCX_DB_PASS: passStr
    });

    execFile(
      JAVA_PATH,
      ['-cp', classPath, 'UccxBridge'],
      { cwd: APP_DIR, timeout: 6000, windowsHide: true, env: childEnv },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            error: error.message || stderr || 'Java bridge execution error'
          });
          return;
        }

        try {
          const trimmed = stdout.trim();
          const jsonStart = trimmed.indexOf('{');
          if (jsonStart !== -1) {
            const parsed = JSON.parse(trimmed.substring(jsonStart));
            resolve(parsed);
          } else {
            resolve({ success: false, error: 'Invalid output from UccxBridge: ' + trimmed });
          }
        } catch (e) {
          resolve({ success: false, error: 'JSON parse error: ' + e.message });
        }
      }
    );
  });
}

class UCCXDatabase {
  constructor() {
    this.isConnected = false;
    this.connectionMode = 'live';
    this.lastError = null;
    this.lastChecked = null;
    this.rawResponse = null;
    this.inFlightPromise = null;
    this.lastSnapshotAt = 0;
  }

  validateConnParams(params) {
    return validateConnParams(params);
  }

  async queryInformix() {
    if (String(config.mockMode).toLowerCase() === 'true') {
      return { success: false, error: 'Mock mode enabled' };
    }
    if (!config.uccx.host) {
      return { success: false, error: 'UCCX_HOST not configured' };
    }
    return execJavaBridge(config.uccx, config.uccx.password);
  }

  async queryInformixCached(force = false) {
    if (String(config.mockMode).toLowerCase() === 'true' || !config.uccx.host) {
      const errorMsg = !config.uccx.host ? 'UCCX_HOST not configured' : 'Mock mode enabled';
      this.isConnected = false;
      this.connectionMode = 'mock';
      this.lastError = errorMsg;
      const res = { success: false, error: errorMsg };
      this.rawResponse = res;
      return res;
    }

    const now = Date.now();
    if (!force && this.rawResponse && (now - this.lastSnapshotAt < SNAPSHOT_CACHE_TTL_MS)) {
      return this.rawResponse;
    }

    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    this.inFlightPromise = (async () => {
      try {
        const result = await this.queryInformix();
        this.rawResponse = result;
        this.lastSnapshotAt = Date.now();
        this.lastChecked = new Date();
        if (result && result.success) {
          this.isConnected = true;
          this.connectionMode = 'live';
          this.lastError = null;
        } else {
          this.isConnected = false;
          this.connectionMode = 'mock';
          this.lastError = result ? result.error : 'Informix connection error';
        }
        return result;
      } finally {
        this.inFlightPromise = null;
      }
    })();

    return this.inFlightPromise;
  }

  async init() {
    this.lastChecked = new Date();
    const result = await this.queryInformixCached(true);

    if (result && result.success) {
      console.log(`[UCCX DB] ✓ Informix portuna başarıyla bağlanıldı: ${config.uccx.host}:${config.uccx.port} (${config.uccx.server})`);
      if (result.csqRows && result.csqRows.length > 0) {
        console.log(`[UCCX DB] ✓ RtCSQsSummary tablosundan ${result.csqRows.length} CSQ okundu:`, result.csqRows.map(r => r.csqname).join(', '));
      }
    } else {
      console.warn(`[UCCX DB] Informix bağlantı hatası: ${this.lastError}`);
    }
  }

  async testConnection(host, port, server, db, user, pass) {
    const testParams = {
      host: host || config.uccx.host,
      port: port || config.uccx.port,
      server: server || config.uccx.server,
      database: db || config.uccx.database,
      user: user || config.uccx.user
    };
    const testPass = pass || config.uccx.password;

    const validation = validateConnParams(testParams);
    if (!validation.valid) {
      return { success: false, error: validation.error, message: `Hata: ${validation.error}` };
    }

    const parsed = await execJavaBridge(validation.clean, testPass);
    if (parsed && parsed.success) {
      const count = parsed.csqRows ? parsed.csqRows.length : 0;
      return {
        success: true,
        host: validation.clean.host,
        port: validation.clean.port,
        activeCsqCount: count,
        message: `✓ UCCX 12.5 Informix bağlantısı başarılı! (${validation.clean.host}:${validation.clean.port}) - Aktif CSQ Sayısı: ${count}`
      };
    }

    const errMsg = parsed ? parsed.error : 'Informix bağlantı hatası';
    return {
      success: false,
      error: errMsg,
      message: `Veritabanı hatası: ${errMsg}`
    };
  }

  async getCSQs() {
    const set = new Set();
    set.add('ALL');

    // Pull directly from live RtCSQsSummary
    if (this.rawResponse && this.rawResponse.csqRows && this.rawResponse.csqRows.length > 0) {
      for (const r of this.rawResponse.csqRows) {
        if (r.csqname && !isVirtualAllCsq(r.csqname)) {
          set.add(r.csqname.trim());
        }
      }
    }

    // Also include saved CSQs
    const saved = loadPersistedCSQs();
    saved.forEach(s => {
      if (!isVirtualAllCsq(s)) set.add(s.trim());
    });

    return Array.from(set).map((name, idx) => ({
      csqid: idx + 1,
      csqname: name
    }));
  }

  saveCSQs(newList) {
    const cleanList = Array.from(
      new Set(newList.slice(0, 100).map(s => String(s).trim().slice(0, 64)))
    ).filter(s => !isVirtualAllCsq(s));
    savePersistedCSQs(cleanList);
    return cleanList;
  }

  async getTeams() {
    return [
      { teamid: 1, teamname: 'Default' }
    ];
  }

  async getMetrics(rawCsqName = config.defaultCsq, rawTeamName = config.defaultTeam) {
    const csqName = typeof rawCsqName === 'string' && rawCsqName.trim()
      ? rawCsqName.trim().slice(0, 64)
      : config.defaultCsq;
    const teamName = typeof rawTeamName === 'string' && rawTeamName.trim()
      ? rawTeamName.trim().slice(0, 64)
      : config.defaultTeam;

    const queryResult = await this.queryInformixCached(false);

    if (queryResult && queryResult.success) {
      const rows = queryResult.csqRows || [];
      const icdRows = queryResult.icdRows || [];

      let selectedRow = null;
      let isOverAll = false;

      if (isVirtualAllCsq(csqName)) {
        isOverAll = true;
        // Use RtICDStatistics if available, or aggregate rows
        if (icdRows.length > 0) {
          selectedRow = icdRows[0];
        } else if (rows.length > 0) {
          selectedRow = rows.reduce((acc, r) => {
            acc.totalcalls = (acc.totalcalls || 0) + (r.totalcalls || 0);
            acc.callshandled = (acc.callshandled || 0) + (r.callshandled || 0);
            acc.callsabandoned = (acc.callsabandoned || 0) + (r.callsabandoned || 0);
            acc.callswaiting = (acc.callswaiting || 0) + (r.callswaiting || 0);
            acc.availableagents = (acc.availableagents || 0) + (r.availableagents || 0);
            acc.unavailableagents = (acc.unavailableagents || 0) + (r.unavailableagents || 0);
            acc.talkingagents = (acc.talkingagents || 0) + (r.talkingagents || 0);
            acc.longestwaitduration = Math.max(acc.longestwaitduration || 0, r.longestwaitduration || 0);
            acc.avgtalkduration = Math.max(acc.avgtalkduration || 0, r.avgtalkduration || 0);
            acc.avgwaitduration = Math.max(acc.avgwaitduration || 0, r.avgwaitduration || 0);
            return acc;
          }, {});
        }
      } else {
        selectedRow = rows.find(r => r.csqname && r.csqname.toUpperCase() === csqName.toUpperCase());
        if (!selectedRow && rows.length > 0) {
          selectedRow = rows[0]; // fallback to first live CSQ
        }
      }

      if (selectedRow) {
        // EXACT COLUMN NAMES FROM UCCX 12.5 RtCSQsSummary & RtICDStatistics
        const totalCalls = selectedRow.totalcalls !== undefined ? selectedRow.totalcalls : (selectedRow.callsoffered || 0);
        const handledCalls = selectedRow.callshandled || 0;
        const abandonedCalls = selectedRow.callsabandoned || 0;
        const waitingCalls = selectedRow.callswaiting || 0;

        // Agents
        const readyAgents = selectedRow.availableagents !== undefined ? selectedRow.availableagents : (selectedRow.resourcesready || 0);
        const notReadyAgents = selectedRow.unavailableagents !== undefined ? selectedRow.unavailableagents : (selectedRow.resourcesnotready || 0);
        const talkingAgents = selectedRow.talkingagents !== undefined ? selectedRow.talkingagents : (selectedRow.resourcestalking || 0);

        // Durations
        const longestWaitSec = Math.floor((selectedRow.longestwaitduration || 0) / 1000);
        const avgTalkSec = Math.floor((selectedRow.avgtalkduration || 0) / 1000);
        const avgWaitSec = Math.floor((selectedRow.avgwaitduration || 0) / 1000);

        const enUzunBeklemeStr = normalizeDuration(
          waitingCalls > 0 ? selectedRow.convoldestcontact : selectedRow.convlongestwaitduration,
          waitingCalls > 0 ? selectedRow.oldestcontact : selectedRow.longestwaitduration
        );
        const avgTalkStr = normalizeDuration(selectedRow.convavgtalkduration, selectedRow.avgtalkduration);
        const avgWaitStr = normalizeDuration(selectedRow.convavgwaitduration, selectedRow.avgwaitduration);
        const avgAbandonStr = avgWaitStr;

        // Ratios (AR & SL)
        const arRatio = totalCalls > 0 ? Math.round((handledCalls / totalCalls) * 100) : 100;

        let slRatio = 100;
        if (selectedRow.servicelevelpercentage !== undefined && selectedRow.servicelevelpercentage !== null) {
          slRatio = selectedRow.servicelevelpercentage;
        } else if (totalCalls > 0) {
          slRatio = Math.round((handledCalls / totalCalls) * 100);
        }

        const slHandled = handledCalls;
        const slAbandoned = Math.max(0, abandonedCalls);

        return {
          csq: isOverAll ? 'ALL' : (selectedRow.csqname || csqName),
          team: teamName,
          timestamp: new Date().toISOString(),
          mode: 'live',
          dataSource: 'UCCX 12.5 RtCSQsSummary (Canlı)',
          metrics: {
            toplamCagri: totalCalls,
            musaitOlmayanMT: notReadyAgents,
            musaitMT: readyAgents,
            gorusenMT: talkingAgents,
            cevaplananCagrilar: handledCalls,
            kacanCagrilar: abandonedCalls,
            bekleyenCagrilar: waitingCalls,
            slCevaplanan: slHandled,
            slKacan: slAbandoned,
            enUzunBekleme: enUzunBeklemeStr,
            enUzunBeklemeSeconds: longestWaitSec,
            ortalamaGorusme: avgTalkStr,
            ortalamaGorusmeSeconds: avgTalkSec,
            ortalamaKacan: avgAbandonStr,
            ortalamaKacanSeconds: avgWaitSec,
            ortalamaBekleme: avgWaitStr,
            ortalamaBeklemeSeconds: avgWaitSec,
            slOrani: `%${slRatio}`,
            slOraniVal: slRatio,
            arOrani: `%${arRatio}`,
            arOraniVal: arRatio
          }
        };
      }
    }

    // Fallback if no data or connection lost
    return {
      csq: csqName,
      team: teamName,
      timestamp: new Date().toISOString(),
      mode: this.connectionMode === 'mock' ? 'mock' : 'live',
      dataSource: 'UCCX 12.5 Bekleniyor',
      metrics: {
        toplamCagri: 0,
        musaitOlmayanMT: 0,
        musaitMT: 0,
        gorusenMT: 0,
        cevaplananCagrilar: 0,
        kacanCagrilar: 0,
        bekleyenCagrilar: 0,
        slCevaplanan: 0,
        slKacan: 0,
        enUzunBekleme: '00:00:00',
        enUzunBeklemeSeconds: 0,
        ortalamaGorusme: '00:00:00',
        ortalamaGorusmeSeconds: 0,
        ortalamaKacan: '00:00:00',
        ortalamaKacanSeconds: 0,
        ortalamaBekleme: '00:00:00',
        ortalamaBeklemeSeconds: 0,
        slOrani: '%100',
        slOraniVal: 100,
        arOrani: '%100',
        arOraniVal: 100
      }
    };
  }

  getSqlTemplate() {
    return {
      csqSummary: `
        SELECT csqname, loggedinagents, availableagents, unavailableagents,
               talkingagents, workingagents, reservedagents,
               totalcalls, callshandled, callsabandoned, callswaiting,
               convlongestwaitduration, convavgtalkduration, convavgwaitduration,
               convoldestcontact
        FROM RtCSQsSummary
      `,
      icdStatistics: `SELECT * FROM RtICDStatistics`
    };
  }
}

module.exports = new UCCXDatabase();

/**
 * Workspace server configuration. Values come from the environment, or from a
 * local `.env.local` file (git-ignored). Secrets are never logged or sent to
 * the browser.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Minimal KEY=VALUE parser. Existing environment variables win. */
function loadEnvFile(file, env) {
  if (!fs.existsSync(file)) return false;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) return;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (env[m[1]] === undefined || env[m[1]] === '') env[m[1]] = value;
  });
  return true;
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** WORKSPACE_USERS="asha@gaadiinfo.com:pass1,ravi@gaadiinfo.com:pass2" → named logins. */
function parseUsers(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean).map(entry => {
    const i = entry.indexOf(':');
    return i > 0 ? { email: entry.slice(0, i).trim().toLowerCase(), password: entry.slice(i + 1) } : null;
  }).filter(u => u && u.email && u.password);
}

function readConfig(env) {
  const e = env || process.env;
  return {
    root: ROOT,
    host: e.HOST || '127.0.0.1',
    port: int(e.PORT, 8000),
    password: e.WORKSPACE_PASSWORD || '',
    users: parseUsers(e.WORKSPACE_USERS),
    cacheDir: path.resolve(ROOT, e.CACHE_DIR || '.cache'),
    snapshotFile: e.SNAPSHOT_FILE ? path.resolve(e.SNAPSHOT_FILE) : path.join(ROOT, 'data', 'tickets.json'),
    snapshotTtlMs: int(e.SNAPSHOT_TTL_SECONDS, 120) * 1000,
    conversationTtlMs: int(e.CONVERSATION_TTL_SECONDS, 300) * 1000,
    closedLookbackDays: int(e.CLOSED_LOOKBACK_DAYS, 30),
    pollSeconds: Math.max(10, int(e.ZOHO_POLL_SECONDS, 30)),
    fullRefreshMinutes: Math.max(5, int(e.ZOHO_FULL_REFRESH_MINUTES, 60)),
    webhookSecret: e.ZOHO_WEBHOOK_SECRET || '',
    ticketMetrics: e.ZOHO_TICKET_METRICS !== 'off',
    write: {
      // Agent actions written back to Zoho (assign, status, notes). Off until switched on.
      enabled: e.ZOHO_WRITE === 'on',
      statusOpen: e.ZOHO_STATUS_OPEN || 'Open',
      statusWaiting: e.ZOHO_STATUS_WAITING || 'On Hold',
      statusClosed: e.ZOHO_STATUS_CLOSED || 'Closed',
      supervisorEmail: (e.SUPERVISOR_EMAIL || '').toLowerCase()
    },
    zoho: {
      orgId: e.ZOHO_ORG_ID || '',
      domain: e.ZOHO_DOMAIN || 'desk.zoho.in',
      accountsDomain: e.ZOHO_ACCOUNTS_DOMAIN || 'accounts.zoho.in',
      clientId: e.ZOHO_CLIENT_ID || '',
      clientSecret: e.ZOHO_CLIENT_SECRET || '',
      refreshToken: e.ZOHO_REFRESH_TOKEN || '',
      accessToken: e.ZOHO_API_TOKEN || ''
    },
    ai: {
      enabled: e.AI_SUMMARIES !== 'off' && !!(e.ANTHROPIC_API_KEY || e.ANTHROPIC_AUTH_TOKEN),
      replies: e.AI_REPLIES !== 'off' && !!(e.ANTHROPIC_API_KEY || e.ANTHROPIC_AUTH_TOKEN),
      model: e.AI_MODEL || 'claude-opus-5-5',
      playbookFile: e.REPLY_PLAYBOOK_FILE ? path.resolve(e.REPLY_PLAYBOOK_FILE) : path.join(ROOT, 'server', 'reply-playbook.md')
    },
    status: {
      url: e.GAADIINFO_STATUS_URL || '',
      token: e.GAADIINFO_STATUS_TOKEN || ''
    }
  };
}

function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

module.exports = { ROOT, loadEnvFile, readConfig, isLoopback, parseUsers };

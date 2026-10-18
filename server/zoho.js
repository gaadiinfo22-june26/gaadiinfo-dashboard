/**
 * Zoho Desk API client for the workspace server. Reads are used everywhere;
 * writes (send) only by server/actions.js when ZOHO_WRITE=on.
 *
 * Authentication: a Self Client refresh token (ZOHO_CLIENT_ID,
 * ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN) is exchanged for short-lived access
 * tokens automatically, so nobody has to paste a new token every hour.
 * A plain ZOHO_API_TOKEN still works but stops working when it expires.
 */

class ZohoError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || null;
  }
}

const TIMEOUT_MS = 20000;

function createZohoClient(cfg, deps) {
  const fetchImpl = (deps && deps.fetch) || fetch;
  const timeoutMs = (deps && deps.timeoutMs) || TIMEOUT_MS;
  const base = `https://${cfg.domain}/api/v1`;
  const canRefresh = !!(cfg.clientId && cfg.clientSecret && cfg.refreshToken);
  const configured = !!(cfg.orgId && (canRefresh || cfg.accessToken));
  let token = canRefresh ? null : cfg.accessToken || null;
  let expiresAt = canRefresh ? 0 : Infinity;
  let refreshing = null;

  async function refresh() {
    const body = new URLSearchParams({
      refresh_token: cfg.refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token'
    });
    const res = await fetchImpl(`https://${cfg.accountsDomain}/oauth/v2/token`, { method: 'POST', body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      throw new ZohoError('auth_failed', `Zoho refused the refresh token (${json.error || res.status}). Generate a new one - see docs/workspace-server.md.`, res.status);
    }
    token = json.access_token;
    expiresAt = Date.now() + Math.max(60, (Number(json.expires_in) || 3600) - 120) * 1000;
    return token;
  }

  async function accessToken(force) {
    if (!configured) throw new ZohoError('not_configured', 'Zoho Desk is not connected on the server.');
    if (!force && token && Date.now() < expiresAt) return token;
    if (!canRefresh) return token;
    if (!refreshing) refreshing = refresh().finally(() => { refreshing = null; });
    return refreshing;
  }

  /** GET a Zoho Desk API path (or full URL). 204 is returned as an empty list. */
  async function get(pathOrUrl, params) {
    const url = new URL(/^https?:/.test(pathOrUrl) ? pathOrUrl : base + pathOrUrl);
    Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, String(v)); });
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await accessToken(attempt > 0);
      let res;
      try {
        res = await fetchImpl(url.href, { headers: { Authorization: `Zoho-oauthtoken ${t}`, orgId: cfg.orgId }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        throw new ZohoError('zoho_unreachable', `Could not reach Zoho Desk (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`);
      }
      if (res.status === 401 && attempt === 0 && canRefresh) continue;
      if (res.status === 204) return { data: [] };
      const text = await res.text();
      if (!res.ok) {
        const code = res.status === 401 ? 'auth_failed' : res.status === 429 ? 'rate_limited' : 'zoho_error';
        throw new ZohoError(code, `Zoho Desk returned HTTP ${res.status}: ${text.slice(0, 160)}`, res.status);
      }
      try { return JSON.parse(text); } catch (e) { throw new ZohoError('zoho_error', 'Zoho Desk returned invalid JSON.'); }
    }
    throw new ZohoError('auth_failed', 'Zoho Desk rejected the access token.', 401);
  }

  /**
   * Write to Zoho (PATCH / POST). Never retried automatically: if the request
   * times out or the connection drops, Zoho may or may not have applied it, so
   * the error has code 'uncertain' and the caller must check before trying again.
   */
  async function send(method, path, body, params) {
    const url = new URL(base + path);
    Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, String(v)); });
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await accessToken(attempt > 0);
      let res;
      try {
        res = await fetchImpl(url.href, {
          method, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Zoho-oauthtoken ${t}`, orgId: cfg.orgId, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        throw new ZohoError('uncertain', `No answer from Zoho Desk (${e.name === 'TimeoutError' ? 'timed out' : e.message}); the change may or may not have been saved.`);
      }
      // A 401 is rejected before Zoho does anything, so one retry with a fresh token is safe.
      if (res.status === 401 && attempt === 0 && canRefresh) continue;
      const text = await res.text();
      if (!res.ok) {
        const code = res.status === 401 || res.status === 403 ? 'auth_failed' : res.status === 429 ? 'rate_limited' : res.status === 422 || res.status === 400 ? 'zoho_rejected' : 'zoho_error';
        throw new ZohoError(code, `Zoho Desk returned HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
      }
      if (!text) return {};
      try { return JSON.parse(text); } catch (e) { return {}; }
    }
    throw new ZohoError('auth_failed', 'Zoho Desk rejected the access token.', 401);
  }

  // `base` + `request(url)` match the client shape scripts/fetch-tickets.js expects.
  return { configured, base, get, send, request: url => get(url) };
}

/** Run async jobs with a concurrency limit, keeping result order. */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

module.exports = { createZohoClient, ZohoError, mapLimit };

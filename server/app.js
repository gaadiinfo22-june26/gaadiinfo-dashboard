/**
 * HTTP handler for the escalation workspace server.
 *
 *   GET  /                                   the dashboard (index.html)
 *   GET  /src/*.js, /data/tickets.json       its scripts and the synced snapshot
 *   GET  /api/health                         which integrations are connected (no secrets)
 *   GET  /api/snapshot                       live ticket list from Zoho
 *   GET  /api/tickets/:id/conversation       full conversation (WhatsApp sessions, emails, notes)
 *   GET  /api/tickets/:id/summary            cached AI summary, if any
 *   POST /api/tickets/:id/summary            generate an AI summary (needs an Anthropic key)
 *   GET  /api/tickets/:id/reply              latest suggested reply, if any (marked stale if the chat moved on)
 *   POST /api/tickets/:id/reply              draft a reply in Hinglish, Hindi and English (needs an Anthropic key)
 *   GET  /api/me                             who is working, and which actions are allowed
 *   POST /api/tickets/:id/actions            assign / waiting / resolve / reopen / escalate / note, written to Zoho (ZOHO_WRITE=on)
 *   GET  /api/challan-status?vehicle=&order= live status from GaadiInfo's status service
 *   GET  /api/events                         server-sent events: pushed when tickets change
 *   POST /api/zoho/webhook?token=…           optional Zoho Desk webhook (instant updates)
 *
 * Nothing here messages customers. Ticket changes happen only through
 * /actions, only when ZOHO_WRITE=on, and only when an agent asks.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
};

function send(res, status, body, type) {
  const headers = Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SECURITY_HEADERS);
  res.writeHead(status, headers);
  res.end(type ? body : JSON.stringify(body));
}

function errorStatus(err) {
  return {
    not_configured: 409, bad_request: 400, auth_failed: 502, rate_limited: 503, zoho_error: 502, zoho_unreachable: 503, refused: 422, incomplete: 502, bad_output: 502,
    forbidden: 403, conflict: 409, needs_confirmation: 409, not_applied: 502, partial: 502, uncertain: 504, zoho_rejected: 422, ai_error: 502
  }[err.code] || 500;
}

/** Small JSON request bodies only (agent instructions, not files). */
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request body too large.'), { code: 'bad_request' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) || {}); } catch (e) { reject(Object.assign(new Error('Request body is not valid JSON.'), { code: 'bad_request' })); }
    });
    req.on('error', reject);
  });
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createApp(deps) {
  const { config, zoho, snapshots, conversations, summarizer, status, log } = deps;
  const replies = deps.replies || { enabled: false };
  const actions = deps.actions || { enabled: false, options: () => ({}) };
  const users = config.users || [];
  const say = log || (() => {});
  const indexFile = path.join(config.root, 'index.html');

  /**
   * With WORKSPACE_USERS, every agent logs in with their own email and password
   * and their actions are recorded under that name. Otherwise one shared
   * WORKSPACE_PASSWORD (or none, on this computer only) and agents pick who
   * they are in the page ("self-selected" in notes and the audit log).
   */
  function authenticate(req) {
    const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
    const decoded = m ? Buffer.from(m[1], 'base64').toString('utf8') : '';
    const i = decoded.indexOf(':');
    const user = i >= 0 ? decoded.slice(0, i).trim().toLowerCase() : '';
    const pass = i >= 0 ? decoded.slice(i + 1) : '';
    if (users.length) {
      const u = users.find(x => x.email === user);
      return u && sameSecret(pass, u.password) ? { ok: true, login: u.email } : { ok: false };
    }
    if (!config.password) return { ok: true, login: null };
    return { ok: !!m && sameSecret(pass, config.password), login: null };
  }

  /** The Zoho agent behind this request, or null. */
  async function actorFor(req, auth) {
    const agents = snapshots.agents ? await snapshots.agents().catch(() => ({})) : {};
    if (auth.login) {
      const a = Object.values(agents).find(x => x.email && x.email.toLowerCase() === auth.login);
      return a ? { agentId: String(a.id), name: a.name, email: auth.login, declared: false } : null;
    }
    const picked = String(req.headers['x-workspace-agent'] || '');
    return picked && agents[picked] ? { agentId: picked, name: agents[picked].name, email: agents[picked].email || null, declared: true } : null;
  }

  function serveFile(res, file, type) {
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, { error: 'not_found' });
      send(res, 200, buf, type);
    });
  }

  // Server-sent events: one long-lived response per open browser tab.
  function events(req, res) {
    res.writeHead(200, Object.assign({
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
    }, SECURITY_HEADERS));
    const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.write('retry: 5000\n\n');
    write('hello', snapshots.status());
    const onChange = d => write('changed', d);
    snapshots.on('changed', onChange);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); snapshots.off('changed', onChange); });
  }

  // Zoho Desk webhook. Zoho can't send the workspace password, so this one route
  // is protected by its own secret token instead, and only triggers a re-read.
  function webhook(req, res, url) {
    if (!config.webhookSecret) return send(res, 404, { error: 'not_found' });
    if (req.method === 'GET' || req.method === 'HEAD') return send(res, 200, { ok: true });
    const token = url.searchParams.get('token') || req.headers['x-webhook-token'] || '';
    if (req.method !== 'POST' || !sameSecret(token, config.webhookSecret)) return send(res, 403, { error: 'forbidden' });
    let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > 1e6) req.destroy(); });
    req.on('end', () => { snapshots.trigger(); send(res, 200, { ok: true }); });
    return undefined;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);

    if (p === '/api/zoho/webhook') return webhook(req, res, url);

    const auth = authenticate(req);
    if (!auth.ok) {
      res.writeHead(401, Object.assign({ 'WWW-Authenticate': 'Basic realm="GaadiInfo escalations"' }, SECURITY_HEADERS));
      return res.end('Authentication required');
    }

    // ── Static files (allowlist only) ──
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, indexFile, 'text/html; charset=utf-8');
    if (req.method === 'GET' && /^\/src\/[a-z-]+\.js$/.test(p)) return serveFile(res, path.join(config.root, p), 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && p === '/data/tickets.json') return serveFile(res, config.snapshotFile, 'application/json; charset=utf-8');
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (!p.startsWith('/api/')) return send(res, 404, { error: 'not_found' });

    try {
      if (req.method === 'GET' && p === '/api/health') {
        return send(res, 200, {
          ok: true,
          zoho: zoho.configured,
          ai: summarizer.enabled,
          aiReplies: replies.enabled,
          aiModel: summarizer.enabled || replies.enabled ? (summarizer.enabled ? summarizer.model : replies.model) : null,
          challanStatus: status.configured,
          passwordProtected: !!config.password || users.length > 0,
          write: actions.enabled,
          logins: users.length > 0,
          live: Object.assign(snapshots.status ? snapshots.status() : {}, { webhook: !!config.webhookSecret })
        });
      }

      if (req.method === 'GET' && p === '/api/events') return events(req, res);

      if (req.method === 'GET' && p === '/api/me') {
        const agents = snapshots.agents ? await snapshots.agents().catch(() => ({})) : {};
        const actor = await actorFor(req, auth);
        return send(res, 200, {
          login: auth.login, actor, write: actions.enabled,
          loginWithoutAgent: !!auth.login && !actor,
          supervisorEmail: (config.write && config.write.supervisorEmail) || null,
          statuses: config.write ? { open: config.write.statusOpen, waiting: config.write.statusWaiting, closed: config.write.statusClosed } : null,
          agents: Object.values(agents).map(a => ({ id: String(a.id), name: a.name, email: a.email || null })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
          options: actions.options()
        });
      }

      if (req.method === 'GET' && p === '/api/snapshot') {
        if (!zoho.configured) return send(res, 409, { error: 'not_configured', message: 'Zoho Desk is not connected on the server; use the synced file.' });
        const snap = await snapshots.get(url.searchParams.get('refresh') === '1');
        return send(res, 200, snap);
      }

      if (req.method === 'GET' && p === '/api/challan-status') {
        const result = await status.lookup(Object.fromEntries(url.searchParams));
        return send(res, 200, result);
      }

      const m = /^\/api\/tickets\/(\d{5,25})\/(conversation|summary|reply|actions)$/.exec(p);
      if (!m) return send(res, /^\/api\/tickets\//.test(p) ? 400 : 404, { error: 'not_found' });
      // POSTs spend AI credits: require a JSON request, which other websites can't send without CORS approval.
      if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        return send(res, 415, { error: 'unsupported_media_type', message: 'Send Content-Type: application/json.' });
      }
      const ticketId = m[1];
      if (m[2] === 'actions') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
        const body = await readJson(req, 16384);
        const actor = await actorFor(req, auth);
        const result = await actions.perform(ticketId, String(body.type || ''), body, actor);
        if (log) log(`Action ${body.type} on ticket ${ticketId} by ${actor ? actor.name : 'unknown'}: saved in Zoho`);
        return send(res, 200, result);
      }
      const ctx = await snapshots.lookup(ticketId);
      const ticketCtx = ctx.ticket ? { channel: require('../src/taxonomy').channelFor(ctx.ticket.channel, ctx.ticket.channelCode) } : null;

      if (m[2] === 'conversation' && req.method === 'GET') {
        const conv = await conversations.get(ticketId, {
          refresh: url.searchParams.get('refresh') === '1',
          modifiedAt: (ctx.ticket && (ctx.ticket.modifiedTime || ctx.ticket.customerResponseTime)) || url.searchParams.get('modified') || null,
          threadCount: ctx.ticket && ctx.ticket.threadCount !== undefined ? Number(ctx.ticket.threadCount) : null,
          ticket: ticketCtx, agents: ctx.agents
        });
        return send(res, 200, conv);
      }

      if (m[2] === 'summary') {
        if (!summarizer.enabled) return send(res, 409, { error: 'not_configured', message: 'AI summaries need an Anthropic API key on the server (ANTHROPIC_API_KEY).' });
        const conv = await conversations.get(ticketId, { ticket: ticketCtx, agents: ctx.agents });
        if (!conv.messages.length) return send(res, 422, { error: 'empty', message: 'There are no messages to summarise.' });
        if (req.method === 'GET') {
          const c = summarizer.cached(ticketId, conv.messages);
          return c ? send(res, 200, c) : send(res, 404, { error: 'not_found' });
        }
        if (req.method === 'POST') {
          const existing = url.searchParams.get('refresh') === '1' ? null : summarizer.cached(ticketId, conv.messages);
          return send(res, 200, existing || await summarizer.generate(ticketId, conv.messages, ctx.ticket));
        }
      }

      if (m[2] === 'reply') {
        if (!replies.enabled) return send(res, 409, { error: 'not_configured', message: 'Suggested replies need an Anthropic API key on the server (ANTHROPIC_API_KEY).' });
        if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
        const conv = await conversations.get(ticketId, { ticket: ticketCtx, agents: ctx.agents });
        if (!conv.messages.length) return send(res, 422, { error: 'empty', message: 'There are no messages to reply to.' });
        if (req.method === 'GET') {
          const c = replies.cached(ticketId, conv.messages);
          return c ? send(res, 200, c) : send(res, 404, { error: 'not_found' });
        }
        const body = await readJson(req, 8192);
        const cat = require('../src/taxonomy').CATEGORIES.find(c => c.id === body.queryType);
        // Use the live status service when it is connected and the chat has a vehicle or order number.
        let statusResult = null;
        if (status.configured) {
          const facts = require('../src/conversation').conversationFacts(conv, { now: new Date() });
          const query = {};
          if (facts.entities.vehicles[0]) query.vehicle = facts.entities.vehicles[0];
          if (facts.entities.orders[0]) query.order = facts.entities.orders[0];
          if (Object.keys(query).length) {
            const r = await status.lookup(query).catch(() => null);
            if (r && r.available) statusResult = { query: r.query, data: r.data };
          }
        }
        return send(res, 200, await replies.generate(ticketId, {
          ticket: ctx.ticket, conversation: conv, statusResult,
          queryType: cat ? { id: cat.id, label: cat.label, confirmed: body.queryTypeConfirmed === true } : null,
          instruction: typeof body.instruction === 'string' ? body.instruction : '',
          refresh: body.refresh === true
        }));
      }
      return send(res, 405, { error: 'method_not_allowed' });
    } catch (err) {
      const code = errorStatus(err);
      if (code >= 500) say(`Error on ${req.method} ${p}: ${err.message}`);
      return send(res, code, Object.assign({ error: err.code || 'server_error', message: code >= 500 && !err.code ? 'Something went wrong on the server.' : err.message }, err.current ? { current: err.current } : {}));
    }
  }

  return handle;
}

module.exports = { createApp };

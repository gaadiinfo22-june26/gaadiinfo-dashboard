/**
 * Live ticket list for the workspace.
 *
 *   full load   every ticket via the list API (same paging as the GitHub sync),
 *               at start and every ZOHO_FULL_REFRESH_MINUTES (catches deletes / merges)
 *   poll        every ZOHO_POLL_SECONDS: GET /tickets/search?modifiedTimeRange=<last poll>,<now>
 *               - one call returns only what changed, with the customer's contact
 *               details and who spoke last (lastThread.direction)
 *   webhook     optional: Zoho calls /api/zoho/webhook on each change and the
 *               server polls immediately instead of waiting
 *
 * Every change bumps `version` and emits 'changed' so connected browsers update
 * within seconds. Failures are recorded in `sync.lastError`, never swallowed.
 */
const fs = require('fs');
const { EventEmitter } = require('events');
const { fetchAllTickets, splitTickets, buildSnapshot } = require('../scripts/fetch-tickets');
const { mapLimit } = require('./zoho');

const CONTACT_TTL_MS = 7 * 86400000;
const POLL_OVERLAP_MS = 2 * 60000;   // re-read a small window so nothing slips between polls
const SEARCH_PAGE = 100;
const SEARCH_MAX_FROM = 900;          // Zoho search allows from <= 999

// Fields kept from search results (they carry many extras we don't need).
const KEEP = ['id', 'ticketNumber', 'subject', 'status', 'statusType', 'createdTime', 'modifiedTime', 'closedTime', 'priority',
  'channel', 'channelCode', 'threadCount', 'contactId', 'assigneeId', 'customerResponseTime', 'webUrl', 'dueDate',
  'responseDueDate', 'onholdTime', 'departmentId', 'isSpam', 'category', 'subCategory', 'lastThread', 'email', 'phone', 'cf'];

function slim(t) {
  const out = {};
  KEEP.forEach(k => { if (t[k] !== undefined) out[k] = t[k]; });
  return out;
}

function zohoTime(d) {
  return new Date(d).toISOString(); // yyyy-MM-ddTHH:mm:ss.SSSZ
}

function createSnapshotService({ zoho, cache, lookbackDays, snapshotFile, pollMs, fullRefreshMs, log, metrics, followUpFor }) {
  const events = new EventEmitter();
  events.setMaxListeners(200);
  const say = log || (() => {});
  let live = null;            // { byId, version, builtAt, lastPollAt, pages, scanned, duplicatesRemoved }
  let published = null;       // { version, data }
  let building = null;
  let polling = null;
  let filling = null;
  let lastError = null;
  let lastErrorAt = null;
  let agents = { at: 0, data: {}, error: null };
  const contactFailures = new Map();
  const timers = [];

  function changed(ticketIds, why) {
    live.version++;
    published = null;
    events.emit('changed', { version: live.version, ticketIds, reason: why, at: new Date().toISOString() });
  }

  // A failure must reach the browsers: drop the cached snapshot and announce it.
  function fail(err) {
    lastError = err.message.slice(0, 200);
    lastErrorAt = new Date().toISOString();
    say(`Zoho sync problem: ${lastError}`);
    if (live) changed([], 'error');
  }

  function recovered() {
    if (!lastError) return false;
    lastError = null;
    return true;
  }

  function rememberContact(id, data) {
    if (id && data) cache.write('contacts', id, { at: Date.now(), data: Object.assign({ id }, data) });
  }

  function contactsFor(ids) {
    const out = {};
    ids.forEach(id => {
      const c = id && cache.read('contacts', id);
      if (c) out[id] = c.data;
    });
    return out;
  }

  function fillContacts(ids) {
    if (filling) return;
    const missing = Array.from(new Set(ids.filter(Boolean))).filter(id => {
      const c = cache.read('contacts', id);
      return !c || Date.now() - c.at > CONTACT_TTL_MS;
    });
    if (!missing.length) return;
    say(`Fetching ${missing.length} customer contact(s) from Zoho in the background…`);
    filling = mapLimit(missing, 3, async id => {
      try {
        rememberContact(id, await zoho.get(`/contacts/${id}`, { fields: 'id,firstName,lastName,email,phone,mobile' }));
        contactFailures.delete(id);
      } catch (e) {
        contactFailures.set(id, e.message.slice(0, 120));
      }
    }).then(() => { if (live) changed([], 'contacts'); }).finally(() => { filling = null; });
  }

  async function loadAgents() {
    if (Date.now() - agents.at < 3600000) return agents;
    try {
      const data = await zoho.get('/agents', { limit: 100 });
      const map = {};
      (data.data || []).forEach(a => { map[a.id] = { id: a.id, name: a.name || `${a.firstName || ''} ${a.lastName || ''}`.trim(), email: a.emailId }; });
      agents = { at: Date.now(), data: map, error: null };
    } catch (e) {
      agents = { at: Date.now(), data: agents.data, error: e.message.slice(0, 120) };
    }
    return agents;
  }

  async function fullLoad() {
    const startedAt = new Date();
    const { tickets, pages, scanned, duplicatesRemoved } = await fetchAllTickets(zoho, { fields: null });
    await loadAgents();
    const byId = new Map(tickets.map(t => [String(t.id), slim(t)]));
    if (live) {
      // Keep the fresher modifiedTime / lastThread we may already have from polls.
      byId.forEach((t, id) => { const prev = live.byId.get(id); if (prev && prev.modifiedTime && !t.modifiedTime) t.modifiedTime = prev.modifiedTime; });
    }
    const version = live ? live.version : 0;
    live = { byId, version, builtAt: startedAt, lastPollAt: startedAt, pages, scanned, duplicatesRemoved };
    lastError = null;
    changed([], 'full');
    fillContacts(tickets.map(t => t.contactId));
    if (metrics) metrics.refresh(Array.from(byId.values()));
  }

  /** Read tickets changed since the last poll and merge them in. */
  async function poll() {
    if (!live) return build();
    if (polling) return polling;
    polling = (async () => {
      const until = new Date();
      const since = new Date(live.lastPollAt.getTime() - POLL_OVERLAP_MS);
      const changedIds = [];
      for (let from = 0; from <= SEARCH_MAX_FROM; from += SEARCH_PAGE) {
        const res = await zoho.get('/tickets/search', {
          modifiedTimeRange: `${zohoTime(since)},${zohoTime(until)}`, sortBy: '-modifiedTime', from, limit: SEARCH_PAGE
        });
        const data = res.data || [];
        data.forEach(t => {
          const id = String(t.id);
          if (t.contact && t.contactId) rememberContact(t.contactId, t.contact);
          const prev = live.byId.get(id);
          if (!prev || prev.modifiedTime !== t.modifiedTime || prev.threadCount !== t.threadCount || prev.statusType !== t.statusType) changedIds.push(id);
          live.byId.set(id, Object.assign({}, prev || {}, slim(t)));
        });
        if (data.length < SEARCH_PAGE) break;
      }
      live.lastPollAt = until;
      const wasFailing = recovered();
      if (changedIds.length || wasFailing) changed(changedIds, 'poll');
      if (metrics && changedIds.length) metrics.refresh(changedIds.map(id => live.byId.get(id)));
    })().catch(err => fail(err.status === 401 || err.status === 403 || /scope/i.test(err.message)
      ? new Error(`Live updates need the Desk.search.READ scope on the Zoho token (docs/workspace-server.md). ${err.message}`)
      : err)).finally(() => { polling = null; });
    return polling;
  }

  function build() {
    if (!building) building = fullLoad().catch(err => { fail(err); throw err; }).finally(() => { building = null; });
    return building;
  }

  function publish() {
    if (published && published.version === live.version) return published.data;
    const decorate = t => {
      const m = metrics && metrics.get(t.id);
      const f = followUpFor && followUpFor(t.id);
      return m || f ? Object.assign({}, t, m ? { metrics: m } : {}, f ? { followUp: f } : {}) : t;
    };
    const all = Array.from(live.byId.values()).map(decorate);
    const { open, closed, closedCreatedSince } = splitTickets(all, { lookbackDays, now: new Date() });
    const ids = open.concat(closed).map(t => t.contactId);
    const data = buildSnapshot({
      startedAt: live.builtAt, finishedAt: live.lastPollAt, open, closed, closedCreatedSince, lookbackDays,
      contacts: contactsFor(ids), agents: agents.data,
      contactFailures: Array.from(contactFailures.entries()).map(([contactId, error]) => ({ contactId, error })),
      agentsError: agents.error, pages: live.pages, scanned: live.scanned, duplicatesRemoved: live.duplicatesRemoved
    });
    Object.assign(data.sync, {
      source: 'workspace-server', mode: 'live', version: live.version, pollSeconds: Math.round(pollMs / 1000),
      lastPollAt: live.lastPollAt.toISOString(), lastError, lastErrorAt
    });
    published = { version: live.version, data };
    return data;
  }

  /** Current snapshot: live from Zoho when connected, else the synced file. */
  async function get(force) {
    if (!zoho.configured) {
      if (!fs.existsSync(snapshotFile)) return null;
      return JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    }
    if (!live) await build();
    else if (force) await poll();
    return publish();
  }

  /** Raw ticket + agents for conversation context. */
  async function lookup(ticketId) {
    if (zoho.configured && live) return { ticket: live.byId.get(String(ticketId)) || null, agents: agents.data };
    const snap = await get(false).catch(() => null);
    if (!snap) return { ticket: null, agents: {} };
    const all = (snap.tickets || []).concat(snap.closedTickets || []);
    return { ticket: all.find(t => String(t.id) === String(ticketId)) || null, agents: snap.agents || {} };
  }

  let triggerTimer = null;
  /** Poll soon (debounced) - used by the Zoho webhook. */
  function trigger() {
    clearTimeout(triggerTimer);
    triggerTimer = setTimeout(() => { poll(); }, 1500);
  }

  function start() {
    if (!zoho.configured) return;
    build().catch(() => {});
    timers.push(setInterval(() => { poll(); }, pollMs));
    timers.push(setInterval(() => { build().catch(() => {}); }, fullRefreshMs));
  }

  function stop() { timers.forEach(clearInterval); clearTimeout(triggerTimer); }

  function status() {
    return {
      mode: zoho.configured ? 'live' : 'file',
      version: live ? live.version : 0,
      lastPollAt: live ? live.lastPollAt.toISOString() : null,
      pollSeconds: Math.round(pollMs / 1000),
      lastError, lastErrorAt,
      metrics: metrics ? metrics.status() : { enabled: false }
    };
  }

  /** Called by the metrics service as results arrive. */
  function metricsUpdated(ids) { if (live) changed(ids, 'metrics'); }

  /** A ticket Zoho just confirmed after an agent action: show it to everyone now, not at the next poll. */
  function applyTicket(raw) {
    if (!live || !raw || !raw.id) return;
    const id = String(raw.id);
    live.byId.set(id, Object.assign({}, live.byId.get(id) || {}, slim(raw)));
    changed([id], 'action');
  }

  /** Zoho agents by id ({ id, name, email }). */
  async function agentList() {
    if (zoho.configured) { await loadAgents(); return agents.data; }
    const snap = await get(false).catch(() => null);
    return (snap && snap.agents) || {};
  }

  return { get, lookup, poll, build, trigger, start, stop, status, metricsUpdated, applyTicket, agents: agentList, on: (e, fn) => events.on(e, fn), off: (e, fn) => events.off(e, fn) };
}

module.exports = { createSnapshotService, slim };

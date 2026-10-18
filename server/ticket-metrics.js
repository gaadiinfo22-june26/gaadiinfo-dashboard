/**
 * Zoho Desk ticket metrics (GET /tickets/{id}/metrics): first response time,
 * response count, reopens. Zoho has no bulk endpoint for these, so the server
 * reads them one ticket at a time in the background, only for tickets whose
 * modifiedTime changed, and caches the result in CACHE_DIR.
 *
 * Zoho returns durations as strings such as "02:36 hrs" (hours can exceed 24)
 * and reports "00:00 hrs" with responseCount "0" when nobody has replied.
 */
const T = require('../src/taxonomy');
const { mapLimit } = require('./zoho');

const CONCURRENCY = 2;
const ANNOUNCE_EVERY = 100;

/** "02:36 hrs" → 156. Also accepts "1 days 02:36 hrs" and "45 mins". Unknown formats → null. */
function parseZohoDuration(value) {
  if (typeof value === 'number' && isFinite(value)) return value;
  const s = String(value || '').trim().toLowerCase();
  if (!s) return null;
  let minutes = 0;
  let matched = false;
  const days = /(\d+)\s*days?/.exec(s);
  if (days) { minutes += Number(days[1]) * 1440; matched = true; }
  const hm = /(\d+):(\d{1,2})(?::(\d{1,2}))?\s*(hrs?|hours?)?/.exec(s);
  if (hm) { minutes += Number(hm[1]) * 60 + Number(hm[2]); matched = true; }
  else {
    const mins = /(\d+)\s*mins?/.exec(s);
    if (mins) { minutes += Number(mins[1]); matched = true; }
  }
  return matched ? minutes : null;
}

function toCount(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Zoho's metrics payload → the fields the dashboard uses. */
function parseMetrics(data) {
  const d = data && data.data ? data.data : data || {};
  const responses = toCount(d.responseCount);
  return {
    firstResponseMinutes: responses ? parseZohoDuration(d.firstResponseTime) : null,
    responseCount: responses,
    reopenCount: toCount(d.reopenCount),
    reassignCount: toCount(d.reassignCount)
  };
}

/**
 * @param {{zoho, cache, enabled:boolean, log?:Function, onUpdate?:Function}} deps
 *   onUpdate(ids) is called as results arrive, so the snapshot can republish.
 */
function createMetricsService({ zoho, cache, enabled, log, onUpdate }) {
  const say = log || (() => {});
  const byId = new Map();          // id → { modifiedTime, data }
  const queue = new Map();         // id → modifiedTime wanted
  let running = null;
  let remaining = 0;
  let failures = 0;
  let lastError = null;

  function known(id) {
    if (!byId.has(id)) {
      const c = cache.read('ticket-metrics', id);
      byId.set(id, c || null);
    }
    return byId.get(id);
  }

  /** Metrics we already have for a ticket (possibly from an older modifiedTime). */
  function get(id) {
    const k = known(String(id));
    return k ? k.data : null;
  }

  function wants(t) {
    if (!enabled || !t || !t.id) return false;
    if (T.channelFor(t.channel, t.channelCode) === 'phone') return false; // call logs: no replies to time
    const k = known(String(t.id));
    return !k || k.modifiedTime !== (t.modifiedTime || null);
  }

  /** Queue tickets whose metrics are missing or out of date, and work through them. */
  function refresh(tickets) {
    if (!enabled) return;
    tickets.filter(wants).forEach(t => queue.set(String(t.id), t.modifiedTime || null));
    if (!running && queue.size) running = drain().finally(() => { running = null; if (queue.size) refresh([]); });
  }

  async function drain() {
    const batch = Array.from(queue.entries());
    queue.clear();
    remaining = batch.length;
    if (batch.length > 5) say(`Reading Zoho ticket metrics for ${batch.length} tickets in the background…`);
    let done = [];
    await mapLimit(batch, CONCURRENCY, async ([id, modifiedTime]) => {
      try {
        const data = parseMetrics(await zoho.get(`/tickets/${id}/metrics`));
        const record = { at: Date.now(), modifiedTime, data };
        byId.set(id, record);
        cache.write('ticket-metrics', id, record);
        done.push(id);
      } catch (e) {
        failures++;
        lastError = e.message.slice(0, 160);
      }
      remaining--;
      if (done.length >= ANNOUNCE_EVERY) { const ids = done; done = []; if (onUpdate) onUpdate(ids); }
    });
    if (done.length && onUpdate) onUpdate(done);
  }

  function status() {
    let measured = 0;
    byId.forEach(v => { if (v) measured++; });
    return { enabled: !!enabled, measured, pending: queue.size + remaining, failures, lastError };
  }

  return { get, refresh, status, idle: () => running || Promise.resolve() };
}

module.exports = { createMetricsService, parseMetrics, parseZohoDuration };

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sync = require('../scripts/fetch-tickets');
const { rawTicket } = require('./fixtures');

// A fake Zoho client that serves pages from a list, like offset pagination.
function fakeClient(pages) {
  const calls = [];
  return {
    calls,
    base: 'https://desk.example/api/v1',
    request(url) {
      calls.push(url);
      const from = Number(new URL(url).searchParams.get('from'));
      const page = pages[from / 100];
      if (page instanceof Error) return Promise.reject(page);
      return Promise.resolve({ data: page || [] }); // past the end: what the 204 handler returns
    }
  };
}

test('requires the module without running a sync', () => {
  assert.equal(typeof sync.buildSnapshot, 'function');
});

test('still requests every field the original script requested', () => {
  ['id', 'subject', 'status', 'createdTime', 'closedTime', 'priority', 'channel', 'threadCount',
    'contactId', 'assigneeId', 'customerResponseTime', 'webUrl'].forEach(f => assert.ok(sync.TICKET_FIELDS.includes(f), f));
  assert.ok(sync.TICKET_FIELDS.length <= 30, 'Zoho allows at most 30 fields');
  assert.ok(sync.TICKET_FIELDS.includes('statusType'));
});

test('pagination removes duplicates that straddle a page boundary', async () => {
  const page1 = Array.from({ length: 100 }, () => rawTicket());
  const repeated = Object.assign({}, page1[99]);
  const page2 = [repeated, rawTicket(), rawTicket()];
  const client = fakeClient([page1, page2]);
  const r = await sync.fetchAllTickets(client);
  assert.equal(r.scanned, 103);
  assert.equal(r.duplicatesRemoved, 1);
  assert.equal(r.tickets.length, 102);
  assert.equal(client.calls.length, 2);
});

test('a full last page ends cleanly on the empty (204) page', async () => {
  const page1 = Array.from({ length: 100 }, () => rawTicket());
  const r = await sync.fetchAllTickets(fakeClient([page1]));
  assert.equal(r.tickets.length, 100);
  assert.equal(r.pages, 2);
});

test('a failed page aborts the run instead of writing a partial list', async () => {
  const page1 = Array.from({ length: 100 }, () => rawTicket());
  await assert.rejects(sync.fetchAllTickets(fakeClient([page1, new Error('HTTP 401: expired')])), /401/);
});

test('`tickets` keeps its original meaning: everything not closed', () => {
  const all = [
    rawTicket(),
    rawTicket({ status: 'On Hold', statusType: 'On Hold' }),
    rawTicket({ status: 'Closed', statusType: 'Closed', createdTime: '2026-10-15T00:00:00Z' }),
    rawTicket({ status: 'AUTO Closed No Response', statusType: 'Closed', createdTime: '2026-06-01T00:00:00Z' })
  ];
  const now = new Date('2026-10-17T00:00:00Z');
  const off = sync.splitTickets(all, { lookbackDays: 0, now });
  assert.equal(off.open.length, 2);
  assert.equal(off.closed.length, 0, 'lookback 0 = original behaviour, no closed tickets');

  const on = sync.splitTickets(all, { lookbackDays: 90, now });
  assert.equal(on.open.length, 2);
  assert.equal(on.closed.length, 1, 'only closed tickets created inside the window');
  assert.equal(on.closedCreatedSince.toISOString(), '2026-07-19T00:00:00.000Z');
});

test('lookback days parsing is safe for blank and bad values', () => {
  assert.equal(sync.parseLookbackDays(undefined), 0);
  assert.equal(sync.parseLookbackDays(''), 0);
  assert.equal(sync.parseLookbackDays('abc'), 0);
  assert.equal(sync.parseLookbackDays('-5'), 0);
  assert.equal(sync.parseLookbackDays('90'), 90);
});

test('snapshot keeps the original keys and records failures', () => {
  const t0 = new Date('2026-10-17T00:00:00Z');
  const snap = sync.buildSnapshot({
    startedAt: t0, finishedAt: new Date(t0.getTime() + 60000), open: [rawTicket()], closed: [],
    closedCreatedSince: null, lookbackDays: 0, contacts: {}, agents: {},
    contactFailures: [{ contactId: '9', error: 'HTTP 404' }], agentsError: 'HTTP 403', pages: 1, scanned: 1, duplicatesRemoved: 0
  });
  ['fetchedAt', 'tickets', 'contacts', 'agents'].forEach(k => assert.ok(k in snap, k));
  assert.equal(snap.schemaVersion, 2);
  assert.equal(snap.sync.contactFailures.length, 1);
  assert.equal(snap.sync.agentsError, 'HTTP 403');
});

test('re-running with the same data writes the same snapshot (idempotent)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-sync-'));
  const file = path.join(dir, 'tickets.json');
  const t0 = new Date('2026-10-17T00:00:00Z');
  const args = {
    startedAt: t0, finishedAt: t0, open: [rawTicket({ id: '1' })], closed: [], closedCreatedSince: null, lookbackDays: 0,
    contacts: {}, agents: {}, contactFailures: [], agentsError: null, pages: 1, scanned: 1, duplicatesRemoved: 0
  };
  sync.writeAtomic(file, sync.buildSnapshot(args));
  const first = fs.readFileSync(file, 'utf8');
  sync.writeAtomic(file, sync.buildSnapshot(args));
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  assert.equal(fs.existsSync(file + '.tmp'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createActionService } = require('../server/actions');
const { createCache } = require('../server/cache');
const { createApp } = require('../server/app');
const { readConfig } = require('../server/config');

const NOW = new Date('2026-10-17T06:30:00Z');
const AGENTS = { a1: { id: 'a1', name: 'Asha', email: 'asha@example.in' }, s1: { id: 's1', name: 'Sam Supervisor', email: 'sam@example.in' } };
const ASHA = { agentId: 'a1', name: 'Asha', email: 'asha@example.in', declared: false };
const WRITE = { enabled: true, statusOpen: 'Open', statusWaiting: 'On Hold', statusClosed: 'Closed', supervisorEmail: 'sam@example.in' };

/** A Zoho Desk stand-in that keeps one ticket and its comments, like the real API. */
function fakeZoho(opts) {
  const o = opts || {};
  let n = 0;
  const state = {
    ticket: Object.assign({ id: '1001', status: 'Open', assigneeId: null, modifiedTime: '2026-10-17T05:00:00.000Z', threadCount: '2', lastThread: { direction: 'out' } }, o.ticket),
    comments: [], calls: []
  };
  return {
    configured: true, state, calls: state.calls,
    async get(p) {
      state.calls.push(['GET', p]);
      if (p === '/tickets/1001') return JSON.parse(JSON.stringify(state.ticket));
      if (p === '/tickets/1001/comments') return { data: state.comments.slice().reverse() };
      throw new Error('unexpected ' + p);
    },
    async send(method, p, body) {
      state.calls.push([method, p, body]);
      if (o.onSend) { const r = o.onSend(method, p, body, state); if (r) return r; }
      if (method === 'PATCH') {
        if (!o.ignorePatch) Object.assign(state.ticket, body, { modifiedTime: `2026-10-17T06:${String(++n).padStart(2, '0')}:00.000Z` });
        return { id: '1001' };
      }
      state.comments.push({ content: body.content, isPublic: body.isPublic });
      return { id: 'c' + state.comments.length };
    }
  };
}

function setup(zohoOpts, configPatch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-actions-'));
  const zoho = fakeZoho(zohoOpts);
  const applied = [];
  const snapshots = { agents: async () => AGENTS, applyTicket: t => applied.push(t) };
  const config = { write: Object.assign({}, WRITE, configPatch) };
  const svc = createActionService({ zoho, cache: createCache(path.join(dir, 'cache')), config, snapshots, auditDir: path.join(dir, 'audit'), now: () => NOW });
  let seq = 0;
  const id = () => `test-action-${++seq}-${Date.now()}`;
  const audit = () => fs.readdirSync(path.join(dir, 'audit')).flatMap(f => fs.readFileSync(path.join(dir, 'audit', f), 'utf8').trim().split('\n').map(l => JSON.parse(l)));
  return { dir, zoho, svc, applied, id, audit, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const writes = z => z.calls.filter(c => c[0] !== 'GET');

test('actions: off unless ZOHO_WRITE=on, and only for a known agent', async () => {
  const off = setup(null, { enabled: false });
  try {
    await assert.rejects(off.svc.perform('1001', 'note', { actionId: off.id(), text: 'hello' }, ASHA), e => e.code === 'not_configured');
    assert.equal(writes(off.zoho).length, 0);
  } finally { off.done(); }
  const on = setup();
  try {
    await assert.rejects(on.svc.perform('1001', 'note', { actionId: on.id(), text: 'hello' }, null), e => e.code === 'forbidden');
  } finally { on.done(); }
});

test('claim: assigned in Zoho, read back, noted with who did it, audited and shown to everyone', async () => {
  const s = setup();
  try {
    const r = await s.svc.perform('1001', 'assign', { actionId: s.id(), assigneeId: 'a1', seenModifiedTime: '2026-10-17T05:00:00.000Z' }, ASHA);
    assert.equal(r.ok, true);
    assert.equal(r.ticket.assigneeId, 'a1');
    assert.deepEqual(writes(s.zoho).map(c => [c[0], c[1]]), [['PATCH', '/tickets/1001'], ['POST', '/tickets/1001/comments']]);
    assert.deepEqual(writes(s.zoho)[0][2], { assigneeId: 'a1' });
    const note = s.zoho.state.comments[0];
    assert.equal(note.isPublic, false, 'internal note, never sent to the customer');
    assert.match(note.content, /^\[Workspace\] Assigned to Asha\. — Asha · ref test-action-/);
    assert.equal(s.applied.length, 1, 'confirmed ticket pushed to every open browser');
    const log = s.audit();
    assert.equal(log[0].result, 'saved');
    assert.equal(log[0].actor.name, 'Asha');
  } finally { s.done(); }
});

test('waiting: needs who, why and a follow-up date; sets the waiting status and the follow-up', async () => {
  const s = setup();
  try {
    await assert.rejects(s.svc.perform('1001', 'waiting', { actionId: s.id(), kind: 'customer', reason: 'Order ID or vehicle number' }, ASHA), e => e.code === 'bad_request');
    await assert.rejects(s.svc.perform('1001', 'waiting', { actionId: s.id(), kind: 'customer', reason: 'Order ID or vehicle number', followUpAt: '2026-10-17T06:00:00Z' }, ASHA), /future/);
    await assert.rejects(s.svc.perform('1001', 'waiting', { actionId: s.id(), kind: 'customer', reason: 'Order ID or vehicle number', followUpAt: '2026-11-17T06:00:00Z' }, ASHA), /14 days/);
    assert.equal(writes(s.zoho).length, 0, 'invalid requests never reach Zoho');
    const r = await s.svc.perform('1001', 'waiting', { actionId: s.id(), kind: 'customer', reason: 'Payment proof (UTR or screenshot)', followUpAt: '2026-10-18T05:30:00Z', note: 'Asked for UTR on WhatsApp' }, ASHA);
    assert.equal(s.zoho.state.ticket.status, 'On Hold');
    assert.equal(r.followUp.kind, 'customer');
    assert.equal(r.followUp.at, '2026-10-18T05:30:00.000Z');
    assert.equal(s.svc.followUpFor('1001').reason, 'Payment proof (UTR or screenshot)');
    assert.match(s.zoho.state.comments[0].content, /Waiting on customer: Payment proof \(UTR or screenshot\)\. Follow up by Sun, 18 Oct, 11:00 am IST\. Asked for UTR on WhatsApp/);
  } finally { s.done(); }
});

test('resolve: needs a resolution and a note, and won\'t close an unanswered customer by accident', async () => {
  const s = setup({ ticket: { lastThread: { direction: 'in' } } });
  try {
    await assert.rejects(s.svc.perform('1001', 'resolve', { actionId: s.id(), code: 'answered' }, ASHA), /resolution note/);
    await assert.rejects(s.svc.perform('1001', 'resolve', { actionId: s.id(), code: 'answered', note: 'Shared settlement proof' }, ASHA), e => e.code === 'needs_confirmation');
    assert.equal(writes(s.zoho).length, 0);
    await s.svc.perform('1001', 'resolve', { actionId: s.id(), code: 'answered', note: 'Answered on a call', confirmUnanswered: true }, ASHA);
    assert.equal(s.zoho.state.ticket.status, 'Closed');
    assert.equal(s.zoho.state.ticket.resolution, 'Question answered. Answered on a call');
  } finally { s.done(); }
  const dup = setup({ ticket: { lastThread: { direction: 'in' } } });
  try {
    await dup.svc.perform('1001', 'resolve', { actionId: dup.id(), code: 'duplicate', note: 'Same as #5012' }, ASHA);
    assert.equal(dup.zoho.state.ticket.status, 'Closed', 'duplicates can close without a reply');
  } finally { dup.done(); }
});

test('escalate: goes to the supervisor (SUPERVISOR_EMAIL) with the reason', async () => {
  const s = setup();
  try {
    await s.svc.perform('1001', 'escalate', { actionId: s.id(), reason: 'Legal notice or threat', note: 'Customer mentions consumer court' }, ASHA);
    assert.equal(s.zoho.state.ticket.assigneeId, 's1');
    assert.match(s.zoho.state.comments[0].content, /Escalated to Sam Supervisor: Legal notice or threat\. Customer mentions consumer court/);
  } finally { s.done(); }
});

test('conflict: refuses if the ticket changed since the agent opened it, unless they insist', async () => {
  const s = setup({ ticket: { modifiedTime: '2026-10-17T06:10:00.000Z', assigneeId: 's1', threadCount: '3' } });
  try {
    await assert.rejects(
      s.svc.perform('1001', 'assign', { actionId: s.id(), assigneeId: 'a1', seenModifiedTime: '2026-10-17T05:00:00.000Z', seen: { status: 'Open', assigneeId: null, threadCount: '2' } }, ASHA),
      e => e.code === 'conflict' && /owner nobody → Sam Supervisor, new messages/.test(e.message) && e.current.assigneeId === 's1');
    assert.equal(writes(s.zoho).length, 0);
    await s.svc.perform('1001', 'assign', { actionId: s.id(), assigneeId: 'a1', seenModifiedTime: '2026-10-17T05:00:00.000Z', force: true }, ASHA);
    assert.equal(s.zoho.state.ticket.assigneeId, 'a1');
  } finally { s.done(); }
});

test('no false success: if Zoho does not show the change, nothing is reported as saved and no note is added', async () => {
  const s = setup({ ignorePatch: true });
  try {
    await assert.rejects(s.svc.perform('1001', 'waiting', { actionId: s.id(), kind: 'gaadiinfo', reason: 'Refund processing', followUpAt: '2026-10-18T05:30:00Z' }, ASHA),
      e => e.code === 'not_applied' && /On Hold/.test(e.message));
    assert.equal(s.zoho.state.comments.length, 0);
    assert.equal(s.svc.followUpFor('1001'), null);
    assert.equal(s.audit()[0].result, 'not_applied');
  } finally { s.done(); }
});

test('duplicate prevention: the same action id is applied once, even after a double click', async () => {
  const s = setup();
  try {
    const actionId = s.id();
    const [a, b] = await Promise.all([
      s.svc.perform('1001', 'note', { actionId, text: 'Called customer, no answer' }, ASHA),
      s.svc.perform('1001', 'note', { actionId, text: 'Called customer, no answer' }, ASHA)
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.repeated, true);
    assert.equal(s.zoho.state.comments.length, 1);
  } finally { s.done(); }
});

test('uncertain send: a note that timed out is checked in Zoho before retrying, so it is never posted twice', async () => {
  let first = true;
  const s = setup({
    onSend: (method, p, body, state) => {
      if (method === 'POST' && first) {
        first = false;
        state.comments.push({ content: body.content, isPublic: false }); // Zoho saved it…
        throw Object.assign(new Error('No answer from Zoho Desk (timed out)'), { code: 'uncertain' }); // …but we never heard back
      }
      return null;
    }
  });
  try {
    const actionId = s.id();
    await assert.rejects(s.svc.perform('1001', 'note', { actionId, text: 'Refund approved by finance' }, ASHA), e => e.code === 'uncertain');
    const r = await s.svc.perform('1001', 'note', { actionId, text: 'Refund approved by finance' }, ASHA);
    assert.equal(r.ok, true);
    assert.equal(s.zoho.state.comments.length, 1, 'found the first note in Zoho; did not post again');
  } finally { s.done(); }
});

test('partial: status saved but note failed → retry adds only the note', async () => {
  let failNote = true;
  const s = setup({ onSend: (method) => { if (method === 'POST' && failNote) { failNote = false; throw Object.assign(new Error('HTTP 500'), { code: 'zoho_error' }); } return null; } });
  try {
    const actionId = s.id();
    const input = { actionId, kind: 'external', reason: 'Payment gateway or bank', followUpAt: '2026-10-18T05:30:00Z' };
    await assert.rejects(s.svc.perform('1001', 'waiting', input, ASHA), e => e.code === 'partial' && /change is saved in Zoho/.test(e.message));
    await s.svc.perform('1001', 'waiting', input, ASHA);
    assert.equal(writes(s.zoho).filter(c => c[0] === 'PATCH').length, 1, 'status written once');
    assert.equal(s.zoho.state.comments.length, 1);
  } finally { s.done(); }
});

// ── Over HTTP: named logins, who-am-I, JSON-only writes ──
async function startApp(env, actions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-actions-http-'));
  const config = Object.assign(readConfig(Object.assign({ CACHE_DIR: path.join(dir, 'cache'), SNAPSHOT_FILE: path.join(dir, 'none.json') }, env)));
  const snapshots = { agents: async () => AGENTS, lookup: async () => ({ ticket: null, agents: AGENTS }), status: () => ({}), on() {}, off() {} };
  const handler = createApp({ config, zoho: { configured: true }, snapshots, conversations: {}, summarizer: { enabled: false }, actions, status: { configured: false } });
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { get: (p, init) => fetch(base + p, init), close: () => new Promise(r => { server.close(r); fs.rmSync(dir, { recursive: true, force: true }); }) };
}
const basic = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });

test('named logins: each agent signs in as themselves and actions are recorded under that name', async () => {
  const seen = [];
  const actions = { enabled: true, options: () => ({}), perform: async (id, type, body, actor) => { seen.push({ id, type, actor }); return { ok: true }; } };
  const app = await startApp({ WORKSPACE_USERS: 'asha@example.in:s3cret,nobody@example.in:pw' }, actions);
  try {
    assert.equal((await app.get('/api/me')).status, 401);
    assert.equal((await app.get('/api/me', { headers: basic('asha@example.in', 'wrong') })).status, 401);
    const me = await (await app.get('/api/me', { headers: basic('Asha@Example.in', 's3cret') })).json();
    assert.equal(me.actor.name, 'Asha');
    assert.equal(me.actor.declared, false);
    // A login without a matching Zoho agent can read but not act.
    const ghost = await (await app.get('/api/me', { headers: basic('nobody@example.in', 'pw') })).json();
    assert.equal(ghost.actor, null);
    assert.equal(ghost.loginWithoutAgent, true);
    // The agent header is ignored when logins are on: you can't act as someone else.
    const r = await app.get('/api/tickets/279815000000000001/actions', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'X-Workspace-Agent': 's1' }, basic('asha@example.in', 's3cret')), body: JSON.stringify({ type: 'note', text: 'x' }) });
    assert.equal(r.status, 200);
    assert.equal(seen[0].actor.agentId, 'a1');
    const plain = await app.get('/api/tickets/279815000000000001/actions', { method: 'POST', headers: Object.assign({ 'Content-Type': 'text/plain' }, basic('asha@example.in', 's3cret')), body: '{}' });
    assert.equal(plain.status, 415);
  } finally { await app.close(); }
});

test('without logins, the agent picks who they are and notes say "self-selected"', async () => {
  const seen = [];
  const actions = { enabled: true, options: () => ({}), perform: async (id, type, body, actor) => { seen.push(actor); return { ok: true }; } };
  const app = await startApp({}, actions);
  try {
    const me = await (await app.get('/api/me', { headers: { 'X-Workspace-Agent': 'a1' } })).json();
    assert.equal(me.actor.declared, true);
    assert.equal(me.agents.length, 2);
    await app.get('/api/tickets/279815000000000001/actions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Agent': 'a1' }, body: JSON.stringify({ type: 'note', text: 'x' }) });
    assert.equal(seen[0].declared, true);
    await app.get('/api/tickets/279815000000000001/actions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Agent': 'not-an-agent' }, body: JSON.stringify({ type: 'note', text: 'x' }) });
    assert.equal(seen[1], null, 'unknown agent → no actor → the service refuses');
  } finally { await app.close(); }
});

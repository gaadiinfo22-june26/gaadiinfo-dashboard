/**
 * Agent actions written back to Zoho Desk (only when ZOHO_WRITE=on).
 *
 * Zoho stays the system of record. Every action:
 *   1. re-reads the ticket from Zoho and refuses if it changed since the agent
 *      looked at it (another agent, or a new customer message);
 *   2. applies the change in Zoho;
 *   3. reads the ticket back and reports success only if Zoho shows the change;
 *   4. leaves an internal note in Zoho saying who did what, because Zoho
 *      attributes API changes to the account that owns the token;
 *   5. is written to the audit log in CACHE_DIR.
 * Each action carries an id from the browser, so a double click or a retry
 * after a timeout never applies it twice or posts the note twice.
 *
 *   assign    { assigneeId }                            claim or hand over
 *   waiting   { kind, reason, followUpAt, note }        → waiting status + follow-up date
 *   resolve   { code, note, confirmUnanswered }         → closed status + resolution
 *   reopen    { note }                                  → open status
 *   escalate  { assigneeId?, reason, note }             → the supervisor (or the chosen person)
 *   note      { text }                                  internal note only
 */
const fs = require('fs');
const path = require('path');
const { slim } = require('./snapshot');

const { WAIT_KINDS, RESOLUTIONS, ESCALATION_REASONS } = require('../src/taxonomy');

const MIN_FOLLOW_UP_MS = 5 * 60000;
const MAX_FOLLOW_UP_MS = 14 * 86400000;
const ACTION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function bad(message) { return Object.assign(new Error(message), { code: 'bad_request' }); }
function text(v, max) { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''; }
function sameStatus(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }

function istTime(d) {
  return new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' IST';
}

/** Validate an action request and turn it into the Zoho change it needs. */
function plan(type, input, ctx) {
  const w = ctx.write;
  const note = text(input.note, 1000);
  switch (type) {
    case 'assign': {
      const id = String(input.assigneeId || '');
      if (!ctx.agents[id]) throw bad('Pick someone from the agent list.');
      return { patch: { assigneeId: id }, note: `Assigned to ${ctx.agents[id].name}.` };
    }
    case 'waiting': {
      const kind = WAIT_KINDS[input.kind];
      if (!kind) throw bad('Choose who we are waiting on.');
      const reason = text(input.reason, 120);
      if (!kind.reasons.includes(reason)) throw bad('Choose a reason.');
      if (reason === 'Other' && note.length < 5) throw bad('Say what we are waiting for.');
      const at = new Date(input.followUpAt);
      if (isNaN(at)) throw bad('Set a follow-up date.');
      if (at - ctx.now < MIN_FOLLOW_UP_MS) throw bad('The follow-up must be in the future.');
      if (at - ctx.now > MAX_FOLLOW_UP_MS) throw bad('Follow up within 14 days; set a new date then if needed.');
      return {
        patch: { status: w.statusWaiting },
        followUp: { at: at.toISOString(), kind: input.kind, reason, note },
        note: `${kind.label}: ${reason}. Follow up by ${istTime(at)}.${note ? ' ' + note : ''}`
      };
    }
    case 'resolve': {
      const r = RESOLUTIONS.find(x => x.id === input.code);
      if (!r) throw bad('Choose how it was resolved.');
      if (note.length < 5) throw bad('Add a short resolution note (what was done).');
      if (ctx.customerSpokeLast && !r.unansweredOk && input.confirmUnanswered !== true) {
        throw Object.assign(new Error('The customer\'s last message has not been answered. Reply first, or confirm that closing is right.'), { code: 'needs_confirmation' });
      }
      return { patch: { status: w.statusClosed, resolution: `${r.label}. ${note}` }, clearFollowUp: true, note: `Resolved — ${r.label}. ${note}` };
    }
    case 'reopen': {
      if (note.length < 5) throw bad('Say why the ticket is reopened.');
      return { patch: { status: w.statusOpen }, clearFollowUp: true, note: `Reopened. ${note}` };
    }
    case 'escalate': {
      const reason = text(input.reason, 120);
      if (!ESCALATION_REASONS.includes(reason)) throw bad('Choose an escalation reason.');
      const to = String(input.assigneeId || ctx.supervisorId || '');
      if (!ctx.agents[to]) throw bad('No supervisor is set (SUPERVISOR_EMAIL). Pick who should take it.');
      return { patch: { assigneeId: to, status: w.statusOpen }, clearFollowUp: true, note: `Escalated to ${ctx.agents[to].name}: ${reason}.${note ? ' ' + note : ''}` };
    }
    case 'note': {
      const body = text(input.text, 2000);
      if (body.length < 2) throw bad('Write the note first.');
      return { note: body, noteOnly: true };
    }
    default:
      throw bad('Unknown action.');
  }
}

/** What changed between two copies of a ticket, in words an agent understands. */
function describeChange(before, after, agents) {
  const out = [];
  if (!sameStatus(before.status, after.status)) out.push(`status ${before.status || '—'} → ${after.status || '—'}`);
  if (String(before.assigneeId || '') !== String(after.assigneeId || '')) {
    const name = id => (id && agents[id] ? agents[id].name : id ? 'someone else' : 'nobody');
    out.push(`owner ${name(before.assigneeId)} → ${name(after.assigneeId)}`);
  }
  if (String(before.threadCount || '') !== String(after.threadCount || '')) out.push('new messages');
  return out.length ? out.join(', ') : 'other details';
}

/**
 * @param {{zoho, cache, config, snapshots, auditDir:string, log?:Function, now?:Function}} deps
 */
function createActionService({ zoho, cache, config, snapshots, auditDir, log, now }) {
  const say = log || (() => {});
  const clock = now || (() => new Date());
  const enabled = !!(config.write.enabled && zoho.configured && zoho.send);
  const locks = new Map();
  const followUps = new Map();

  function followUpFor(id) {
    const key = String(id);
    if (!followUps.has(key)) followUps.set(key, cache.read('followups', key) || null);
    const f = followUps.get(key);
    return f && f.active ? f : null;
  }

  function setFollowUp(id, record) {
    followUps.set(String(id), record);
    cache.write('followups', String(id), record);
  }

  function audit(entry) {
    try {
      fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
      const file = path.join(auditDir, `${entry.at.slice(0, 7)}.jsonl`);
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch (e) {
      say(`Could not write the audit log: ${e.message}`);
    }
  }

  async function agentsMap() {
    return (await snapshots.agents().catch(() => ({}))) || {};
  }

  /** Has a note carrying this action's reference already reached Zoho? */
  async function noteExists(ticketId, ref) {
    const res = await zoho.get(`/tickets/${ticketId}/comments`, { sortBy: '-commentedTime', limit: 20 });
    return (res.data || []).some(c => String(c.content || '').includes(ref));
  }

  async function run(ticketId, type, input, actor) {
    const actionId = String(input.actionId || '');
    if (!ACTION_ID_RE.test(actionId)) throw bad('Missing action id.');
    const record = cache.read('actions', actionId) || { actionId, ticketId, type, steps: {}, state: 'new' };
    if (record.ticketId !== ticketId || record.type !== type) throw bad('Action id reused for a different action.');
    if (record.state === 'done') return Object.assign({}, record.result, { repeated: true });

    const agents = await agentsMap();
    const before = await zoho.get(`/tickets/${ticketId}`);
    const nowDate = clock();
    const supervisor = Object.values(agents).find(a => a.email && a.email.toLowerCase() === config.write.supervisorEmail);
    const p = plan(type, input, {
      write: config.write, agents, now: nowDate, supervisorId: supervisor ? supervisor.id : null,
      customerSpokeLast: !!(before.lastThread && before.lastThread.direction === 'in')
    });

    // Refuse to act on a ticket that changed since the agent looked at it (unless they've seen it and insist).
    const fresh = record.steps.patched || record.steps.noted;
    if (!fresh && input.seenModifiedTime && before.modifiedTime && input.seenModifiedTime !== before.modifiedTime && input.force !== true) {
      throw Object.assign(new Error(`This ticket changed in Zoho since you opened it (${describeChange(input.seen || {}, before, agents)}). Check the latest version, then try again.`),
        { code: 'conflict', current: slim(before) });
    }

    record.state = 'pending';
    record.startedAt = record.startedAt || nowDate.toISOString();
    cache.write('actions', actionId, record);

    let after = before;
    try {
      if (p.patch && !record.steps.patched) {
        try {
          await zoho.send('PATCH', `/tickets/${ticketId}`, p.patch);
        } catch (e) {
          if (e.code !== 'uncertain') throw e;
          // Unknown outcome: the read-back below decides whether it was applied.
        }
        after = await zoho.get(`/tickets/${ticketId}`);
        const missing = [];
        if (p.patch.status && !sameStatus(after.status, p.patch.status)) missing.push(`status is still "${after.status}"`);
        if (p.patch.assigneeId && String(after.assigneeId || '') !== p.patch.assigneeId) missing.push('owner did not change');
        if (missing.length) {
          throw Object.assign(new Error(`Zoho didn't apply the change (${missing.join(', ')}). Nothing was saved; check the status name "${p.patch.status || ''}" exists in Zoho.`), { code: 'not_applied' });
        }
        record.steps.patched = true;
        cache.write('actions', actionId, record);
      }

      const ref = `ref ${actionId}`;
      const noteText = `[Workspace] ${p.note} — ${actor.name}${actor.declared ? ' (self-selected)' : ''} · ${ref}`;
      if (!record.steps.noted) {
        if (record.steps.noteUncertain && await noteExists(ticketId, ref)) {
          record.steps.noted = true;
        } else {
          try {
            await zoho.send('POST', `/tickets/${ticketId}/comments`, { content: noteText, contentType: 'plainText', isPublic: false });
            record.steps.noted = true;
          } catch (e) {
            if (e.code === 'uncertain') { record.steps.noteUncertain = true; cache.write('actions', actionId, record); }
            if (!p.noteOnly && record.steps.patched) {
              e.message = `The change is saved in Zoho, but the internal note wasn't added: ${e.message} Retry to add only the note.`;
              e.code = e.code === 'uncertain' ? 'uncertain' : 'partial';
            }
            throw e;
          }
        }
        cache.write('actions', actionId, record);
      }

      if (p.followUp) setFollowUp(ticketId, Object.assign({ active: true, setAt: nowDate.toISOString(), by: actor.name, byAgentId: actor.agentId }, p.followUp));
      if (p.clearFollowUp && followUpFor(ticketId)) setFollowUp(ticketId, Object.assign({}, followUpFor(ticketId), { active: false, clearedAt: nowDate.toISOString() }));
      if (snapshots.applyTicket) snapshots.applyTicket(after);

      const result = { ok: true, type, ticket: slim(after), followUp: followUpFor(ticketId), savedAt: clock().toISOString() };
      record.state = 'done';
      record.result = result;
      cache.write('actions', actionId, record);
      audit({ at: result.savedAt, actionId, ticketId, type, actor: { agentId: actor.agentId, name: actor.name, email: actor.email || null, declared: !!actor.declared },
        change: p.patch || null, followUp: p.followUp || null, result: 'saved', statusBefore: before.status, statusAfter: after.status });
      return result;
    } catch (e) {
      record.state = record.steps.patched || record.steps.noted || record.steps.noteUncertain ? 'partial' : 'failed';
      record.error = e.message;
      cache.write('actions', actionId, record);
      audit({ at: clock().toISOString(), actionId, ticketId, type, actor: { agentId: actor.agentId, name: actor.name, declared: !!actor.declared }, result: e.code || 'error', error: e.message.slice(0, 300) });
      throw e;
    }
  }

  /** One action per ticket at a time, so two agents can't interleave writes. */
  async function perform(ticketId, type, input, actor) {
    if (!enabled) throw Object.assign(new Error('Changing tickets from the workspace is off (ZOHO_WRITE). Make the change in Zoho.'), { code: 'not_configured' });
    if (!actor || !actor.agentId) throw Object.assign(new Error('Choose who you are ("Working as") before changing tickets.'), { code: 'forbidden' });
    const key = String(ticketId);
    const prev = locks.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => run(key, type, input || {}, actor));
    locks.set(key, next);
    try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
  }

  return {
    enabled, perform, followUpFor,
    options: () => ({ waitKinds: WAIT_KINDS, resolutions: RESOLUTIONS.map(r => ({ id: r.id, label: r.label, unansweredOk: !!r.unansweredOk })), escalationReasons: ESCALATION_REASONS })
  };
}

module.exports = { createActionService, plan, WAIT_KINDS, RESOLUTIONS, ESCALATION_REASONS };

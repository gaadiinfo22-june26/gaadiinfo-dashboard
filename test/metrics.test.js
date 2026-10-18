const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/ticket-model');
const X = require('../src/metrics');
const { rawTicket } = require('./fixtures');

const NOW = new Date('2026-10-17T06:30:00.000Z'); // 12:00 IST
const OPEN_ONLY = { includesClosed: false, closedCreatedSince: null, capped: false };
const WITH_CLOSED = { includesClosed: true, closedCreatedSince: null, capped: false };

function prepare(raws, store) {
  const deduped = M.dedupeById(raws).tickets;
  return M.applyCategories(deduped.map(r => M.normalizeTicket(r)), store || M.emptyCorrectionStore());
}

function dash(raws, filters, coverage, store) {
  return X.computeDashboard(prepare(raws, store), filters || {}, { now: NOW, coverage: coverage || OPEN_ONLY });
}

test('IST day boundaries: 19:00 UTC is the next day in India', () => {
  assert.equal(X.dayKey(new Date('2026-10-16T18:29:59Z')), '2026-10-16');
  assert.equal(X.dayKey(new Date('2026-10-16T18:30:00Z')), '2026-10-17');
  assert.equal(X.startOfDay('2026-10-17').toISOString(), '2026-10-16T18:30:00.000Z');
});

test('"Today" and "Last 7 days" use IST calendar days', () => {
  const raws = [
    rawTicket({ createdTime: '2026-10-16T18:45:00Z' }), // 17 Oct 00:15 IST -> today
    rawTicket({ createdTime: '2026-10-16T18:15:00Z' }), // 16 Oct 23:45 IST -> yesterday
    rawTicket({ createdTime: '2026-10-10T19:00:00Z' }), // 11 Oct IST -> within 7 days
    rawTicket({ createdTime: '2026-10-10T17:00:00Z' })  // 10 Oct IST -> outside 7 days
  ];
  assert.equal(dash(raws, { period: 'today' }).total, 1);
  assert.equal(dash(raws, { period: '7d' }).total, 3);
  assert.equal(dash(raws, { period: 'all' }).total, 4);
});

test('custom range is inclusive of both days and tolerates reversed input', () => {
  const raws = [
    rawTicket({ createdTime: '2026-10-01T05:00:00Z' }),
    rawTicket({ createdTime: '2026-10-03T05:00:00Z' }),
    rawTicket({ createdTime: '2026-10-05T05:00:00Z' })
  ];
  assert.equal(dash(raws, { period: 'custom', from: '2026-10-01', to: '2026-10-03' }).total, 2);
  assert.equal(dash(raws, { period: 'custom', from: '2026-10-03', to: '2026-10-01' }).total, 2);
});

test('duplicate records of the same Zoho ticket are counted once (latest copy wins)', () => {
  const a = rawTicket({ subject: 'Hi', modifiedTime: '2026-10-10T06:00:00Z' });
  const aLater = Object.assign({}, a, { subject: 'Refund please', modifiedTime: '2026-10-11T06:00:00Z' });
  const d = dash([a, aLater, rawTicket()]);
  assert.equal(d.total, 2);
  const cat = d.byCategory.find(c => c.id === 'refund_cancellation');
  assert.equal(cat.count, 1);
});

test('category counts add up to the total and list zero categories explicitly', () => {
  const raws = [
    rawTicket({ subject: 'Paisa refund' }),
    rawTicket({ subject: 'Order status query', channel: 'Phone', channelCode: null }),
    rawTicket({ subject: 'Hi GaadiInfo Support' }),
    rawTicket({ subject: 'Hi GaadiInfo Support' })
  ];
  const d = dash(raws);
  assert.equal(d.byCategory.reduce((n, c) => n + c.count, 0), d.total);
  assert.equal(d.byCategory.find(c => c.id === 'technical_issue').count, 0);
  assert.equal(d.byCategory.find(c => c.id === 'unclassified').count, 2);
  assert.deepEqual(d.unclassifiedBreakdown, [{ id: 'greeting', label: 'Greeting or template only', count: 2 }]);
});

test('filters combine: channel, category, status, assignee, search', () => {
  const raws = [
    rawTicket({ subject: 'Paisa refund', assigneeId: '111' }),
    rawTicket({ subject: 'Refund money', channel: 'Email', channelCode: null }),
    rawTicket({ subject: 'Refund please', status: 'Closed', statusType: 'Closed', closedTime: '2026-10-11T06:00:00Z' }),
    rawTicket({ subject: 'Challan status for MH12AB1234' })
  ];
  const t = prepare(raws);
  const f = filters => X.filterTickets(t, filters, NOW).length;
  assert.equal(f({ category: 'refund_cancellation' }), 3);
  assert.equal(f({ category: 'refund_cancellation', channel: 'whatsapp' }), 2);
  assert.equal(f({ category: 'refund_cancellation', status: 'unresolved' }), 2);
  assert.equal(f({ status: 'closed' }), 1);
  assert.equal(f({ assignee: 'unassigned' }), 3);
  assert.equal(f({ assignee: '111' }), 1);
  assert.equal(f({ search: 'mh12ab1234' }), 1);       // vehicle number from the subject
  assert.equal(f({ search: 'refund money' }), 1);     // all words must match
  assert.equal(f({ search: 'nothing-matches' }), 0);
});

test('custom closed status is closed, not open', () => {
  const d = dash([
    rawTicket({ status: 'AUTO Closed No Response', statusType: 'Closed' }),
    rawTicket()
  ]);
  assert.equal(d.unresolved, 1);
});

test('"No reply yet" counts only WhatsApp/email tickets with a single message', () => {
  const d = dash([
    rawTicket({ threadCount: '1' }),
    rawTicket({ threadCount: '3' }),
    rawTicket({ threadCount: '1', channel: 'Email', channelCode: null }),
    rawTicket({ threadCount: '0', channel: 'Phone', channelCode: null }), // agent-logged
    rawTicket({ threadCount: '1', status: 'Closed', statusType: 'Closed' })
  ], {}, WITH_CLOSED);
  assert.equal(d.noReplyYet, 2);
  assert.equal(d.noReplyEligible, 3);
});

test('backlog age buckets only unresolved tickets', () => {
  const d = dash([
    rawTicket({ createdTime: '2026-10-17T00:00:00Z' }),             // 6.5 h
    rawTicket({ createdTime: '2026-10-15T00:00:00Z' }),             // ~2.3 d
    rawTicket({ createdTime: '2026-09-21T00:00:00Z' }),             // > 2 weeks
    rawTicket({ createdTime: '2026-09-21T00:00:00Z', status: 'Closed', statusType: 'Closed' })
  ], {}, WITH_CLOSED);
  const by = Object.fromEntries(d.backlogAge.map(b => [b.id, b.count]));
  assert.deepEqual(by, { lt1d: 1, '1to3d': 1, '3to7d': 0, '7to14d': 0, gt14d: 1 });
  assert.equal(Math.round(d.oldestUnresolved.ageHours / 24), 26);
});

test('closed-ticket metrics are unavailable when the data has open tickets only', () => {
  const d = dash([rawTicket()], {}, OPEN_ONLY);
  assert.equal(d.closed.available, false);
  assert.equal(d.timeToClose.available, false);
  assert.match(d.timeToClose.reason, /CLOSED_LOOKBACK_DAYS/);
  assert.equal(d.completeness.complete, false);
  // ...but an "unresolved" view is complete even without closed tickets
  assert.equal(dash([rawTicket()], { status: 'unresolved' }, OPEN_ONLY).completeness.complete, true);
});

test('median time to close is computed from closed tickets when available', () => {
  const closed = (created, closedAt) => rawTicket({ status: 'Closed', statusType: 'Closed', createdTime: created, closedTime: closedAt });
  const d = dash([
    closed('2026-10-10T00:00:00Z', '2026-10-10T02:00:00Z'), // 2 h
    closed('2026-10-10T00:00:00Z', '2026-10-10T10:00:00Z'), // 10 h
    closed('2026-10-10T00:00:00Z', '2026-10-11T00:00:00Z'), // 24 h
    closed('2026-10-10T00:00:00Z', null),                   // no closed time - excluded
    rawTicket()
  ], {}, WITH_CLOSED);
  assert.equal(d.closed.count, 4);
  assert.equal(d.timeToClose.medianHours, 10);
  assert.equal(d.timeToClose.n, 3);
  assert.equal(d.timeToClose.excluded, 1);
});

test('closed lookback makes older periods incomplete', () => {
  const coverage = { includesClosed: true, closedCreatedSince: new Date('2026-09-17T06:30:00Z'), capped: false };
  assert.equal(dash([rawTicket()], { period: '7d' }, coverage).completeness.complete, true);
  assert.equal(dash([rawTicket()], { period: 'all' }, coverage).completeness.complete, false);
});

test('first response time is unavailable (with a reason) until Zoho metrics are in the data', () => {
  const d = dash([rawTicket()]);
  assert.equal(d.firstResponse.available, false);
  assert.ok(d.firstResponse.reason.length > 10);
  const withMetrics = dash([rawTicket({ metrics: { firstResponseMinutes: 30, responseCount: 1, reopenCount: 0, reassignCount: 0 } })]);
  assert.equal(withMetrics.firstResponse.available, true);
});

test('priority and SLA are unavailable when Zoho has no values (unknown is not zero)', () => {
  const d = dash([rawTicket(), rawTicket({ dueDate: '2026-10-11T00:00:00Z' }), rawTicket(), rawTicket()]);
  assert.equal(d.priority.available, false);
  assert.match(d.priority.reason, /not set on any of the 4/);
  assert.equal(d.sla.available, false);
  assert.match(d.sla.reason, /1 of 4/);

  const withSla = dash([
    rawTicket({ priority: 'High', dueDate: '2026-10-16T00:00:00Z' }),
    rawTicket({ priority: 'Low', dueDate: '2026-10-20T00:00:00Z' })
  ]);
  assert.equal(withSla.priority.available, true);
  assert.equal(withSla.sla.available, true);
  assert.equal(withSla.sla.overdue, 1);
});

test('daily series fills empty days with zero and switches to weeks for long ranges', () => {
  const d = dash([
    rawTicket({ createdTime: '2026-10-14T05:00:00Z' }),
    rawTicket({ createdTime: '2026-10-14T06:00:00Z' }),
    rawTicket({ createdTime: '2026-10-16T05:00:00Z' })
  ], { period: '7d' });
  assert.equal(d.daily.granularity, 'day');
  assert.equal(d.daily.buckets.length, 7);
  const byDay = Object.fromEntries(d.daily.buckets.map(b => [b.key, b.count]));
  assert.equal(byDay['2026-10-14'], 2);
  assert.equal(byDay['2026-10-15'], 0);
  assert.equal(byDay['2026-10-16'], 1);

  const long = dash([rawTicket({ createdTime: '2026-05-01T05:00:00Z' })], { period: 'all' });
  assert.equal(long.daily.granularity, 'week');
  assert.equal(long.daily.buckets.reduce((n, b) => n + b.count, 0), 1);
});

test('empty data produces zeros and an empty series, not errors', () => {
  const d = dash([]);
  assert.equal(d.total, 0);
  assert.equal(d.unresolved, 0);
  assert.equal(d.daily.buckets.length, 0);
  assert.equal(d.oldestUnresolved, null);
  assert.ok(d.byCategory.every(c => c.count === 0 && c.share === 0));
});

test('freshness flags a sync that has missed three scheduled runs', () => {
  assert.equal(X.freshness(new Date(NOW - 20 * 60000), NOW, 'snapshot').state, 'fresh');
  assert.equal(X.freshness(new Date(NOW - 50 * 60000), NOW, 'snapshot').state, 'stale');
  assert.equal(X.freshness(null, NOW, 'snapshot').state, 'unknown');
});

test('"Needs attention" ranks complaints and legal first, then money, and ignores closed or category-only flags', () => {
  const t = prepare([
    rawTicket({ subject: 'Refund please', createdTime: '2026-10-16T06:00:00Z' }),                    // money, 24h  -> green
    rawTicket({ subject: 'Refund money', createdTime: '2026-10-10T06:00:00Z' }),                     // money, 7d   -> red
    rawTicket({ subject: 'Re harami ke pila', createdTime: '2026-10-17T05:00:00Z' }),                // complaint   -> red, first
    rawTicket({ subject: 'Hi', contactId: 'rep' }), rawTicket({ subject: 'Hi', contactId: 'rep' }),
    rawTicket({ subject: 'Hi', contactId: 'rep' }),                                                  // repeat x3   -> green
    rawTicket({ subject: 'Paisa refund', status: 'Closed', statusType: 'Closed' }),                  // closed      -> excluded
    rawTicket({ subject: 'Abhi tak ye error clear kyu nahi hua' }),                                  // ambiguous only -> excluded
    rawTicket({ subject: 'AUTO-TEST urgent check' })                                                 // not a customer query -> excluded
  ]);
  const q = X.attentionQueue(t, NOW, 'urgency');
  assert.equal(q.length, 4, 'a repeat customer appears once');
  assert.equal(q[0].ticket.subject, 'Re harami ke pila');
  assert.equal(q[0].attention.tone, 'red');
  assert.deepEqual(q.slice(1, 3).map(x => x.ticket.subject), ['Refund money', 'Refund please']);
  assert.equal(q[1].attention.tone, 'red', 'money waiting more than 72h turns red');
  assert.equal(q[2].attention.tone, 'green');
  assert.ok(q[3].attention.tags.includes('Repeat ×3'));
  assert.equal(X.filterTickets(t, { flagged: 'yes' }, NOW).length, 4, 'flagged filter matches the queue');
});

test('14-day period and no-reply waiting over 24h', () => {
  const d = dash([
    rawTicket({ createdTime: '2026-10-04T05:00:00Z' }),                     // 13 days ago IST -> inside 14d
    rawTicket({ createdTime: '2026-10-02T05:00:00Z' }),                     // outside 14d
    rawTicket({ createdTime: '2026-10-17T05:00:00Z', threadCount: '1' })    // today, no reply < 24h
  ], { period: '14d' });
  assert.equal(d.total, 2);
  assert.equal(d.noReplyYet, 2);
  assert.equal(d.noReplyOver24h, 1);
  assert.equal(d.createdToday, 1);
});

test('inbox: "Needs reply" means the customer spoke last; oldest waiting first', () => {
  const t = prepare([
    rawTicket({ subject: 'A', lastThread: { direction: 'in' }, customerResponseTime: '2026-10-16T05:00:00Z' }),
    rawTicket({ subject: 'B', lastThread: { direction: 'out' }, threadCount: '3' }),                       // we replied last
    rawTicket({ subject: 'C', lastThread: { direction: 'in' }, customerResponseTime: '2026-10-12T05:00:00Z' }),
    rawTicket({ subject: 'D', threadCount: '1' }),                                                          // no lastThread: first message only (waiting since 10 Oct)
    rawTicket({ subject: 'E', threadCount: '4' }),                                                          // no lastThread, unknown -> not counted
    rawTicket({ subject: 'F', channel: 'Phone', channelCode: null, lastThread: { direction: 'in' } }),     // agent-logged call
    rawTicket({ subject: 'G', lastThread: { direction: 'in' }, status: 'Closed', statusType: 'Closed' })
  ]);
  const q = X.inboxQueues(t, NOW);
  assert.deepEqual(q.reply.map(x => x.subject), ['D', 'C', 'A']);
  assert.equal(q.open.length, 6);
  assert.deepEqual(X.QUEUES.map(x => x.id), ['reply', 'followup', 'mine', 'flagged', 'open']);
});

test('next steps: every open ticket is replying, waiting with a date, overdue, or visibly in limbo', () => {
  const fu = (at, kind) => ({ active: true, at, kind: kind || 'customer', reason: 'Order ID or vehicle number', by: 'Asha', setAt: '2026-10-16T05:00:00Z' });
  const t = prepare([
    rawTicket({ subject: 'reply', lastThread: { direction: 'in' }, assigneeId: 'a1' }),
    rawTicket({ subject: 'due', lastThread: { direction: 'out' }, threadCount: '3', status: 'On Hold', statusType: 'On Hold', followUp: fu('2026-10-17T04:00:00Z'), assigneeId: 'a1' }),
    rawTicket({ subject: 'waiting', lastThread: { direction: 'out' }, threadCount: '3', status: 'On Hold', statusType: 'On Hold', followUp: fu('2026-10-18T05:30:00Z', 'external') }),
    rawTicket({ subject: 'limbo', lastThread: { direction: 'out' }, threadCount: '3', assigneeId: 'a1' }),
    rawTicket({ subject: 'call', channel: 'Phone', channelCode: 'PHONE' }),
    rawTicket({ subject: 'done', status: 'Closed', statusType: 'Closed', followUp: fu('2026-10-16T04:00:00Z') }),
    // A customer writing on an on-hold ticket puts it back in "Needs reply", whatever the follow-up says.
    rawTicket({ subject: 'came back', lastThread: { direction: 'in' }, status: 'On Hold', statusType: 'On Hold', followUp: fu('2026-10-18T05:30:00Z') })
  ]);
  const by = s => t.find(x => x.subject === s);
  assert.deepEqual(['reply', 'due', 'waiting', 'limbo', 'call', 'came back'].map(s => X.nextStep(by(s), NOW).state), ['reply', 'due', 'waiting', 'none', 'none', 'reply']);
  assert.equal(X.nextStep(by('done'), NOW), null);
  assert.equal(X.nextStep(by('waiting'), NOW).label, 'Waiting on traffic dept or bank');
  const q = X.inboxQueues(t, NOW, { me: 'a1' });
  assert.deepEqual(q.reply.map(x => x.subject), ['reply', 'came back']);
  assert.deepEqual(q.followup.map(x => x.subject), ['due', 'limbo', 'call'], 'overdue first, then tickets with no next step');
  assert.deepEqual(q.mine.map(x => x.subject), ['reply', 'due', 'limbo']);
  assert.deepEqual(X.inboxQueues(t, NOW).mine, [], 'no "Mine" without knowing who you are');
  const control = X.overview(t, { period: 'all' }, { now: NOW, coverage: WITH_CLOSED }).control;
  assert.deepEqual([control.reply, control.due, control.none, control.waiting], [2, 1, 2, 1]);
  assert.deepEqual(control.waitingKinds, { external: 1 });
});

// ── Overview ──
function ov(raws, filters, coverage) {
  return X.overview(prepare(raws), filters || {}, { now: NOW, coverage: coverage || WITH_CLOSED });
}

test('overview: new tickets compare with the previous period only when it has enough tickets', () => {
  const current = Array.from({ length: 12 }, () => rawTicket({ createdTime: '2026-10-15T06:00:00Z' }));
  const earlier = Array.from({ length: 10 }, () => rawTicket({ createdTime: '2026-10-08T06:00:00Z' }));
  const o = ov(current.concat(earlier), { period: '7d' });
  assert.equal(o.newTickets.count, 12);
  assert.equal(o.newTickets.previous, 10);
  assert.equal(o.newTickets.change, 0.2);
  const few = ov(current.concat(earlier.slice(0, 9)), { period: '7d' });
  assert.equal(few.newTickets.change, null, 'fewer than 10 earlier tickets: no % change');
  assert.equal(ov(current, { period: 'all' }).newTickets.change, null, 'all time has nothing to compare with');
});

test('overview: waiting, open and closed are measured the way agents see them', () => {
  const raws = [
    // customer spoke last 2h ago (waiting), assigned
    rawTicket({ createdTime: '2026-10-16T06:00:00Z', customerResponseTime: '2026-10-17T04:30:00Z', lastThread: { direction: 'in' }, threadCount: '3', assigneeId: 'a1' }),
    // customer spoke last 2 days ago (waiting), unassigned
    rawTicket({ createdTime: '2026-10-13T06:00:00Z', customerResponseTime: '2026-10-15T06:30:00Z', lastThread: { direction: 'in' }, threadCount: '2' }),
    // we replied last: open but not waiting
    rawTicket({ createdTime: '2026-10-15T06:00:00Z', lastThread: { direction: 'out' }, threadCount: '2', assigneeId: 'a1' }),
    // chat closed yesterday after 10 hours
    rawTicket({ createdTime: '2026-10-15T20:00:00Z', status: 'Closed', statusType: 'Closed', closedTime: '2026-10-16T06:00:00Z', assigneeId: 'a1' }),
    // phone call log, closed at once: a call log, not a closed chat
    rawTicket({ createdTime: '2026-10-16T05:00:00Z', status: 'Closed', statusType: 'Closed', closedTime: '2026-10-16T05:01:00Z', channel: 'Phone', channelCode: 'PHONE', assigneeId: 'a1' }),
    // created long ago, closed inside the period: counts as closed in the period
    rawTicket({ createdTime: '2026-09-25T06:00:00Z', status: 'Closed', statusType: 'Closed', closedTime: '2026-10-14T06:00:00Z' })
  ];
  const o = ov(raws, { period: '7d' });
  assert.equal(o.waiting.count, 2);
  assert.deepEqual(o.waiting.buckets.filter(b => b.count).map(b => b.id), ['1to4h', '1to3d']);
  assert.equal(o.waiting.over24h, 1);
  assert.equal(o.open.count, 3);
  assert.equal(o.open.unassigned, 1);
  assert.equal(o.closed.count, 2, 'chats and emails closed in the period, by closed date');
  assert.equal(o.closed.callLogs, 1);
  assert.equal(o.closed.medianHours, (10 + 19 * 24) / 2);
  const team = o.team;
  assert.equal(team[0].unassigned, true, 'unassigned row first');
  const a1 = team.find(r => r.id === 'a1');
  assert.deepEqual([a1.open, a1.waiting, a1.closed, a1.callLogs], [2, 1, 1, 1]);
  const phone = o.channels.find(c => c.id === 'phone');
  assert.equal(phone.callLog, true);
  assert.equal(phone.medianCloseHours, null);
});

test('overview: first response comes from Zoho metrics, and "no reply yet" is not a fast reply', () => {
  const m = (min, responses) => ({ firstResponseMinutes: min, responseCount: responses, reopenCount: 0, reassignCount: 0 });
  const raws = [
    rawTicket({ createdTime: '2026-10-14T06:00:00Z', metrics: m(30, 1) }),
    rawTicket({ createdTime: '2026-10-14T06:00:00Z', metrics: m(300, 2) }),
    rawTicket({ createdTime: '2026-10-14T06:00:00Z', metrics: m(2000, 1) }),
    rawTicket({ createdTime: '2026-10-14T06:00:00Z', metrics: m(null, 0) }),
    rawTicket({ createdTime: '2026-10-17T05:00:00Z' }) // newer than 24h, metrics not loaded yet
  ];
  const fr = ov(raws, { period: '7d' }).firstResponse;
  assert.equal(fr.available, true);
  assert.equal(fr.medianMinutes, 300);
  assert.equal(fr.answered, 3);
  assert.equal(fr.notAnswered, 1);
  assert.equal(fr.within24h, 2 / 4, 'of tickets at least a day old, 2 answered within 24 h');
  assert.equal(fr.partial, true);
  assert.equal(ov([rawTicket()], { period: '7d' }).firstResponse.available, false);
});

test('overview: new vs closed per day, hourly for today', () => {
  const raws = [
    rawTicket({ createdTime: '2026-10-16T04:00:00Z' }),
    rawTicket({ createdTime: '2026-10-16T05:00:00Z', status: 'Closed', statusType: 'Closed', closedTime: '2026-10-17T05:00:00Z' }),
    rawTicket({ createdTime: '2026-10-17T03:10:00Z' }) // 08:40 IST today
  ];
  const week = ov(raws, { period: '7d' }).flow;
  assert.equal(week.granularity, 'day');
  assert.equal(week.buckets.length, 7);
  assert.deepEqual(week.buckets.slice(-2).map(b => [b.key, b.created, b.closed]), [['2026-10-16', 2, 0], ['2026-10-17', 1, 1]]);
  const today = ov(raws, { period: 'today' }).flow;
  assert.equal(today.granularity, 'hour');
  assert.equal(today.buckets.length, 13, '00:00 to 12:00 IST');
  assert.equal(today.buckets[8].created, 1);
  assert.equal(today.buckets[10].closed, 1, '05:00 UTC is 10:30 IST');
});

test('overview: arrivals by IST weekday and hour; repeat customers skip shared contacts', () => {
  const raws = [
    rawTicket({ createdTime: '2026-10-12T04:00:00Z', contactId: 'c-1' }), // Mon 09:30 IST
    rawTicket({ createdTime: '2026-10-12T04:20:00Z', contactId: 'c-1' }), // Mon 09:50 IST
    rawTicket({ createdTime: '2026-10-11T19:00:00Z', contactId: 'c-2' })  // Mon 00:30 IST
  ];
  const o = ov(raws, { period: '7d' });
  assert.equal(o.arrivals.grid[0][9], 2);
  assert.equal(o.arrivals.grid[0][0], 1);
  assert.deepEqual(o.arrivals.peak, { day: 0, hour: 9, count: 2 });
  assert.equal(o.repeat.customers, 2);
  assert.equal(o.repeat.repeatCustomers, 1);
  assert.equal(o.repeat.top[0].contactId, 'c-1');
});

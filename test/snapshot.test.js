const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/ticket-model');
const { rawTicket } = require('./fixtures');

test('rejects files that are not a ticket snapshot', () => {
  assert.equal(M.parseSnapshot(null).ok, false);
  assert.equal(M.parseSnapshot([]).ok, false);
  assert.equal(M.parseSnapshot('text').ok, false);
  const r = M.parseSnapshot({ fetchedAt: '2026-10-17T00:00:00Z' });
  assert.equal(r.ok, false);
  assert.match(r.error, /tickets/);
});

test('original (v1) snapshot is read as open tickets only', () => {
  const r = M.parseSnapshot({ fetchedAt: '2026-10-17T00:00:00Z', tickets: [rawTicket()], contacts: {}, agents: {} });
  assert.equal(r.ok, true);
  assert.equal(r.dataset.coverage.includesClosed, false);
  assert.equal(r.dataset.tickets.length, 1);
  assert.equal(r.dataset.fetchedAt.toISOString(), '2026-10-17T00:00:00.000Z');
});

test('v2 snapshot merges closed tickets, keeps Zoho IDs, and surfaces sync failures', () => {
  const open = rawTicket({ contactId: 'c1', assigneeId: 'a1' });
  const closed = rawTicket({ status: 'Closed', statusType: 'Closed', closedTime: '2026-10-12T00:00:00Z' });
  const r = M.parseSnapshot({
    schemaVersion: 2,
    fetchedAt: '2026-10-17T00:00:00Z',
    tickets: [open],
    closedTickets: [closed],
    contacts: { c1: { firstName: 'Asha', lastName: 'K', email: 'a@example.com', phone: '9000000000' } },
    agents: { a1: { id: 'a1', name: 'Ravi' } },
    sync: { closedLookbackDays: 90, closedCreatedSince: '2026-07-19T00:00:00Z', contactFailures: [{ contactId: 'c9', error: 'HTTP 404' }], agentsError: null }
  });
  assert.equal(r.ok, true);
  const ds = r.dataset;
  assert.equal(ds.coverage.includesClosed, true);
  assert.equal(ds.coverage.closedCreatedSince.toISOString(), '2026-07-19T00:00:00.000Z');
  assert.deepEqual(ds.tickets.map(t => t.id).sort(), [open.id, closed.id].sort());
  const t = ds.tickets.find(x => x.id === open.id);
  assert.equal(t.contact.name, 'Asha K');
  assert.equal(t.assigneeName, 'Ravi');
  assert.ok(ds.warnings.some(w => /1 contact/.test(w)), 'contact failures must be shown');
});

test('records without an ID are reported, not silently dropped', () => {
  const r = M.parseSnapshot({ fetchedAt: '2026-10-17T00:00:00Z', tickets: [rawTicket(), Object.assign(rawTicket(), { id: null })] });
  assert.equal(r.dataset.tickets.length, 1);
  assert.ok(r.dataset.warnings.some(w => /no Zoho ticket ID/.test(w)));
});

test('only Zoho Desk links are kept as ticket URLs', () => {
  assert.equal(M.normalizeTicket(rawTicket({ webUrl: 'javascript:alert(1)' })).webUrl, null);
  assert.match(M.normalizeTicket(rawTicket()).webUrl, /^https:\/\/desk\.zoho\.in\//);
});

test('a human correction overrides the suggestion and keeps full history', () => {
  const raw = rawTicket({ subject: 'Hi GaadiInfo Support' });
  const tickets = [M.normalizeTicket(raw)];
  let store = M.emptyCorrectionStore();

  let [t] = M.applyCategories(tickets, store);
  assert.equal(t.category, 'unclassified');
  assert.equal(t.categorySource, 'rules');

  store = M.addCorrection(store, raw.id, { category: 'refund_cancellation', previous: 'unclassified', at: '2026-10-17T05:00:00Z', by: 'Priya', note: 'Asked for refund in chat' });
  [t] = M.applyCategories(tickets, store);
  assert.equal(t.category, 'refund_cancellation');
  assert.equal(t.categorySource, 'human');
  assert.equal(t.autoClassification.category, 'unclassified', 'original suggestion is preserved');
  assert.ok(t.reviewReasons.some(r => /Refund/.test(r)));

  store = M.addCorrection(store, raw.id, { category: null, previous: 'refund_cancellation', at: '2026-10-17T06:00:00Z', by: 'Priya' });
  [t] = M.applyCategories(tickets, store);
  assert.equal(t.category, 'unclassified', 'reset returns to the automatic suggestion');
  assert.equal(t.categoryHistory.length, 2, 'history keeps every change');
});

test('corrections reject unknown categories', () => {
  assert.throws(() => M.addCorrection(M.emptyCorrectionStore(), '1', { category: 'made_up', previous: 'unclassified', at: 'x' }));
});

test('review reasons flag sensitive, uncertain and repeat cases', () => {
  const raws = [
    rawTicket({ subject: 'Cease and Desist Notice- Unauthorised Use of Data' }),
    rawTicket({ subject: 'Hi', contactId: 'same', createdTime: '2026-10-10T06:00:00Z' }),
    rawTicket({ subject: 'Hi', contactId: 'same', createdTime: '2026-10-12T06:00:00Z' }),
    rawTicket({ subject: 'Hi', contactId: 'same', createdTime: '2026-10-11T06:00:00Z' }),
    rawTicket({ subject: 'Hi GaadiInfo Support bhi gadi ka chhalan clear kyon nahin hua paise bhi kat liya' })
  ];
  const t = M.applyCategories(raws.map(r => M.normalizeTicket(r)), M.emptyCorrectionStore());
  assert.ok(t[0].reviewReasons.includes('Legal or regulatory language'));
  assert.ok(t[2].reviewReasons.includes('Repeat contact (3 tickets)'), 'flag sits on the latest ticket');
  assert.ok(!t[1].reviewReasons.some(r => /Repeat/.test(r)) && !t[3].reviewReasons.some(r => /Repeat/.test(r)), 'only once per contact');
  assert.ok(t[4].reviewReasons.includes('Subject matches more than one category'));
});

test('a placeholder contact with many tickets is not treated as a repeat customer', () => {
  const raws = Array.from({ length: 25 }, () => rawTicket({ subject: 'Order status query', channel: 'Phone', channelCode: null, contactId: 'shared' }));
  const t = M.applyCategories(raws.map(r => M.normalizeTicket(r)), M.emptyCorrectionStore());
  assert.ok(t.every(x => x.sharedContact));
  assert.ok(t.every(x => !x.reviewCodes.includes('repeat')));
});

test('customer contact: record, search-embedded contact, or the ticket\'s own email / phone', () => {
  const fromRecord = M.normalizeTicket(rawTicket({ contactId: 'c1' }), { contacts: { c1: { lastName: 'Asha K', mobile: '+919000000001', email: 'a@example.com' } } });
  assert.deepEqual(fromRecord.contact, { name: 'Asha K', email: 'a@example.com', phone: '+919000000001', phones: ['+919000000001'] });
  const fromSearch = M.normalizeTicket(rawTicket({ contactId: 'c2', contact: { lastName: 'Ravi', mobile: '+919000000002', phone: '011-2345' } }), {});
  assert.deepEqual(fromSearch.contact.phones, ['+919000000002', '011-2345']);
  const fromTicket = M.normalizeTicket(rawTicket({ contactId: 'c3', email: 'x@example.com', phone: '9000000003' }), {});
  assert.equal(fromTicket.contact.name, null);
  assert.equal(fromTicket.contact.email, 'x@example.com');
  assert.equal(M.normalizeTicket(rawTicket({ contactId: 'c4' }), {}).contact, null);
  const t = M.applyCategories([fromRecord], M.emptyCorrectionStore())[0];
  assert.ok(t.searchText.includes('9000000001'), 'search by phone without the country code');
});

test('who spoke last comes from Zoho lastThread', () => {
  assert.equal(M.normalizeTicket(rawTicket({ lastThread: { direction: 'in' } })).lastThreadDirection, 'in');
  assert.equal(M.normalizeTicket(rawTicket()).lastThreadDirection, null);
});

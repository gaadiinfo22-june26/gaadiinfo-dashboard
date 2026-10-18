const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/taxonomy');
const M = require('../src/ticket-model');

const cls = s => M.classifySubject(s);

test('taxonomy: every rule points at a real category and ids are unique', () => {
  const ids = T.CATEGORIES.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length);
  T.RULES.forEach(r => assert.ok(ids.includes(r.category), `rule for unknown category ${r.category}`));
  T.TIE_BREAK_ORDER.forEach(id => assert.ok(ids.includes(id)));
  assert.ok(ids.includes(T.UNCLASSIFIED));
});

test('subjects map to the expected category (English and Hinglish)', () => {
  const cases = [
    ['Order status query', 'challan_status'],
    ['Mera challan pay nai hua hai', 'challan_status'],
    ['challan clear nahi  hua h abhi tak', 'challan_status'],
    ['Pending show kr rha hai', 'challan_status'],
    ['Yah chalan kab clear hoga', 'challan_status'],
    ['Why my chllan not paid', 'challan_status'],
    ['Reg: e chellan payment paid but still pending', 'challan_status'],
    ['Mujhe challan ki details bata dijie', 'challan_details'],
    ['Recept', 'challan_details'],
    ['Sir deposit slip', 'challan_details'],
    ['Please refund my money as my challan is already paid.', 'refund_cancellation'],
    ['Paisa refund', 'refund_cancellation'],
    ['Urgent Cancellation and Refund Request', 'refund_cancellation'],
    ['UTR id 123456789012', 'payment_issue'],
    ['Payment issue', 'payment_issue'],
    ['Vehicle number mismatch on challan', 'challan_dispute'],
    ['72 ghante se jyada time ho gya hai', 'service_issue'],
    ['OTP not received on website', 'technical_issue'],
    ['Re harami ke pila', 'complaint'],
    ['Invoice - 1026270410259 from ZOHO Corporation Private Limited', 'not_customer_query'],
    ['New sign-in to your Zoho account', 'not_customer_query'],
    ['AUTO-TEST live feed verification 2', 'not_customer_query']
  ];
  cases.forEach(([subject, expected]) => {
    assert.equal(cls(subject).category, expected, `"${subject}"`);
  });
});

test('greetings and templates are not forced into a category', () => {
  ['Hi GaadiInfo Support', 'Hi, I need help with GaadiInfo', 'Hii', 'Hlo', 'Customer question',
    'Support Request', '(No Subject)', 'Hi GaadiInHlofo Support', 'Hi GaadiInfo hiiSupport'].forEach(s => {
    const c = cls(s);
    assert.equal(c.category, 'unclassified', s);
    assert.equal(c.unclassifiedReason, 'greeting', s);
    assert.equal(c.confidence, null);
  });
});

test('unclassified tickets record why', () => {
  assert.equal(cls('1892422655500431.jpeg').unclassifiedReason, 'attachment');
  assert.equal(cls('PB06AB1234').unclassifiedReason, 'reference');
  assert.equal(cls('Hi GaadiInfo Support, I need help with my challan order GI-2026-100001 for vehicle RJ14AB0001.').unclassifiedReason, 'reference');
  assert.equal(cls('Bulk Deal on Gaaddi info').unclassifiedReason, 'no_match');
  assert.equal(cls('').unclassifiedReason, 'no_subject');
});

test('competing evidence lowers confidence and lists alternatives', () => {
  const clear = cls('Paisa refund');
  assert.equal(clear.confidenceLabel, 'high');
  assert.deepEqual(clear.alternatives, []);

  const mixed = cls('Hi GaadiInfo Support bhi gadi ka chhalan clear kyon nahin hua paise bhi kat liya');
  assert.equal(mixed.category, 'payment_issue');
  assert.ok(mixed.alternatives.includes('challan_status'));
  assert.ok(mixed.confidence < clear.confidence);
});

test('a weak generic keyword does not override a strong one', () => {
  // "payment" alone is weak; "refund" is strong - not ambiguous.
  const c = cls('Refund my payment');
  assert.equal(c.category, 'refund_cancellation');
  assert.deepEqual(c.alternatives, []);
});

test('ties go to the higher-impact category', () => {
  const c = cls('Urgent: Status Update / Refund Request - Order ID: GI-2026-100002');
  assert.equal(c.category, 'refund_cancellation');
  assert.ok(c.alternatives.includes('challan_status'));
});

test('classification records its source and model', () => {
  const c = cls('Payment issue');
  assert.equal(c.source, 'rules');
  assert.equal(c.model, 'keyword-rules-v1');
  assert.ok(c.evidence.length > 0);
});

test('spam flag from Zoho wins over subject keywords', () => {
  const c = M.classifySubject('Refund now', { isSpam: true });
  assert.equal(c.category, 'not_customer_query');
});

test('entities are extracted from the subject', () => {
  const e = M.extractEntities('GI-2026-100003 Vehicle: HR26K1234 Challan: HR10000000000000001 UPI payment: ₹1,199.42 UTR 111122223333');
  assert.deepEqual(e.orders, ['GI-2026-100003']);
  assert.deepEqual(e.vehicles, ['HR26K1234']);
  assert.deepEqual(e.challans, ['HR10000000000000001']);
  assert.deepEqual(e.utrs, ['111122223333']);
  assert.deepEqual(e.amounts, [1199.42]);
  assert.deepEqual(M.extractEntities('mere challan ka kya hua? dl3cxy1234').vehicles, ['DL3CXY1234']);
  assert.deepEqual(M.extractEntities('Hi').vehicles, []);
});

test('status mapping uses Zoho status type, including custom statuses', () => {
  assert.equal(T.statusGroupFor('AUTO Closed No Response', 'Closed'), 'closed');
  assert.equal(T.statusGroupFor('AUTO Closed No Response', null), 'closed');
  assert.equal(T.statusGroupFor('Waiting on customer', 'On Hold'), 'on_hold');
  assert.equal(T.statusGroupFor('In Progress', 'Open'), 'open');
  assert.equal(T.statusGroupFor('Escalated', null), 'open');
  // Unknown statuses are treated as unresolved, never as done.
  assert.equal(T.statusGroupFor('Something new', null), 'open');
  assert.equal(T.statusGroupFor(null, null), 'open');
});

test('channel mapping covers both WhatsApp numbers and Zoho spellings', () => {
  assert.equal(T.channelFor('GaadiInfo Care', 'GAADI_INFO_CARE'), 'whatsapp');
  assert.equal(T.channelFor('Gaadi Info Cares', 'GAADI_INFO_CARES'), 'whatsapp');
  assert.equal(T.channelFor('GaadiInfo Care', null), 'whatsapp');
  assert.equal(T.channelFor('EMAIL', null), 'email');
  assert.equal(T.channelFor('Email', null), 'email');
  assert.equal(T.channelFor('Phone', null), 'phone');
  assert.equal(T.channelFor('Twitter', null), 'other');
  assert.equal(T.channelFor(null, null), 'other');
});

test('blank priority is "not set", not a real priority', () => {
  assert.equal(T.priorityFor(null), 'not_set');
  assert.equal(T.priorityFor(''), 'not_set');
  assert.equal(T.priorityFor('High'), 'high');
  assert.equal(T.priorityFor('not_set'), 'not_set');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/conversation');
const F = require('./zoho-im-fixtures');

const BOT = 'Complaint Received';
const WELCOME = 'Hi! Welcome to GaadiInfo support. What do you need help with?';

// Two WhatsApp sessions modelled on a real ticket (names and numbers made up).
const s1 = F.imThread('t1', '2026-10-06T15:27:09.051Z', [
  F.customerReply('Test Customer', '6 Oct, 3:27 PM GMT', 'Agent Asha', 'Good, Bad', 'Bad'),
  F.botOptions(BOT, '6 Oct, 3:27 PM GMT', WELCOME, ['Order Status', 'Other question']),
  F.customerReply('Test Customer', '6 Oct, 3:27 PM GMT', BOT, 'Order Status, Other question', 'Order Status'),
  F.botPrompt(BOT, '6 Oct, 3:27 PM GMT', 'Please send your vehicle number (for example DL3CAB1234)'),
  F.customerText('Test Customer', '6 Oct, 3:28 PM GMT', 'up32ab1234'),
  F.botPrompt(BOT, '6 Oct, 3:28 PM GMT', 'Thank you for contacting GaadiInfo! 🙏 *Your Challan Status* Vehicle: *UP32AB1234* *Order GI-2026-100777* (placed on 5 Oct) 1. Challan ending *123456* (online) Amount: ₹2,000 Statu...')
]);
const s2 = F.imThread('t2', '2026-10-07T13:03:23.732Z', [
  F.customerText('Test Customer', '7 Oct, 1:03 PM GMT', 'Sar 48 ghante ho gaye challan pay nahin hua, my payment refund kar do'),
  F.botRichText(BOT, '7 Oct, 1:03 PM GMT', 'Thanks, we have noted your order. You can message us here any time for the latest status.')
]);
const raw = { items: [F.imItem(s2), F.imItem(s1)], threads: { t1: s1, t2: s2 } };

test('parses a WhatsApp transcript into messages with sides, times and buttons', () => {
  const msgs = C.parseImTranscript(s1.content, { sessionStart: s1.createdTime });
  assert.equal(msgs.length, 6);
  assert.deepEqual(msgs.map(m => m.side), ['customer', 'business', 'customer', 'business', 'customer', 'business']);
  assert.equal(msgs[0].author, 'Test Customer');
  assert.equal(msgs[0].at, '2026-10-06T15:27:00.000Z');
  assert.deepEqual(msgs[0].quote, { author: 'Agent Asha', text: 'Good, Bad' });
  assert.equal(msgs[0].text, 'Bad');
  assert.equal(msgs[1].text, WELCOME);
  assert.deepEqual(msgs[1].options, ['Order Status', 'Other question']);
  assert.equal(msgs[2].text, 'Order Status');
  assert.equal(msgs[3].text, 'Please send your vehicle number (for example DL3CAB1234)', 'input box removed');
  assert.equal(msgs[5].truncated, true, 'Zoho cut the status text short');
});

test('transcript times without a year take the session year, including across New Year', () => {
  assert.equal(C.parseTranscriptTime('7 Oct, 1:03 PM GMT', '2026-10-07T13:03:00Z').toISOString(), '2026-10-07T13:03:00.000Z');
  assert.equal(C.parseTranscriptTime('31 Dec, 11:59 PM GMT', '2027-01-01T00:05:00Z').toISOString(), '2026-12-31T23:59:00.000Z');
  assert.equal(C.parseTranscriptTime('7 Oct, 12:15 AM GMT', '2026-10-07T00:00:00Z').toISOString(), '2026-10-07T00:15:00.000Z');
  assert.equal(C.parseTranscriptTime('nonsense', '2026-10-07T00:00:00Z'), null);
});

test('builds one ordered conversation from several sessions and labels bot vs agent', () => {
  const conv = C.buildConversation(raw, { agents: {} });
  assert.equal(conv.sessions, 2);
  assert.equal(conv.messages.length, 8);
  assert.equal(conv.messages[0].text, 'Bad', 'oldest first even though Zoho lists newest first');
  assert.ok(conv.messages.filter(m => m.side === 'business').every(m => m.role === 'bot'));
  const withAgent = C.buildConversation(raw, { agents: { a: { name: 'Complaint Received' } } });
  assert.ok(withAgent.messages.filter(m => m.side === 'business').every(m => m.role === 'agent'));
});

test('repeated boundary messages across sessions are kept once', () => {
  const dup = F.imThread('t3', '2026-10-07T13:03:30Z', [
    F.customerText('Test Customer', '7 Oct, 1:03 PM GMT', 'Sar 48 ghante ho gaye challan pay nahin hua, my payment refund kar do')
  ]);
  const conv = C.buildConversation({ items: raw.items.concat(F.imItem(dup)), threads: Object.assign({ t3: dup }, raw.threads) }, {});
  assert.equal(conv.messages.length, 8);
});

test('a session that could not be fetched is reported, not silently skipped', () => {
  const conv = C.buildConversation({ items: raw.items, threads: { t1: s1 } }, {});
  assert.equal(conv.warnings.length, 1);
  assert.match(conv.warnings[0], /t2/);
});

test('email threads become one message each with quoted history removed', () => {
  const items = [
    { id: 'e2', type: 'thread', createdTime: '2026-10-09T16:24:08Z', direction: 'out', channel: 'EMAIL', author: { name: 'Agent Asha', type: 'AGENT' },
      summary: 'Hello, your order GI-2026-100888 for vehicle BR01AB1234 is with us. Our team is checking the status...' },
    { id: 'e1', type: 'thread', createdTime: '2026-10-09T13:26:20Z', direction: 'in', channel: 'EMAIL', author: { name: 'Customer', type: 'END_USER' },
      fromEmailAddress: '"Test Customer"<c@example.com>',
      summary: 'Challan pay kiye the clear nhi hua On Fri, Oct 9, 2026, 9:41 PM Customer <c@example.com> wrote: older text' }
  ];
  const conv = C.buildConversation({ items, threads: {} }, {});
  assert.deepEqual(conv.messages.map(m => [m.side, m.role]), [['customer', 'customer'], ['business', 'agent']]);
  assert.equal(conv.messages[0].text, 'Challan pay kiye the clear nhi hua');
  assert.equal(conv.messages[0].author, 'Test Customer', 'display name from the From address');
  const facts = C.conversationFacts(conv, {});
  assert.match(C.summarise(facts, {}), /contacted us on chat once/, 'our own email is not counted as a customer contact');
  assert.match(C.summarise(facts, {}), /Agent Asha sent an order update/);
  assert.equal(conv.messages[1].truncated, true, 'only the summary was available');
});

test('call notes on phone tickets are internal, comments are notes', () => {
  const items = [
    { id: 'd1', type: 'thread', isDescriptionThread: true, createdTime: '2026-10-07T05:58:14Z', direction: 'in', channel: 'WEB', author: { name: 'staff', type: 'END_USER' }, summary: 'Customer called about refund' },
    { id: 'c1', type: 'comment', commentedTime: '2026-10-07T06:00:00Z', commenter: { name: 'Agent Asha' }, content: '<div>Checked with <b>payments</b></div>' }
  ];
  const conv = C.buildConversation({ items, threads: {} }, { ticket: { channel: 'phone' } });
  assert.deepEqual(conv.messages.map(m => m.role), ['note', 'note']);
  assert.equal(conv.messages[1].text, 'Checked with payments');
});

test('entities come from the whole conversation, ignoring the bot\'s example number', () => {
  const conv = C.buildConversation(raw, {});
  const e = C.conversationEntities(conv.messages);
  assert.deepEqual(e.vehicles, ['UP32AB1234']);
  assert.deepEqual(e.orders, ['GI-2026-100777']);
  assert.deepEqual(e.challanEndings, ['123456']);
  assert.deepEqual(e.amounts, [2000]);
  const more = C.conversationEntities([{ side: 'customer', text: 'Refund to UPI 9123456780@ybl, call me on +91 9876543210. Email me at a.b@gmail.com' }]);
  assert.deepEqual(more.upiIds, ['9123456780@ybl']);
  assert.deepEqual(more.phones, ['9876543210'], 'UPI digits are not repeated as a phone number');
});

test('facts: picks, rating, bot status, no human reply, and a category from what the customer wrote', () => {
  const conv = C.buildConversation(raw, {});
  const facts = C.conversationFacts(conv, { now: new Date('2026-10-17T13:03:00Z') });
  assert.equal(facts.customerName, 'Test Customer');
  assert.deepEqual(facts.picks, ['Order Status']);
  assert.equal(facts.rating, 'Bad');
  assert.ok(facts.statusShared && facts.statusShared.truncated && facts.statusShared.role === 'bot');
  assert.equal(facts.humanReplied, false);
  assert.equal(facts.waitingSince, '2026-10-06T15:27:00.000Z');
  assert.equal(facts.suggestion.category, 'refund_cancellation');
  const text = C.summarise(facts, { channelLabel: 'WhatsApp' });
  assert.match(text, /vehicle UP32AB1234/);
  assert.match(text, /order GI-2026-100777/);
  assert.match(text, /No agent has replied yet/);
  assert.match(text, /rated an earlier chat “Bad”/);
});

test('facts: an agent reply followed by new customer messages means still waiting', () => {
  const messages = [
    { side: 'customer', role: 'customer', author: 'C', at: '2026-10-09T10:00:00Z', text: 'Refund please', quote: null },
    { side: 'business', role: 'agent', author: 'Agent Asha', at: '2026-10-09T11:00:00Z', text: 'Checking', quote: null },
    { side: 'customer', role: 'customer', author: 'C', at: '2026-10-10T09:00:00Z', text: 'Any update?', quote: null }
  ];
  const facts = C.conversationFacts({ messages, sessions: 3 }, { now: new Date('2026-10-10T21:00:00Z') });
  assert.equal(facts.humanReplied, true);
  assert.equal(facts.waitingForHuman, true);
  assert.equal(Math.round(facts.waitingHours), 12);
  assert.match(C.summarise(facts, {}), /has been waiting 12 hours/);
});

test('html to text keeps line breaks and decodes entities', () => {
  assert.equal(C.htmlToText('<p>Hello &amp; welcome</p><div>Line&nbsp;2<br>Line 3</div>'), 'Hello & welcome\nLine 2\nLine 3');
  assert.equal(C.htmlToText('<script>alert(1)</script>Safe'), 'Safe');
});

test('automated feedback replies sent under an agent\'s name are not a human reply', () => {
  const s = F.imThread('t9', '2026-10-06T15:27:00Z', [
    F.customerReply('Test Customer', '6 Oct, 3:27 PM GMT', 'Agent Asha', 'Good, Bad', 'Bad'),
    F.businessText('Agent Asha', '6 Oct, 3:27 PM GMT', 'Sorry! we let you down.'),
    F.businessText('Agent Asha', '6 Oct, 3:40 PM GMT', 'Hi, I am checking your order now.')
  ]);
  const conv = C.buildConversation({ items: [F.imItem(s)], threads: { t9: s } }, { agents: { a1: { name: 'Agent Asha' } } });
  assert.deepEqual(conv.messages.map(m => m.role), ['customer', 'bot', 'agent']);
  const facts = C.conversationFacts(conv, { now: new Date('2026-10-06T16:00:00Z') });
  assert.equal(facts.humanReplied, true);
  assert.equal(facts.lastAgent.text, 'Hi, I am checking your order now.');
});

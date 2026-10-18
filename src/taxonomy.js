/**
 * taxonomy.js
 * Single source of truth for ticket categories, status / channel / priority
 * mappings, and the keyword rules used to suggest a category from a subject.
 *
 * Change labels, mappings or rules here only - the dashboard, metrics and
 * tests all read from this file.
 *
 * Loaded as a classic <script> in the browser (exposes window.GI.taxonomy) and
 * via require() in Node (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GI = root.GI || {};
    root.GI.taxonomy = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Reporting timezone ──
  // All "per day" and date-range calculations use India Standard Time.
  // IST has no daylight saving, so a fixed offset is exact.
  const TIMEZONE = { id: 'Asia/Kolkata', label: 'IST', offsetMinutes: 330 };

  // ── Query categories ──
  // Display order. `reviewReason` marks categories that should always get a human look.
  const CATEGORIES = [
    { id: 'challan_details', label: 'Challan details or copy',
      description: 'Customer wants challan details, a copy, a photo, or a receipt / proof of payment.' },
    { id: 'challan_status', label: 'Challan status',
      description: 'Customer asks whether a challan they paid has been settled, or when it will clear.' },
    { id: 'refund_cancellation', label: 'Refund or cancellation',
      description: 'Customer asks for money back or to cancel an order.',
      reviewReason: 'Refund or cancellation request (money involved)' },
    { id: 'payment_issue', label: 'Payment or transaction issue',
      description: 'Payment failed, was deducted without confirmation, or needs a transaction check (UTR).',
      reviewReason: 'Payment problem (money involved)' },
    { id: 'challan_dispute', label: 'Challan correction or dispute',
      description: 'Challan or vehicle details are wrong, or the customer disputes the challan.',
      reviewReason: 'Disputed challan' },
    { id: 'service_issue', label: 'Service or fulfilment issue',
      description: 'GaadiInfo has not delivered what was expected - delays, work not done.' },
    { id: 'account_details', label: 'Account or customer details',
      description: 'Change or confirm mobile number, email, name or account details.' },
    { id: 'technical_issue', label: 'Technical issue',
      description: 'Website / app errors, OTP problems, pages not loading.' },
    { id: 'complaint', label: 'Complaint',
      description: 'Customer is unhappy with the service, uses abusive language, or alleges fraud.',
      reviewReason: 'Complaint or negative feedback' },
    { id: 'not_customer_query', label: 'Not a customer query',
      description: 'Vendor or system emails, rating replies, internal test tickets, spam.' },
    { id: 'unclassified', label: 'Other / unclassified',
      description: 'The subject does not say enough to pick a category. Read the conversation to classify.' }
  ];

  const UNCLASSIFIED = 'unclassified';

  // Why a ticket could not be classified from its subject.
  const UNCLASSIFIED_REASONS = {
    greeting: 'Greeting or template only',
    attachment: 'Image or attachment only',
    reference: 'Order / vehicle / challan number only',
    no_subject: 'No subject',
    no_match: 'No recognised keywords'
  };

  // ── Classification rules (subject text) ──
  // Weight is the confidence the rule alone gives (0-1). Patterns run against a
  // lower-cased subject with whitespace collapsed. Hinglish spellings are
  // included because most WhatsApp subjects are written that way.
  const CH = 'ch+[aeh]*l+[aeh]*n?s?'; // challan, chalan, chllan, chhalan, challen, chaln, challa...
  const STRONG = 0.85;
  const MEDIUM = 0.7;
  const WEAK = 0.6;

  function rule(category, weight, pattern, label) {
    return { category, weight, pattern, label };
  }

  const RULES = [
    // Not a customer query - vendor / system mail, tests, rating replies
    rule('not_customer_query', 0.95, /\bauto-test\b|\bdummy ticket\b/, 'test ticket'),
    rule('not_customer_query', 0.9, /\b(invoice|subscription|sign-in)\b.*\bzoho\b|\bzoho\b.*\b(invoice|subscription|sign-in|corporation)\b|\bzoho enters\b|zoho voice call log/, 'Zoho system email'),
    rule('not_customer_query', 0.9, /\bclaude (platform|startups)\b|add credits to start building/, 'vendor email'),
    rule('not_customer_query', 0.9, /here's your first ticket|your opinion matters|has rated for you/, 'system / rating email'),
    rule('not_customer_query', 0.85, /\{(new ticket received|ticket resolved)\}|\[#\d+\]/, 'vendor support ticket'),
    rule('not_customer_query', WEAK, /^(good|solved|excellent|nice|thanks|thank you|thank u|ok|okay)[.! ]*$/, 'rating or acknowledgement reply'),

    // Complaint
    rule('complaint', STRONG, /\b(fraud|scam|cheat(ed|ing|er)?|froud|worst|pathetic|useless|harass\w*|bakwas|bekar|kharab|harami|loot)\b/, 'complaint language'),
    rule('complaint', MEDIUM, /\bcomplain(t|ts)?\b/, '"complaint"'),
    rule('complaint', WEAK, /^bad[.! ]*$/, 'negative rating reply'),

    // Refund or cancellation
    rule('refund_cancellation', STRONG, /\brefund(s|ed)?\b|\brefand\b/, '"refund"'),
    rule('refund_cancellation', STRONG, /\bcancel(l?ation|led|)?\b/, '"cancel"'),
    rule('refund_cancellation', STRONG, /\b(return|wapas|vapas|vapis|wapis)\b.*\b(money|paisa|paise|payment|amount)\b|\b(money|paisa|paise|payment|amount)\b.*\b(return|wapas|vapas|vapis|wapis|back)\b/, 'money back'),

    // Payment or transaction issue
    rule('payment_issue', STRONG, /\bpayment (failed|fail|issue|problem|pending|panding|stuck|not (done|completed|successful|received))\b/, 'payment problem'),
    rule('payment_issue', STRONG, /\b(deducted|debited|debit|kat (liya|gaya|gya|liye))\b/, 'amount deducted'),
    rule('payment_issue', STRONG, /\butr\b|\btransaction\b|\btxn\b/, 'transaction reference'),
    rule('payment_issue', STRONG, /\bdouble (payment|charged?)\b|\bpaid twice\b|\b2 baar\b/, 'double payment'),
    rule('payment_issue', MEDIUM, /\bconfirm\b.*\bpa[a-z]*m[a-z]*nt\b|\bverify\b.*\bpayment\b/, 'payment confirmation'),
    rule('payment_issue', 0.55, /\bpayment\b/, '"payment"'), // weak on its own: most "payment" subjects are status questions

    // Challan correction or dispute
    rule('challan_dispute', STRONG, new RegExp('\\b(wrong|incorrect|galat|mismatch|not mine|not my (vehicle|gaadi|car|bike)|dispute|correction)\\b'), 'wrong / disputed details'),

    // Challan status
    rule('challan_status', STRONG, /\border status\b|\bstatus\b.*\border\b/, '"order status"'),
    rule('challan_status', STRONG, new RegExp('\\b' + CH + ' status\\b|\\bstatus\\b'), '"status"'),
    rule('challan_status', STRONG, /\bnot (yet )?(cleared|clear|updated|showing|reflect\w*|disposed?|settled|paid)\b|\btill now\b|\bstill (pending|panding|showing|not)\b/, 'not cleared / updated'),
    rule('challan_status', STRONG, /\b(clear|pay|paid|settle)\s+(nahi|nhi|nai|nahin)\b|\b(nahi|nhi|nai)\s+(hua|huya|hui|hoga)\b|\b(pay|clear|paid)\s+(nahi|nhi|nai)\s+hua\b/, '"nahi hua" (not done)'),
    rule('challan_status', MEDIUM, /\b(pending|panding|pe ?ding|processing|prosecing|dispose)\b/, '"pending"'),
    rule('challan_status', MEDIUM, /\bsettle(d|ment)?\b|\bsettel\b|\bclear(ed)?\b/, 'settle / clear'),
    rule('challan_status', MEDIUM, /\bkab\b|\bkya hua\b|\bhua (kya|ya nahi)\b|\bpay or not\b|\btimeline\b|\bhow (much|many) time\b|\bkitna time\b|\bwhen (it )?will\b/, 'asks when / whether done'),
    rule('challan_status', MEDIUM, /\b(dikh|show)\s*(nahi|nhi|raha|rha|kar|kr)\b|\bshowing\b/, '"showing"'),
    rule('challan_status', MEDIUM, new RegExp('\\bbhar (gaya|gya|diya|diye)\\b|\\bupdate (my )?' + CH + '\\b'), 'asks if paid / updated'),
    rule('challan_status', WEAK, /^(please )?update[?!. ]*$|\bupdate\?/, 'asks for update'),

    // Challan details or copy
    rule('challan_details', STRONG, new RegExp('\\b' + CH + '( ki| ka| ke)? details?\\b|\\bdetails? (of|for) (my )?' + CH + '\\b'), '"challan details"'),
    rule('challan_details', STRONG, /\b(receipt|reciept|recept|recipient|deposit slip|slip|proof|pdf|copy)\b/, 'receipt / copy'),
    rule('challan_details', MEDIUM, new RegExp('\\b(photo|image|pic)\\b.*\\b' + CH + '\\b|\\bcheck ' + CH + '$'), 'challan lookup'),
    rule('challan_details', WEAK, /\bdetails?\b/, '"details"'),

    // Service or fulfilment issue
    rule('service_issue', MEDIUM, /\b(delay(ed)?|late)\b|\bghante se (jyada|zyada)\b|\b\d+\s*(din|days?)\s*(ho|se)\b|\bkaam (nahi|nhi|koi)\b|\bnot (settled|done) by you\b/, 'delay / not done'),

    // Account or customer details
    rule('account_details', MEDIUM, /\b(change|update|wrong)\b.*\b(mobile|phone|email|name)\b( number| no| id)?|\bmy account\b|\baccount (details|number)\b/, 'account details'),

    // Technical issue
    rule('technical_issue', MEDIUM, /\berror\b|\bnot working\b|\botp\b|\bcrash\w*\b|\bbug\b|\bnot (loading|opening)\b|\bunable to (pay|open|login|log in|download)\b|\bwebsite (down|not)\b/, 'error / not working')
  ];

  // Subjects that carry no information about the request (WhatsApp click-to-chat
  // templates, greetings, phone-call log templates).
  const GREETING_TOKENS = new Set([
    'hi', 'hii', 'hiii', 'hiiii', 'hihi', 'hello', 'helo', 'hllo', 'hlo', 'hlw', 'hey', 'hai', 'ho', 'hy',
    'sir', 'madam', 'mam', 'team', 'dear', 'please', 'pls', 'plz', 'i', 'need', 'help', 'with', 'me', 'my',
    'support', 'gaadiinfo', 'gaadi', 'info', 'good', 'morning', 'evening', 'afternoon', 'namaste',
    'customer', 'question', 'query', 'request', 'requests', 'another', 'other', 'sport', 'ji', 'a', 'the'
  ]);
  const TEMPLATE_SUBJECTS = new Set(['(no subject)', 'no subject', 'customer question', 'support request',
    'support requests', 'another query', 'other question', '.', '..', '...']);

  // Review triggers that are not tied to a category.
  const REVIEW_PATTERNS = [
    { code: 'legal', pattern: /cease and desist|legal notice|consumer (court|forum)|\blawyer\b|\badvocate\b|\bpolice\b|\bfir\b/, reason: 'Legal or regulatory language' },
    { code: 'urgent', pattern: /\burgent\b/, reason: 'Customer marked it urgent' }
  ];
  const REPEAT_CONTACT_THRESHOLD = 3;   // tickets from the same contact in the data
  // Above this, a "contact" is a shared placeholder rather than one customer -
  // e.g. phone calls logged in Zoho under a single default contact.
  const SHARED_CONTACT_THRESHOLD = 20;
  const LOW_CONFIDENCE_THRESHOLD = 0.6; // below this, a suggestion is shown as "uncertain"

  // ── Status ──
  // Zoho lets admins add custom statuses (e.g. "AUTO Closed No Response").
  // `statusType` (Open / On Hold / Closed) is authoritative when present;
  // otherwise the status name is matched. Unknown names count as unresolved so
  // that nothing is silently treated as done.
  const STATUS_GROUPS = {
    open: { label: 'Open', unresolved: true },
    on_hold: { label: 'On hold', unresolved: true },
    closed: { label: 'Closed', unresolved: false }
  };

  function statusGroupFor(status, statusType) {
    const type = (statusType || '').toLowerCase().replace(/[\s_-]+/g, '');
    if (type === 'closed') return 'closed';
    if (type === 'onhold') return 'on_hold';
    if (type === 'open') return 'open';
    const name = (status || '').toLowerCase();
    if (/\bclosed\b|\bresolved\b/.test(name)) return 'closed';
    if (/\bhold\b|\bwaiting\b/.test(name)) return 'on_hold';
    return 'open';
  }

  // ── Channels ──
  // "GaadiInfo Care" / "Gaadi Info Cares" are the two WhatsApp numbers connected
  // to Zoho as instant-message channels.
  const CHANNELS = {
    whatsapp: { label: 'WhatsApp', color: 'var(--channel-whatsapp)' },
    email: { label: 'Email', color: 'var(--channel-email)' },
    phone: { label: 'Phone', color: 'var(--channel-phone)' },
    web: { label: 'Web form', color: 'var(--channel-other)' },
    chat: { label: 'Chat', color: 'var(--channel-other)' },
    other: { label: 'Other', color: 'var(--channel-other)' }
  };
  const WHATSAPP_CHANNEL_CODES = new Set(['GAADI_INFO_CARE', 'GAADI_INFO_CARES']);

  function channelFor(channel, channelCode) {
    if (channelCode && WHATSAPP_CHANNEL_CODES.has(String(channelCode).toUpperCase())) return 'whatsapp';
    const c = (channel || '').toLowerCase();
    if (!c) return 'other';
    if (c.includes('whatsapp') || c.includes('gaadi info care') || c.includes('gaadiinfo care') || c === 'instant_message') return 'whatsapp';
    if (c.includes('email') || c.includes('mail')) return 'email';
    if (c.includes('phone') || c.includes('call')) return 'phone';
    if (c === 'web' || c.includes('web form') || c.includes('portal')) return 'web';
    if (c.includes('chat')) return 'chat';
    return 'other';
  }

  // ── Priority ──
  const PRIORITIES = {
    urgent: { label: 'Urgent', rank: 0 },
    high: { label: 'High', rank: 1 },
    medium: { label: 'Medium', rank: 2 },
    low: { label: 'Low', rank: 3 },
    not_set: { label: 'Not set', rank: 4 }
  };

  function priorityFor(priority) {
    const p = (priority || '').toLowerCase().trim();
    if (PRIORITIES[p] && p !== 'not_set') return p;
    return 'not_set';
  }

  // ── Backlog age buckets (open + on-hold tickets, by time since created) ──
  const AGE_BUCKETS = [
    { id: 'lt1d', label: 'Under 1 day', maxHours: 24 },
    { id: '1to3d', label: '1–3 days', maxHours: 72 },
    { id: '3to7d', label: '3–7 days', maxHours: 168 },
    { id: '7to14d', label: '1–2 weeks', maxHours: 336 },
    { id: 'gt14d', label: 'Over 2 weeks', maxHours: Infinity }
  ];

  // When two categories match with equal weight, the higher-impact one wins so
  // that money and complaint cases are routed for review rather than hidden.
  const TIE_BREAK_ORDER = ['not_customer_query', 'complaint', 'refund_cancellation', 'challan_dispute',
    'payment_issue', 'challan_status', 'challan_details', 'service_issue', 'technical_issue', 'account_details'];

  const CLASSIFIER = { source: 'rules', model: 'keyword-rules-v1', label: 'Keyword rules v1 (subject only)' };

  function categoryById(id) {
    return CATEGORIES.find(c => c.id === id) || null;
  }

  // ── Next steps (agent actions written back to Zoho; see server/actions.js) ──
  // Every waiting ticket says who we are waiting on and has a follow-up date.
  const WAIT_KINDS = {
    customer: { label: 'Waiting on customer', reasons: ['Order ID or vehicle number', 'Payment proof (UTR or screenshot)', 'Customer to confirm', 'Other'] },
    gaadiinfo: { label: 'Waiting on GaadiInfo team', reasons: ['Payment verification', 'Refund processing', 'Order correction', 'Tech issue', 'Other'] },
    external: { label: 'Waiting on traffic dept or bank', reasons: ['Traffic department or court', 'Payment gateway or bank', 'Other'] }
  };
  // Closing needs one of these plus a note. "Reply sent" is not a resolution.
  const RESOLUTIONS = [
    { id: 'settled', label: 'Challan settled — customer informed' },
    { id: 'refunded', label: 'Refund completed — customer informed' },
    { id: 'answered', label: 'Question answered' },
    { id: 'duplicate', label: 'Duplicate of another ticket', unansweredOk: true },
    { id: 'no_response', label: 'No reply from customer after follow-up' },
    { id: 'not_query', label: 'Not a customer query (spam, test, wrong number)', unansweredOk: true },
    { id: 'other', label: 'Other' }
  ];
  const ESCALATION_REASONS = ['Legal notice or threat', 'Abusive customer', 'Money deducted twice', 'Refund needs approval', 'Repeated follow-ups', 'Other'];

  return {
    TIMEZONE, CATEGORIES, UNCLASSIFIED, UNCLASSIFIED_REASONS, RULES, GREETING_TOKENS, TEMPLATE_SUBJECTS,
    REVIEW_PATTERNS, REPEAT_CONTACT_THRESHOLD, SHARED_CONTACT_THRESHOLD, LOW_CONFIDENCE_THRESHOLD,
    STATUS_GROUPS, statusGroupFor, CHANNELS, channelFor, PRIORITIES, priorityFor,
    AGE_BUCKETS, TIE_BREAK_ORDER, CLASSIFIER, categoryById,
    WAIT_KINDS, RESOLUTIONS, ESCALATION_REASONS
  };
});

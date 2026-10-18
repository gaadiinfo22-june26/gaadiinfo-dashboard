/**
 * metrics.js
 * Filters and dashboard aggregations over normalised tickets (see
 * ticket-model.js). Every number on the dashboard comes from computeDashboard()
 * and is described in METRIC_DEFINITIONS. Metrics the data cannot support are
 * returned as { available: false, reason } - never estimated.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./taxonomy'));
  } else {
    root.GI = root.GI || {};
    root.GI.metrics = factory(root.GI.taxonomy);
  }
})(typeof self !== 'undefined' ? self : this, function (T) {
  'use strict';

  const HOUR = 3600000;
  const DAY = 24 * HOUR;
  const OFFSET_MS = T.TIMEZONE.offsetMinutes * 60000;
  const SYNC_INTERVAL_MINUTES = 15; // .github/workflows/fetch-tickets.yml cron
  const STALE_AFTER_MISSED_RUNS = 3;
  const SLA_MIN_COVERAGE = 0.5;     // share of unresolved tickets that must have a due date

  // ── IST calendar helpers ──
  /** 'YYYY-MM-DD' of the instant in IST. */
  function dayKey(date) {
    return new Date(date.getTime() + OFFSET_MS).toISOString().slice(0, 10);
  }

  /** The UTC instant at which the given IST day starts. */
  function startOfDay(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d) - OFFSET_MS);
  }

  function addDays(key, n) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  function isDayKey(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
  }

  const PERIODS = [
    { id: 'today', label: 'Today' },
    { id: '7d', label: 'Last 7 days' },
    { id: '14d', label: 'Last 14 days' },
    { id: '30d', label: 'Last 30 days' },
    { id: '90d', label: 'Last 90 days' },
    { id: 'all', label: 'All time' },
    { id: 'custom', label: 'Custom range' }
  ];

  /**
   * Resolve a period to [start, end) instants. Day-based periods include today.
   * @returns {{id:string, start:Date|null, end:Date|null, label:string}}
   */
  function resolvePeriod(filters, now) {
    const id = (filters && filters.period) || 'all';
    const today = dayKey(now);
    const tomorrow = startOfDay(addDays(today, 1));
    const days = { today: 1, '7d': 7, '14d': 14, '30d': 30, '90d': 90 }[id];
    if (days) {
      return { id, start: startOfDay(addDays(today, -(days - 1))), end: tomorrow, label: PERIODS.find(p => p.id === id).label };
    }
    if (id === 'custom') {
      const from = isDayKey(filters.from) ? filters.from : null;
      const to = isDayKey(filters.to) ? filters.to : null;
      const lo = from && to && from > to ? to : from;
      const hi = from && to && from > to ? from : to;
      return {
        id,
        start: lo ? startOfDay(lo) : null,
        end: hi ? startOfDay(addDays(hi, 1)) : null,
        label: `${lo || 'start'} to ${hi || 'today'}`
      };
    }
    return { id: 'all', start: null, end: null, label: 'All time' };
  }

  // ── Filters ──
  const DEFAULT_FILTERS = {
    period: 'all', from: null, to: null,
    channel: 'all', category: 'all', status: 'all', priority: 'all', assignee: 'all', age: 'all',
    flagged: 'all', search: ''
  };

  function isUnresolved(t) {
    return T.STATUS_GROUPS[t.statusGroup].unresolved;
  }

  function ageBucketFor(t, now) {
    if (!t.createdAt) return null;
    const hours = (now - t.createdAt) / HOUR;
    return T.AGE_BUCKETS.find(b => hours < b.maxHours).id;
  }

  // ── Needs attention ──
  // Unresolved customer tickets with a review flag, ranked by risk. Flags that
  // only concern the category suggestion (uncertain / ambiguous) don't count.
  const MONEY_CATEGORIES = ['refund_cancellation', 'payment_issue', 'challan_dispute'];
  const ATTENTION_RED_AFTER_HOURS = 72;
  const TAGS = {
    'category:complaint': 'Complaint', 'category:refund_cancellation': 'Refund',
    'category:payment_issue': 'Payment', 'category:challan_dispute': 'Dispute',
    legal: 'Legal', urgent: 'Urgent'
  };

  /** @returns {{score:number, tone:'red'|'green', ageHours:number, tags:string[]}|null} */
  function attentionFor(t, now) {
    if (!isUnresolved(t) || t.category === 'not_customer_query') return null;
    const codes = (t.reviewCodes || []).filter(c => c !== 'uncertain' && c !== 'ambiguous');
    if (!codes.length) return null;
    const ageHours = t.createdAt ? (now - t.createdAt) / HOUR : 0;
    let score = 1;
    if (t.category === 'complaint' || codes.includes('legal')) score = 3;
    else if (MONEY_CATEGORIES.includes(t.category)) score = 2;
    const tone = score === 3 || (score === 2 && ageHours > ATTENTION_RED_AFTER_HOURS) ? 'red' : 'green';
    const tags = codes.map(c => c === 'repeat' ? `Repeat ×${t.contactTicketCount}` : TAGS[c]).filter(Boolean);
    return { score, tone, ageHours, tags };
  }

  /** Flagged tickets, most urgent first (or newest first). */
  function attentionQueue(tickets, now, sort) {
    const list = tickets.map(t => ({ ticket: t, attention: attentionFor(t, now) })).filter(x => x.attention);
    if (sort === 'newest') return list.sort((a, b) => (b.ticket.createdAt || 0) - (a.ticket.createdAt || 0));
    return list.sort((a, b) => b.attention.score - a.attention.score || b.attention.ageHours - a.attention.ageHours);
  }

  // ── Inbox queues (the agent's work list) ──
  /**
   * The customer is waiting on us: Zoho says the customer spoke last. Without
   * that signal, fall back to "only the customer's first message" (a minimum).
   * Phone tickets are logged by agents, so they never count.
   */
  function needsReply(t) {
    if (!isUnresolved(t) || t.category === 'not_customer_query' || t.channel === 'phone') return false;
    if (t.lastThreadDirection) return t.lastThreadDirection === 'in';
    return (t.channel === 'whatsapp' || t.channel === 'email') && t.threadCount !== null && t.threadCount <= 1;
  }

  /** When the customer started waiting: their latest message, else ticket creation. */
  function waitingSince(t) {
    return t.lastCustomerMessageAt || t.createdAt || null;
  }

  /**
   * What has to happen next on an open ticket:
   *   reply    the customer spoke last
   *   due      a follow-up date has passed
   *   waiting  waiting on someone, with a follow-up date still ahead
   *   none     nobody owes anyone anything - the ticket is in limbo
   */
  function nextStep(t, now) {
    if (!isUnresolved(t)) return null;
    if (needsReply(t)) return { state: 'reply', label: 'Reply to the customer', since: waitingSince(t) };
    if (t.followUp) {
      const kind = T.WAIT_KINDS[t.followUp.kind];
      const base = { at: t.followUp.at, kind: t.followUp.kind, reason: t.followUp.reason, by: t.followUp.by };
      return t.followUp.at <= now
        ? Object.assign({ state: 'due', label: 'Follow-up due' }, base)
        : Object.assign({ state: 'waiting', label: kind ? kind.label : 'Waiting' }, base);
    }
    return { state: 'none', label: 'No next step set' };
  }

  const QUEUES = [
    { id: 'reply', label: 'Needs reply' },
    { id: 'followup', label: 'Follow-ups' },
    { id: 'mine', label: 'Mine' },
    { id: 'flagged', label: 'Flagged' },
    { id: 'open', label: 'All open' }
  ];

  /**
   * @param {{me?:string}} [opts]  me = the agent's Zoho id, for "Mine"
   * @returns {{reply, followup, mine, flagged, open}} tickets per queue, in working order:
   *   reply    - longest waiting first, so nobody is left behind
   *   followup - overdue follow-ups (earliest first), then tickets with no next step (oldest first)
   *   mine     - my open tickets: replies, then due follow-ups, then no next step, then waiting
   *   flagged  - most urgent first (see attentionFor)
   *   open     - most recent customer activity first
   */
  function inboxQueues(tickets, now, opts) {
    const me = opts && opts.me;
    const time = d => (d ? d.getTime() : 0);
    const steps = new Map(tickets.map(t => [t.id, nextStep(t, now)]));
    const step = t => steps.get(t.id);
    const RANK = { reply: 0, due: 1, none: 2, waiting: 3 };
    const order = (a, b) => {
      const sa = step(a); const sb = step(b);
      if (RANK[sa.state] !== RANK[sb.state]) return RANK[sa.state] - RANK[sb.state];
      if (sa.state === 'reply') return time(waitingSince(a)) - time(waitingSince(b));
      if (sa.state === 'due' || sa.state === 'waiting') return time(sa.at) - time(sb.at);
      return time(a.lastCustomerMessageAt || a.createdAt) - time(b.lastCustomerMessageAt || b.createdAt);
    };
    const reply = tickets.filter(needsReply).sort((a, b) => time(waitingSince(a)) - time(waitingSince(b)));
    const followup = tickets.filter(t => { const s = step(t); return s && (s.state === 'due' || s.state === 'none'); }).sort(order);
    const mine = me ? tickets.filter(t => step(t) && t.assigneeId === me).sort(order) : [];
    const flagged = attentionQueue(tickets, now, 'urgency').map(x => x.ticket);
    const open = tickets.filter(t => isUnresolved(t)).sort((a, b) => time(waitingSince(b)) - time(waitingSince(a)));
    return { reply, followup, mine, flagged, open };
  }

  function matchesStatus(t, status) {
    if (status === 'all') return true;
    if (status === 'unresolved') return isUnresolved(t);
    return t.statusGroup === status;
  }

  /**
   * Apply dashboard filters. All filters combine with AND.
   * Tickets without a created time only appear when the period is "All time".
   */
  function filterTickets(tickets, filters, now) {
    const f = Object.assign({}, DEFAULT_FILTERS, filters || {});
    const period = resolvePeriod(f, now);
    const terms = String(f.search || '').toLowerCase().split(/\s+/).filter(Boolean);
    return tickets.filter(t => {
      if (period.start || period.end) {
        if (!t.createdAt) return false;
        if (period.start && t.createdAt < period.start) return false;
        if (period.end && t.createdAt >= period.end) return false;
      }
      if (f.channel !== 'all' && t.channel !== f.channel) return false;
      if (f.category !== 'all' && t.category !== f.category) return false;
      if (!matchesStatus(t, f.status)) return false;
      if (f.priority !== 'all' && t.priority !== f.priority) return false;
      if (f.assignee !== 'all') {
        if (f.assignee === 'unassigned' ? t.assigneeId : t.assigneeId !== f.assignee) return false;
      }
      if (f.age !== 'all' && (!isUnresolved(t) || ageBucketFor(t, now) !== f.age)) return false;
      if (f.flagged === 'yes' && !attentionFor(t, now)) return false;
      if (terms.length && !terms.every(term => (t.searchText || '').includes(term))) return false;
      return true;
    });
  }

  // ── Helpers ──
  function countBy(list, keyFn) {
    const m = new Map();
    list.forEach(item => {
      const k = keyFn(item);
      m.set(k, (m.get(k) || 0) + 1);
    });
    return m;
  }

  function median(values) {
    if (!values.length) return null;
    const s = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function ownerLabel(t) {
    if (!t.assigneeId) return 'Unassigned';
    return t.assigneeName || `Agent …${t.assigneeId.slice(-4)}`;
  }

  // ── Metric definitions (shown in the dashboard's "How numbers are calculated") ──
  const METRIC_DEFINITIONS = [
    { id: 'tickets', label: 'Tickets',
      text: 'Tickets created in the selected period that match the filters. Each Zoho ticket ID is counted once; duplicate records from the sync are removed. A reopened ticket keeps its original created date and is still one ticket.' },
    { id: 'unresolved', label: 'Open & unresolved',
      text: 'Tickets whose Zoho status type is Open or On hold. Custom statuses follow their status type (for example "AUTO Closed No Response" counts as closed). A status the dashboard does not recognise counts as unresolved, so nothing is silently treated as done.' },
    { id: 'unassigned', label: 'Unassigned',
      text: 'Unresolved tickets with no owner in Zoho.' },
    { id: 'no_reply', label: 'Waiting for a reply',
      text: 'Open WhatsApp and email tickets where the customer spoke last (Zoho\'s last-thread direction), measured now. Waiting time runs from the customer\'s latest message. When Zoho doesn\'t say who spoke last, only tickets holding just the customer\'s first message count. Phone tickets are excluded because agents log them, and so are tickets marked "Not a customer query".' },
    { id: 'closed', label: 'Closed',
      text: 'Tickets closed during the period (by closed date), whenever they were created. Phone tickets are counted separately as call logs: agents create and close them in the same minute after a call. Closed tickets are only in the data if they were created within the sync\'s lookback window.' },
    { id: 'time_to_close', label: 'Median time to close',
      text: 'Median of closed time minus created time, for WhatsApp and email tickets closed in the period. Includes time spent waiting on the customer. Reopened tickets are measured to their latest close. Phone call logs are left out because they are closed at once.' },
    { id: 'first_response', label: 'First response time',
      text: 'Zoho\'s first response time for each WhatsApp and email ticket created in the period: from creation to the first reply by an agent (bot messages don\'t count). The median covers tickets that have been answered; "answered within 24 h" covers tickets at least 24 hours old. Zoho may measure this in business hours if business hours are set up.' },
    { id: 'new_tickets', label: 'New tickets',
      text: 'Tickets created in the period. The comparison is with the period of the same length just before it, and is only shown when that earlier period has at least 10 tickets.' },
    { id: 'arrivals', label: 'When tickets arrive',
      text: 'Tickets created in the period by weekday and hour, in India Standard Time.' },
    { id: 'repeat_customers', label: 'Customers coming back',
      text: 'Customers (Zoho contacts) with two or more tickets created in the period. Shared contacts used for logged calls and tickets marked "Not a customer query" are left out.' },
    { id: 'sla', label: 'Overdue (Zoho due date)',
      text: 'Unresolved tickets past the due date Zoho set from its SLA policy. Only shown when most unresolved tickets have a due date.' },
    { id: 'category', label: 'Query type',
      text: 'An agent\'s correction if one exists, otherwise a suggestion from keyword rules on the ticket subject (English and Hinglish). When the subject gives no evidence - for example "Hi GaadiInfo Support" - the ticket stays "Other / unclassified" rather than being guessed.' },
    { id: 'daily', label: 'New tickets over time',
      text: 'Tickets by created date in India Standard Time (UTC+5:30). Days with no tickets show as zero. Periods longer than 92 days are grouped by week (weeks start Monday).' },
    { id: 'backlog_age', label: 'Backlog age',
      text: 'Unresolved tickets grouped by time since they were created, measured when the page loaded.' }
  ];

  // ── Availability of metrics that depend on what the data contains ──
  function availability(allTickets, coverage) {
    const unresolved = allTickets.filter(isUnresolved);
    const withDue = unresolved.filter(t => t.dueAt).length;
    const withPriority = allTickets.filter(t => t.priority !== 'not_set').length;
    const closedNote = coverage && coverage.capped
      ? 'Live mode loads only one page of tickets.'
      : 'The synced data has open tickets only. Set CLOSED_LOOKBACK_DAYS for the sync to include closed tickets.';
    return {
      closed: coverage && coverage.includesClosed && !coverage.capped
        ? { available: true }
        : { available: false, reason: closedNote },
      firstResponse: allTickets.some(t => t.metrics)
        ? { available: true }
        : { available: false, reason: 'Read from Zoho\'s ticket metrics by the workspace server once it is connected to Zoho (the scheduled GitHub sync doesn\'t fetch them).' },
      sla: unresolved.length && withDue / unresolved.length >= SLA_MIN_COVERAGE
        ? { available: true, withDue, unresolved: unresolved.length }
        : { available: false, reason: `Due dates are set on ${withDue} of ${unresolved.length} unresolved tickets, so SLA policies do not appear to be set up in Zoho.` },
      priority: withPriority
        ? { available: true }
        : { available: false, reason: `Priority is not set on any of the ${allTickets.length} tickets in Zoho.` }
    };
  }

  /** Is the "Tickets" total complete for this period and status filter, given what the data contains? */
  function completeness(period, coverage, status) {
    if (!coverage) return { complete: false, note: 'Data coverage unknown.' };
    if (coverage.capped) return { complete: false, note: 'Only the latest page of tickets is loaded.' };
    // Open / on-hold tickets are always fully synced; only closed ones may be missing.
    if (['unresolved', 'open', 'on_hold'].includes(status)) return { complete: true, note: null };
    if (!coverage.includesClosed) return { complete: false, note: 'Closed tickets are not in the data, so this counts open and on-hold tickets only.' };
    if (coverage.closedCreatedSince && (!period.start || period.start < coverage.closedCreatedSince)) {
      return { complete: false, note: `Closed tickets created before ${dayKey(coverage.closedCreatedSince)} are not in the data.` };
    }
    return { complete: true, note: null };
  }

  function dailySeries(filtered, period, now) {
    const dated = filtered.filter(t => t.createdAt);
    let fromKey = period.start ? dayKey(period.start) : null;
    let toKey = period.end ? addDays(dayKey(period.end), -1) : dayKey(now);
    if (!fromKey) {
      if (!dated.length) return { granularity: 'day', buckets: [] };
      fromKey = dayKey(new Date(Math.min.apply(null, dated.map(t => t.createdAt.getTime()))));
    }
    if (toKey < fromKey) toKey = fromKey;
    const counts = countBy(dated, t => dayKey(t.createdAt));
    const keys = [];
    for (let k = fromKey; k <= toKey; k = addDays(k, 1)) keys.push(k);

    if (keys.length <= 92) {
      return { granularity: 'day', buckets: keys.map(k => ({ key: k, start: k, end: k, count: counts.get(k) || 0 })) };
    }
    // Weekly buckets, Monday start
    const weeks = new Map();
    keys.forEach(k => {
      const dow = (new Date(k + 'T00:00:00Z').getUTCDay() + 6) % 7;
      const wk = addDays(k, -dow);
      const w = weeks.get(wk) || { key: wk, start: k, end: k, count: 0 };
      w.end = k;
      w.count += counts.get(k) || 0;
      weeks.set(wk, w);
    });
    return { granularity: 'week', buckets: Array.from(weeks.values()) };
  }

  /**
   * Everything the dashboard shows, computed from ticket records.
   * @param {Object[]} allTickets  Tickets after applyCategories()
   * @param {Object} filters
   * @param {{coverage:Object, now:Date}} ctx
   */
  function computeDashboard(allTickets, filters, ctx) {
    const now = ctx.now;
    const coverage = ctx.coverage;
    const f = Object.assign({}, DEFAULT_FILTERS, filters || {});
    const period = resolvePeriod(f, now);
    const filtered = filterTickets(allTickets, f, now);
    const unresolved = filtered.filter(isUnresolved);
    const avail = availability(allTickets, coverage);

    // Categories: every category listed, zeros included, so "none" is visible.
    const catCounts = countBy(filtered, t => t.category);
    const catOpen = countBy(unresolved, t => t.category);
    const byCategory = T.CATEGORIES.map(c => ({
      id: c.id,
      label: c.label,
      count: catCounts.get(c.id) || 0,
      unresolved: catOpen.get(c.id) || 0,
      share: filtered.length ? (catCounts.get(c.id) || 0) / filtered.length : 0
    }));
    const unclassifiedTickets = filtered.filter(t => t.category === T.UNCLASSIFIED);
    const reasonCounts = countBy(unclassifiedTickets, t => (t.categorySource === 'human' ? 'no_match' : t.autoClassification.unclassifiedReason) || 'no_match');
    const unclassifiedBreakdown = Object.keys(T.UNCLASSIFIED_REASONS)
      .map(id => ({ id, label: T.UNCLASSIFIED_REASONS[id], count: reasonCounts.get(id) || 0 }))
      .filter(r => r.count > 0);

    const channelCounts = countBy(filtered, t => t.channel);
    const byChannel = Object.keys(T.CHANNELS)
      .map(id => ({ id, label: T.CHANNELS[id].label, count: channelCounts.get(id) || 0 }))
      .filter(r => r.count > 0 || ['whatsapp', 'email'].includes(r.id));

    const statusCounts = countBy(filtered, t => t.status || '(no status)');
    const byStatus = Array.from(statusCounts.entries())
      .map(([status, count]) => ({ status, group: filtered.find(t => (t.status || '(no status)') === status).statusGroup, count }))
      .sort((a, b) => b.count - a.count);

    const prCounts = countBy(filtered, t => t.priority);
    const byPriority = Object.keys(T.PRIORITIES)
      .map(id => ({ id, label: T.PRIORITIES[id].label, count: prCounts.get(id) || 0 }))
      .filter(r => r.count > 0);

    const ownerMap = new Map();
    filtered.forEach(t => {
      const key = t.assigneeId || 'unassigned';
      const o = ownerMap.get(key) || { id: key, label: ownerLabel(t), total: 0, unresolved: 0 };
      o.total++;
      if (isUnresolved(t)) o.unresolved++;
      ownerMap.set(key, o);
    });
    const byOwner = Array.from(ownerMap.values()).sort((a, b) => b.unresolved - a.unresolved || b.total - a.total);

    const ageCounts = countBy(unresolved.filter(t => t.createdAt), t => ageBucketFor(t, now));
    const backlogAge = T.AGE_BUCKETS.map(b => ({ id: b.id, label: b.label, count: ageCounts.get(b.id) || 0 }));
    const oldest = unresolved.filter(t => t.createdAt).sort((a, b) => a.createdAt - b.createdAt)[0] || null;

    const noReplyEligible = unresolved.filter(t => (t.channel === 'whatsapp' || t.channel === 'email') && t.threadCount !== null);
    const noReplyTickets = noReplyEligible.filter(t => t.threadCount <= 1);
    const noReplyYet = noReplyTickets.length;
    const noReplyOver24h = noReplyTickets.filter(t => t.createdAt && now - t.createdAt > DAY).length;

    let closed = { available: false, reason: avail.closed.reason };
    let timeToClose = { available: false, reason: avail.closed.reason };
    if (avail.closed.available) {
      const closedTickets = filtered.filter(t => t.statusGroup === 'closed');
      const durations = closedTickets
        .filter(t => t.createdAt && t.closedAt && t.closedAt >= t.createdAt)
        .map(t => (t.closedAt - t.createdAt) / HOUR);
      closed = { available: true, count: closedTickets.length };
      timeToClose = durations.length
        ? { available: true, medianHours: median(durations), n: durations.length, excluded: closedTickets.length - durations.length }
        : { available: false, reason: 'No closed tickets with valid created and closed times match the filters.' };
    }

    let sla = { available: false, reason: avail.sla.reason };
    if (avail.sla.available) {
      const withDue = unresolved.filter(t => t.dueAt);
      sla = {
        available: true,
        overdue: withDue.filter(t => t.dueAt < now).length,
        withDue: withDue.length,
        withoutDue: unresolved.length - withDue.length
      };
    }

    const corrected = filtered.filter(t => t.categorySource === 'human').length;
    const uncertain = filtered.filter(t => t.categorySource !== 'human' && t.category !== T.UNCLASSIFIED &&
      (t.autoClassification.confidenceLabel !== 'high' || t.autoClassification.alternatives.length)).length;

    return {
      period,
      filtered,
      total: filtered.length,
      completeness: completeness(period, coverage, f.status),
      unresolved: unresolved.length,
      open: unresolved.filter(t => t.statusGroup === 'open').length,
      onHold: unresolved.filter(t => t.statusGroup === 'on_hold').length,
      unassignedUnresolved: unresolved.filter(t => !t.assigneeId).length,
      noReplyYet,
      noReplyOver24h,
      noReplyEligible: noReplyEligible.length,
      createdToday: filtered.filter(t => t.createdAt && dayKey(t.createdAt) === dayKey(now)).length,
      byCategory,
      unclassifiedBreakdown,
      classification: { corrected, uncertain, unclassified: unclassifiedTickets.length },
      byChannel,
      byStatus,
      priority: avail.priority.available ? { available: true, rows: byPriority } : { available: false, reason: avail.priority.reason },
      byOwner,
      backlogAge,
      oldestUnresolved: oldest ? { ticket: oldest, ageHours: (now - oldest.createdAt) / HOUR } : null,
      daily: dailySeries(filtered, period, now),
      closed,
      timeToClose,
      firstResponse: avail.firstResponse,
      sla
    };
  }

  // ── Overview (the manager's view) ──
  const MIN_COMPARE = 10;            // earlier period needs this many tickets for a % change
  const DAY_MINUTES = 24 * 60;
  const WAIT_BUCKETS = [
    { id: 'lt1h', label: 'Under 1 hour', maxHours: 1 },
    { id: '1to4h', label: '1–4 hours', maxHours: 4 },
    { id: '4to24h', label: '4–24 hours', maxHours: 24 },
    { id: '1to3d', label: '1–3 days', maxHours: 72 },
    { id: '3to7d', label: '3–7 days', maxHours: 168 },
    { id: 'gt7d', label: 'Over 7 days', maxHours: Infinity }
  ];
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function inRange(d, start, end) {
    return !!d && (!start || d >= start) && (!end || d < end);
  }

  function previousPeriod(period) {
    if (!period.start || !period.end) return null;
    const len = period.end - period.start;
    return { start: new Date(period.start.getTime() - len), end: period.start };
  }

  /** Agents log phone calls as tickets and close them at once. */
  function isCallLog(t) { return t.channel === 'phone'; }

  function customerQuery(t) { return t.category !== 'not_customer_query'; }

  function hoursSince(d, now) { return d ? (now - d) / HOUR : null; }

  function closeHours(t) {
    return t.createdAt && t.closedAt && t.closedAt >= t.createdAt ? (t.closedAt - t.createdAt) / HOUR : null;
  }

  function firstResponseMinutes(t) {
    return t.metrics && typeof t.metrics.firstResponseMinutes === 'number' ? t.metrics.firstResponseMinutes : null;
  }

  /** New and closed tickets per hour (today), day, or week (long periods), IST. */
  function flowSeries(scope, period, now) {
    const created = scope.filter(t => t.createdAt && inRange(t.createdAt, period.start, period.end));
    const closed = scope.filter(t => t.statusGroup === 'closed' && t.closedAt && inRange(t.closedAt, period.start, period.end));
    if (period.id === 'today') {
      const startKey = dayKey(now);
      const base = startOfDay(startKey).getTime();
      const hourOf = d => Math.floor((d.getTime() - base) / HOUR);
      const buckets = Array.from({ length: 24 }, (_, h) => ({ key: `${startKey}T${String(h).padStart(2, '0')}`, hour: h, created: 0, closed: 0 }));
      created.forEach(t => { const h = hourOf(t.createdAt); if (buckets[h]) buckets[h].created++; });
      closed.forEach(t => { const h = hourOf(t.closedAt); if (buckets[h]) buckets[h].closed++; });
      const upto = Math.min(23, Math.floor((now - base) / HOUR));
      return { granularity: 'hour', buckets: buckets.slice(0, upto + 1) };
    }
    let fromKey = period.start ? dayKey(period.start) : null;
    const toKey = period.end ? addDays(dayKey(period.end), -1) : dayKey(now);
    if (!fromKey) {
      const times = created.map(t => t.createdAt.getTime()).concat(closed.map(t => t.closedAt.getTime()));
      if (!times.length) return { granularity: 'day', buckets: [] };
      fromKey = dayKey(new Date(Math.min.apply(null, times)));
    }
    const lastKey = toKey < fromKey ? fromKey : toKey;
    const c1 = countBy(created, t => dayKey(t.createdAt));
    const c2 = countBy(closed, t => dayKey(t.closedAt));
    const days = [];
    for (let k = fromKey; k <= lastKey; k = addDays(k, 1)) days.push({ key: k, start: k, end: k, created: c1.get(k) || 0, closed: c2.get(k) || 0 });
    if (days.length <= 92) return { granularity: 'day', buckets: days };
    const weeks = new Map();
    days.forEach(d => {
      const dow = (new Date(d.key + 'T00:00:00Z').getUTCDay() + 6) % 7;
      const wk = addDays(d.key, -dow);
      const w = weeks.get(wk) || { key: wk, start: d.key, end: d.key, created: 0, closed: 0 };
      w.end = d.key; w.created += d.created; w.closed += d.closed;
      weeks.set(wk, w);
    });
    return { granularity: 'week', buckets: Array.from(weeks.values()) };
  }

  /** Tickets created by IST weekday (Mon = 0) and hour. */
  function arrivals(created) {
    const grid = WEEKDAYS.map(() => new Array(24).fill(0));
    created.forEach(t => {
      if (!t.createdAt) return;
      const ist = new Date(t.createdAt.getTime() + OFFSET_MS);
      grid[(ist.getUTCDay() + 6) % 7][ist.getUTCHours()]++;
    });
    let peak = null;
    grid.forEach((row, d) => row.forEach((n, h) => { if (n && (!peak || n > peak.count)) peak = { day: d, hour: h, count: n }; }));
    const byHour = new Array(24).fill(0);
    grid.forEach(row => row.forEach((n, h) => { byHour[h] += n; }));
    return { weekdays: WEEKDAYS, grid, peak, byDay: grid.map(r => r.reduce((a, b) => a + b, 0)), byHour, max: Math.max.apply(null, [0].concat(grid.map(r => Math.max.apply(null, r)))) };
  }

  function firstResponseStats(tickets, now, avail) {
    const eligible = tickets.filter(t => !isCallLog(t) && customerQuery(t));
    if (!avail.available) return { available: false, reason: avail.reason };
    if (!eligible.length) return { available: false, reason: 'No WhatsApp or email tickets match.' };
    const measured = eligible.filter(t => t.metrics);
    if (!measured.length) return { available: false, reason: 'Zoho first-response times are still loading for these tickets.' };
    const answered = measured.map(firstResponseMinutes).filter(m => m !== null);
    const old = measured.filter(t => t.createdAt && now - t.createdAt >= DAY);
    const within24 = old.filter(t => { const m = firstResponseMinutes(t); return m !== null && m <= DAY_MINUTES; }).length;
    return {
      available: true,
      eligible: eligible.length,
      measured: measured.length,
      answered: answered.length,
      notAnswered: measured.length - answered.length,
      medianMinutes: median(answered),
      within24h: old.length ? within24 / old.length : null,
      within24hBase: old.length,
      partial: measured.length < eligible.length
    };
  }

  /**
   * Everything the Overview shows. "Now" numbers (waiting, open) ignore the
   * period; "flow" numbers (new, closed, first response) use it. All other
   * filters apply to both.
   * @param {Object[]} allTickets  Tickets after applyCategories()
   * @param {Object} filters
   * @param {{coverage:Object, now:Date}} ctx
   */
  function overview(allTickets, filters, ctx) {
    const now = ctx.now;
    const coverage = ctx.coverage;
    const f = Object.assign({}, DEFAULT_FILTERS, filters || {});
    const period = resolvePeriod(f, now);
    const prev = previousPeriod(period);
    const scope = filterTickets(allTickets, Object.assign({}, f, { period: 'all' }), now);
    const created = filterTickets(allTickets, f, now);
    const prevCreated = prev ? scope.filter(t => inRange(t.createdAt, prev.start, prev.end)) : null;
    const avail = availability(allTickets, coverage);
    const change = (cur, before) => (before && before.length >= MIN_COMPARE ? (cur - before.length) / before.length : null);

    // Now: who is waiting, what is open
    const open = scope.filter(isUnresolved);
    const waiting = scope.filter(needsReply);
    const waitH = t => hoursSince(waitingSince(t), now);
    const waitCounts = countBy(waiting.filter(t => waitingSince(t)), t => WAIT_BUCKETS.find(b => waitH(t) < b.maxHours).id);
    const waitHours = waiting.map(waitH).filter(h => h !== null);

    // Closed in the period, by closed date
    const closedAll = scope.filter(t => t.statusGroup === 'closed' && inRange(t.closedAt, period.start, period.end));
    const closedConv = closedAll.filter(t => !isCallLog(t));
    const closeTimes = closedConv.map(closeHours).filter(h => h !== null);
    const closedNote = !avail.closed.available ? avail.closed.reason
      : coverage && coverage.closedCreatedSince && (!period.start || period.start < coverage.closedCreatedSince)
        ? `Only tickets created since ${dayKey(coverage.closedCreatedSince)} are in the data.` : null;
    const prevClosedConv = prev ? scope.filter(t => t.statusGroup === 'closed' && !isCallLog(t) && inRange(t.closedAt, prev.start, prev.end)) : null;

    // Query types
    const catNew = countBy(created, t => t.category);
    const catPrev = prevCreated ? countBy(prevCreated, t => t.category) : null;
    const catOpen = countBy(open, t => t.category);
    const catWait = new Map();
    waiting.forEach(t => {
      const w = catWait.get(t.category) || { count: 0, oldest: 0 };
      w.count++; w.oldest = Math.max(w.oldest, waitH(t) || 0);
      catWait.set(t.category, w);
    });
    const queryTypes = T.CATEGORIES.map(c => {
      const before = catPrev ? catPrev.get(c.id) || 0 : null;
      const n = catNew.get(c.id) || 0;
      return {
        id: c.id, label: c.label, created: n, share: created.length ? n / created.length : 0,
        previous: before, change: before !== null && before >= MIN_COMPARE ? (n - before) / before : null,
        open: catOpen.get(c.id) || 0,
        waiting: catWait.has(c.id) ? catWait.get(c.id).count : 0,
        oldestWaitHours: catWait.has(c.id) ? catWait.get(c.id).oldest : null,
        tail: c.id === T.UNCLASSIFIED || c.id === 'not_customer_query'
      };
    });

    // Channels
    const channels = Object.keys(T.CHANNELS).map(id => {
      const mine = t => t.channel === id;
      const closedHere = closedAll.filter(mine);
      const times = closedHere.map(closeHours).filter(h => h !== null);
      return {
        id, label: T.CHANNELS[id].label, callLog: id === 'phone',
        created: created.filter(mine).length, open: open.filter(mine).length, waiting: waiting.filter(mine).length,
        closed: closedHere.length, medianCloseHours: id === 'phone' ? null : median(times)
      };
    }).filter(r => r.created || r.open || r.closed);

    // Team
    const owners = new Map();
    const ownerRow = t => {
      const key = t.assigneeId || 'unassigned';
      if (!owners.has(key)) owners.set(key, { id: key, label: ownerLabel(t), unassigned: !t.assigneeId, open: 0, waiting: 0, closed: 0, callLogs: 0, closeTimes: [], frt: [], oldestWaitHours: null });
      return owners.get(key);
    };
    open.forEach(t => { ownerRow(t).open++; });
    waiting.forEach(t => { const o = ownerRow(t); o.waiting++; const h = waitH(t); if (h !== null) o.oldestWaitHours = Math.max(o.oldestWaitHours || 0, h); });
    closedAll.forEach(t => {
      const o = ownerRow(t);
      if (isCallLog(t)) { o.callLogs++; return; }
      o.closed++;
      const h = closeHours(t);
      if (h !== null) o.closeTimes.push(h);
    });
    created.forEach(t => { const m = firstResponseMinutes(t); if (m !== null && !isCallLog(t)) ownerRow(t).frt.push(m); });
    const team = Array.from(owners.values()).map(o => ({
      id: o.id, label: o.label, unassigned: o.unassigned, open: o.open, waiting: o.waiting, closed: o.closed, callLogs: o.callLogs,
      medianCloseHours: median(o.closeTimes), medianFirstResponseMinutes: median(o.frt), oldestWaitHours: o.oldestWaitHours
    })).sort((a, b) => (b.unassigned - a.unassigned) || b.open - a.open || b.closed - a.closed);

    // Customers coming back
    const byContact = new Map();
    created.filter(t => t.contactId && !t.sharedContact && customerQuery(t)).forEach(t => {
      const c = byContact.get(t.contactId) || { contactId: t.contactId, name: t.contact && t.contact.name, tickets: 0, open: 0, latest: null, latestId: null };
      c.tickets++;
      if (isUnresolved(t)) c.open++;
      if (t.createdAt && (!c.latest || t.createdAt > c.latest)) { c.latest = t.createdAt; c.latestId = t.id; }
      byContact.set(t.contactId, c);
    });
    const repeaters = Array.from(byContact.values()).filter(c => c.tickets >= 2).sort((a, b) => b.tickets - a.tickets || b.latest - a.latest);

    return {
      period,
      previous: prev,
      newTickets: {
        count: created.length,
        today: created.filter(t => t.createdAt && dayKey(t.createdAt) === dayKey(now)).length,
        previous: prevCreated ? prevCreated.length : null,
        change: change(created.length, prevCreated)
      },
      waiting: {
        count: waiting.length,
        over24h: waitHours.filter(h => h >= 24).length,
        oldestHours: waitHours.length ? Math.max.apply(null, waitHours) : null,
        medianHours: median(waitHours),
        buckets: WAIT_BUCKETS.map(b => ({ id: b.id, label: b.label, count: waitCounts.get(b.id) || 0 }))
      },
      open: {
        count: open.length,
        unassigned: open.filter(t => !t.assigneeId).length,
        onHold: open.filter(t => t.statusGroup === 'on_hold').length
      },
      closed: avail.closed.available ? {
        available: true,
        count: closedConv.length,
        callLogs: closedAll.length - closedConv.length,
        previous: prevClosedConv ? prevClosedConv.length : null,
        change: change(closedConv.length, prevClosedConv),
        medianHours: median(closeTimes),
        timedCount: closeTimes.length,
        reopened: closedConv.filter(t => t.metrics && t.metrics.reopenCount > 0).length,
        note: closedNote
      } : { available: false, reason: avail.closed.reason },
      firstResponse: firstResponseStats(created, now, avail.firstResponse),
      flow: flowSeries(scope, period, now),
      queryTypes,
      unclassifiedShare: created.length ? (catNew.get(T.UNCLASSIFIED) || 0) / created.length : 0,
      channels,
      team,
      arrivals: arrivals(created),
      repeat: {
        customers: byContact.size,
        repeatCustomers: repeaters.length,
        share: byContact.size ? repeaters.length / byContact.size : 0,
        top: repeaters.slice(0, 6)
      },
      attention: attentionQueue(scope, now, 'urgency'),
      control: (() => {
        const states = open.map(t => nextStep(t, now));
        const count = st => states.filter(x => x && x.state === st).length;
        const waitingKinds = {};
        states.filter(x => x && x.state === 'waiting').forEach(x => { waitingKinds[x.kind || 'other'] = (waitingKinds[x.kind || 'other'] || 0) + 1; });
        return { open: open.length, assigned: open.filter(t => t.assigneeId).length, reply: count('reply'), due: count('due'), none: count('none'), waiting: count('waiting'), waitingKinds };
      })(),
      gaps: [
        avail.sla.available ? null : { label: 'SLA', reason: avail.sla.reason },
        avail.priority.available ? null : { label: 'Priority', reason: avail.priority.reason },
        avail.firstResponse.available ? null : { label: 'First response time', reason: avail.firstResponse.reason },
        avail.closed.available ? null : { label: 'Closed tickets', reason: avail.closed.reason }
      ].filter(Boolean)
    };
  }

  /** How old the synced data is, and whether the scheduled sync seems to be failing. */
  function freshness(fetchedAt, now, source) {
    if (!fetchedAt) return { state: 'unknown', ageMinutes: null };
    const ageMinutes = Math.max(0, Math.round((now - fetchedAt) / 60000));
    if (source !== 'snapshot') return { state: 'fresh', ageMinutes };
    const stale = ageMinutes > SYNC_INTERVAL_MINUTES * STALE_AFTER_MISSED_RUNS;
    return { state: stale ? 'stale' : 'fresh', ageMinutes };
  }

  return {
    PERIODS, DEFAULT_FILTERS, METRIC_DEFINITIONS, SYNC_INTERVAL_MINUTES,
    dayKey, startOfDay, addDays, resolvePeriod, filterTickets, ageBucketFor, isUnresolved, attentionFor, attentionQueue,
    QUEUES, needsReply, waitingSince, inboxQueues, nextStep,
    WAIT_BUCKETS, overview, isCallLog,
    computeDashboard, freshness, median, ownerLabel
  };
});

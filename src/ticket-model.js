/**
 * ticket-model.js
 * Turns raw Zoho Desk ticket records (from data/tickets.json, the live API, or
 * the labelled sample generator) into one normalised Ticket shape, and owns
 * classification, category corrections and review flags.
 *
 * Pure functions only - no DOM, no network, no storage - so the same code runs
 * in the browser and in `node --test`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./taxonomy'));
  } else {
    root.GI = root.GI || {};
    root.GI.ticketModel = factory(root.GI.taxonomy);
  }
})(typeof self !== 'undefined' ? self : this, function (T) {
  'use strict';

  /**
   * @typedef {Object} Classification
   * @property {string} category            Category id from taxonomy.CATEGORIES
   * @property {number|null} confidence     0-1; null when unclassified
   * @property {'high'|'medium'|'low'|null} confidenceLabel
   * @property {string} source              'rules' | 'zoho' (future: 'ai')
   * @property {string} model               e.g. 'keyword-rules-v1'
   * @property {string[]} evidence          Human-readable reasons for the suggestion
   * @property {string[]} alternatives      Other categories that also matched
   * @property {string|null} unclassifiedReason  Key of taxonomy.UNCLASSIFIED_REASONS
   */

  /**
   * @typedef {Object} CorrectionEntry
   * @property {string|null} category   null = reset to the automatic suggestion
   * @property {string} previous        Category shown before this change
   * @property {string} at              ISO timestamp
   * @property {string} by              Who made it (free text; no login yet)
   * @property {string} [note]
   */

  /**
   * @typedef {Object} Ticket
   * @property {string} id                 Zoho ticket ID - the stable key, never rewritten
   * @property {string|null} number        Zoho ticket number shown to agents
   * @property {string} subject
   * @property {string|null} status        Raw Zoho status name
   * @property {'open'|'on_hold'|'closed'} statusGroup
   * @property {string} channel            taxonomy.CHANNELS key
   * @property {string|null} channelRaw    Zoho channel name, e.g. "GaadiInfo Care"
   * @property {string} priority           taxonomy.PRIORITIES key ('not_set' when blank)
   * @property {Date|null} createdAt
   * @property {Date|null} closedAt
   * @property {Date|null} modifiedAt
   * @property {Date|null} lastCustomerMessageAt   Zoho customerResponseTime
   * @property {Date|null} dueAt                   Zoho SLA due date
   * @property {number|null} threadCount
   * @property {string|null} contactId
   * @property {{name:string|null,email:string|null,phone:string|null}|null} contact
   * @property {string|null} assigneeId
   * @property {string|null} assigneeName
   * @property {string|null} webUrl        Zoho Desk link (only https://desk.zoho.* is kept)
   * @property {boolean} isSpam
   * @property {Object} entities           Vehicle / order / challan numbers etc. found in the subject
   * @property {Classification} autoClassification
   */

  // ── Small helpers ──
  function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  function toInt(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = parseInt(value, 10);
    return isNaN(n) ? null : n;
  }

  function safeZohoUrl(url) {
    if (typeof url !== 'string') return null;
    return /^https:\/\/desk\.zoho\.[a-z.]+\//i.test(url) ? url : null;
  }

  function normaliseText(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ── Entities mentioned in the subject ──
  const VEHICLE_RE = /\b([a-z]{2})[\s-]?(\d{1,2})[\s-]?([a-z]{1,3})[\s-]?(\d{4})\b/gi;
  const ORDER_RE = /\b(?:gi-?\s?)?(20\d{2})-(\d{5,7})\b/gi;
  const CHALLAN_NO_RE = /\b([a-z]{2}\d{14,22})\b/gi;
  const UTR_RE = /\butr\b\D{0,12}(\d{12})\b/gi;
  const AMOUNT_RE = /(?:₹|\brs\.?\s?|\binr\s?)\s?([\d,]+(?:\.\d{1,2})?)/gi;

  function uniq(list) {
    return Array.from(new Set(list));
  }

  function extractEntities(subject) {
    const s = String(subject || '');
    const vehicles = [];
    let m;
    VEHICLE_RE.lastIndex = 0;
    while ((m = VEHICLE_RE.exec(s))) vehicles.push((m[1] + m[2] + m[3] + m[4]).toUpperCase());
    const orders = [];
    ORDER_RE.lastIndex = 0;
    while ((m = ORDER_RE.exec(s))) orders.push(`GI-${m[1]}-${m[2]}`);
    const challans = [];
    CHALLAN_NO_RE.lastIndex = 0;
    while ((m = CHALLAN_NO_RE.exec(s))) challans.push(m[1].toUpperCase());
    const utrs = [];
    UTR_RE.lastIndex = 0;
    while ((m = UTR_RE.exec(s))) utrs.push(m[1]);
    const amounts = [];
    AMOUNT_RE.lastIndex = 0;
    while ((m = AMOUNT_RE.exec(s))) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (!isNaN(n) && n > 0) amounts.push(n);
    }
    return {
      vehicles: uniq(vehicles),
      orders: uniq(orders),
      challans: uniq(challans),
      utrs: uniq(utrs),
      amounts: uniq(amounts)
    };
  }

  function hasEntities(e) {
    return e.vehicles.length + e.orders.length + e.challans.length + e.utrs.length > 0;
  }

  // ── Classification (keyword rules on the subject) ──
  function confidenceLabel(c) {
    if (c === null || c === undefined) return null;
    if (c >= 0.8) return 'high';
    if (c >= T.LOW_CONFIDENCE_THRESHOLD) return 'medium';
    return 'low';
  }

  function unclassifiedReasonFor(text, entities) {
    if (!text) return 'no_subject';
    if (T.TEMPLATE_SUBJECTS.has(text)) return 'greeting';
    if (/^[\w-]+\.(jpe?g|png|gif|webp|heic|pdf|mp4|ogg|opus|mp3|docx?)$/.test(text)) return 'attachment';
    const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);
    const meaningful = tokens.filter(tok => !isFillerToken(tok));
    if (meaningful.length === 0) return 'greeting';
    if (hasEntities(entities)) return 'reference';
    return 'no_match';
  }

  // Greeting words plus typo'd brand / "support" tokens seen in real subjects
  // ("gaadiinhlofo", "suppohirt", "hiisupport").
  function isFillerToken(tok) {
    return T.GREETING_TOKENS.has(tok) ||
      /^ga+h?\w*d+\w*i/.test(tok) ||
      /info/.test(tok) ||
      /^\w{0,3}s\w*u\w*p+\w*o\w*t\w*$/.test(tok);
  }

  /**
   * Suggest a category from the subject line.
   * Never forces a category: no keyword match -> 'unclassified' with a reason.
   * @returns {Classification}
   */
  function classifySubject(subject, opts) {
    const options = opts || {};
    const text = normaliseText(subject);
    const entities = options.entities || extractEntities(subject);
    const base = { source: T.CLASSIFIER.source, model: T.CLASSIFIER.model };

    if (options.isSpam) {
      return Object.assign({}, base, {
        category: 'not_customer_query', confidence: 0.95, confidenceLabel: 'high',
        evidence: ['Marked as spam in Zoho'], alternatives: [], unclassifiedReason: null
      });
    }

    // Best match per category
    const best = new Map();
    T.RULES.forEach(r => {
      if (!text || !r.pattern.test(text)) return;
      const prev = best.get(r.category);
      if (!prev || r.weight > prev.weight) best.set(r.category, { weight: r.weight, labels: [r.label] });
      else if (prev && !prev.labels.includes(r.label)) prev.labels.push(r.label);
    });

    if (best.size === 0) {
      return Object.assign({}, base, {
        category: T.UNCLASSIFIED, confidence: null, confidenceLabel: null,
        evidence: [], alternatives: [], unclassifiedReason: unclassifiedReasonFor(text, entities)
      });
    }

    const order = T.TIE_BREAK_ORDER;
    const ranked = Array.from(best.entries())
      .map(([category, v]) => ({ category, weight: v.weight, labels: v.labels }))
      .sort((a, b) => b.weight - a.weight || order.indexOf(a.category) - order.indexOf(b.category));

    const top = ranked[0];
    // A rival is another category with nearly as much evidence.
    const rivals = ranked.slice(1).filter(r => r.weight >= T.LOW_CONFIDENCE_THRESHOLD && r.weight >= top.weight - 0.15);
    // Competing evidence lowers confidence instead of silently picking one.
    let confidence = top.weight;
    if (rivals.length) confidence = Math.max(0.4, top.weight - 0.25);
    confidence = Math.round(confidence * 100) / 100;

    return Object.assign({}, base, {
      category: top.category,
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      evidence: top.labels.map(l => `Subject mentions ${l}`),
      alternatives: rivals.map(r => r.category),
      unclassifiedReason: null
    });
  }

  // ── Normalisation ──
  function contactName(c) {
    if (!c) return null;
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
    return name || null;
  }

  /**
   * Customer contact details. Sources, best first: the contact record, the
   * contact embedded in Zoho search results, the ticket's own email / phone.
   * WhatsApp customers' numbers are stored in `mobile`.
   */
  function contactFor(raw, contacts) {
    const rec = (raw.contactId && contacts[raw.contactId]) || raw.contact || null;
    const email = (rec && rec.email) || raw.email || null;
    const phones = uniq([rec && rec.mobile, rec && rec.phone, raw.phone].filter(Boolean).map(String));
    if (!rec && !email && !phones.length) return null;
    return { name: contactName(rec), email, phone: phones[0] || null, phones };
  }

  /**
   * Zoho ticket metrics, already parsed by the workspace server
   * (server/ticket-metrics.js). Absent in the GitHub-synced snapshot.
   */
  function ticketMetrics(m) {
    if (!m || typeof m !== 'object') return null;
    const n = v => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : null);
    return {
      firstResponseMinutes: n(m.firstResponseMinutes),
      responseCount: n(m.responseCount),
      reopenCount: n(m.reopenCount),
      reassignCount: n(m.reassignCount)
    };
  }

  /** The ticket's follow-up, set by an agent in the workspace (server/actions.js). */
  function followUpOf(f) {
    if (!f || typeof f !== 'object' || !f.active) return null;
    const at = parseDate(f.at);
    if (!at) return null;
    return {
      at, kind: T.WAIT_KINDS[f.kind] ? f.kind : null,
      reason: typeof f.reason === 'string' ? f.reason : '', note: typeof f.note === 'string' ? f.note : '',
      by: typeof f.by === 'string' ? f.by : null, setAt: parseDate(f.setAt)
    };
  }

  /** @returns {Ticket} */
  function normalizeTicket(raw, ctx) {
    const lookups = ctx || {};
    const contacts = lookups.contacts || {};
    const agents = lookups.agents || {};
    const subject = typeof raw.subject === 'string' ? raw.subject : '';
    const entities = extractEntities(subject);
    const agent = raw.assigneeId ? agents[raw.assigneeId] : null;
    const isSpam = raw.isSpam === true || raw.isSpam === 'true';
    const zohoCategory = raw.category ? String(raw.category) : null;

    return {
      id: String(raw.id),
      number: raw.ticketNumber != null ? String(raw.ticketNumber) : null,
      subject,
      status: raw.status || null,
      statusGroup: T.statusGroupFor(raw.status, raw.statusType),
      channel: T.channelFor(raw.channel, raw.channelCode),
      channelRaw: raw.channel || null,
      priority: T.priorityFor(raw.priority),
      createdAt: parseDate(raw.createdTime),
      closedAt: parseDate(raw.closedTime),
      modifiedAt: parseDate(raw.modifiedTime),
      zohoModifiedTime: typeof raw.modifiedTime === 'string' ? raw.modifiedTime : null, // exact value, for conflict checks
      lastCustomerMessageAt: parseDate(raw.customerResponseTime),
      dueAt: parseDate(raw.dueDate),
      threadCount: toInt(raw.threadCount),
      contactId: raw.contactId ? String(raw.contactId) : null,
      contact: contactFor(raw, contacts),
      lastThreadDirection: raw.lastThread && raw.lastThread.direction ? raw.lastThread.direction : null,
      metrics: ticketMetrics(raw.metrics),
      followUp: followUpOf(raw.followUp),
      assigneeId: raw.assigneeId ? String(raw.assigneeId) : null,
      assigneeName: agent && agent.name ? agent.name : null,
      webUrl: safeZohoUrl(raw.webUrl),
      isSpam,
      zohoCategory,
      entities,
      autoClassification: classifySubject(subject, { entities, isSpam })
    };
  }

  /**
   * Keep one record per Zoho ticket ID. Offset pagination can return the same
   * ticket twice when tickets share a createdTime; the most recently modified
   * copy wins.
   */
  function dedupeById(rawTickets) {
    const byId = new Map();
    let duplicates = 0;
    let missingId = 0;
    (rawTickets || []).forEach(t => {
      if (!t || t.id === undefined || t.id === null || t.id === '') { missingId++; return; }
      const id = String(t.id);
      const prev = byId.get(id);
      if (prev) {
        duplicates++;
        const prevMod = parseDate(prev.modifiedTime);
        const curMod = parseDate(t.modifiedTime);
        if (!prevMod || (curMod && curMod >= prevMod)) byId.set(id, t);
      } else {
        byId.set(id, t);
      }
    });
    return { tickets: Array.from(byId.values()), duplicates, missingId };
  }

  // ── Snapshot adapter ──
  /**
   * @typedef {Object} Coverage
   * @property {boolean} includesClosed       Closed tickets are present in the data
   * @property {Date|null} closedCreatedSince Closed tickets are only present if created on/after this
   * @property {boolean} capped               Source returned a limited page (e.g. live API: 100 tickets)
   * @property {string} description           Plain-language summary for the UI
   */

  /**
   * @typedef {Object} Dataset
   * @property {'snapshot'|'live_api'|'sample'} source
   * @property {Date|null} fetchedAt
   * @property {Coverage} coverage
   * @property {Ticket[]} tickets
   * @property {Object|null} sync         Sync metadata written by scripts/fetch-tickets.js
   * @property {string[]} warnings        Problems the UI must show (never swallowed)
   * @property {number} duplicatesRemoved
   */

  function buildDataset(rawTickets, opts) {
    const o = opts || {};
    const deduped = dedupeById(rawTickets);
    const warnings = (o.warnings || []).slice();
    if (deduped.missingId) warnings.push(`${deduped.missingId} record(s) had no Zoho ticket ID and could not be shown.`);
    const tickets = deduped.tickets.map(t => normalizeTicket(t, { contacts: o.contacts, agents: o.agents }));
    const noDate = tickets.filter(t => !t.createdAt).length;
    if (noDate) warnings.push(`${noDate} ticket(s) have no valid created time; they are excluded from date-based charts.`);
    return {
      source: o.source,
      fetchedAt: o.fetchedAt || null,
      coverage: o.coverage,
      tickets,
      sync: o.sync || null,
      warnings,
      duplicatesRemoved: deduped.duplicates
    };
  }

  /**
   * Parse data/tickets.json (written by scripts/fetch-tickets.js).
   * Supports the original format (open tickets only, no schemaVersion) and v2.
   * @returns {{ok:true, dataset:Dataset} | {ok:false, error:string}}
   */
  function parseSnapshot(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return { ok: false, error: 'The data file is not a JSON object.' };
    }
    if (!Array.isArray(json.tickets)) {
      return { ok: false, error: 'The data file has no "tickets" list.' };
    }
    const fetchedAt = parseDate(json.fetchedAt);
    const sync = json.sync && typeof json.sync === 'object' ? json.sync : null;
    const closed = Array.isArray(json.closedTickets) ? json.closedTickets : [];
    const lookback = sync && Number(sync.closedLookbackDays) > 0 ? Number(sync.closedLookbackDays) : 0;
    const includesClosed = lookback > 0;
    const closedCreatedSince = includesClosed ? parseDate(sync.closedCreatedSince) : null;

    const warnings = [];
    if (!fetchedAt) warnings.push('The data file does not say when it was synced.');
    if (sync && Array.isArray(sync.contactFailures) && sync.contactFailures.length) {
      warnings.push(`Customer details could not be fetched for ${sync.contactFailures.length} contact(s) in the last sync; those tickets show a contact ID only.`);
    }
    if (sync && sync.agentsError) warnings.push('Agent names could not be fetched in the last sync; owners show as IDs.');

    let description;
    if (!includesClosed) description = 'Open and on-hold tickets only (the sync does not include closed tickets).';
    else if (closedCreatedSince) description = `Open tickets, plus closed tickets created in the last ${lookback} days.`;
    else description = 'Open and closed tickets.';

    return {
      ok: true,
      dataset: buildDataset(json.tickets.concat(closed), {
        source: 'snapshot',
        fetchedAt,
        sync,
        contacts: json.contacts || {},
        agents: json.agents || {},
        warnings,
        coverage: { includesClosed, closedCreatedSince, capped: false, description }
      })
    };
  }

  /** Dataset from a direct browser call to the Zoho API (single page). */
  function datasetFromLiveApi(rawTickets, fetchedAt, pageLimit) {
    return buildDataset(rawTickets, {
      source: 'live_api',
      fetchedAt,
      coverage: {
        includesClosed: true,
        closedCreatedSince: null,
        capped: rawTickets.length >= pageLimit,
        description: `Latest ${rawTickets.length} tickets from the live Zoho API (one page, not the full history).`
      },
      warnings: rawTickets.length >= pageLimit ? [`Live mode loads only the latest ${pageLimit} tickets, so totals are incomplete.`] : []
    });
  }

  /** Dataset for the explicitly requested UI preview. Never used automatically. */
  function datasetFromSample(rawTickets, generatedAt) {
    return buildDataset(rawTickets, {
      source: 'sample',
      fetchedAt: generatedAt,
      coverage: { includesClosed: true, closedCreatedSince: null, capped: false, description: 'Generated sample tickets - not real data.' }
    });
  }

  // ── Category corrections ──
  // Store shape: { version: 1, byTicket: { [ticketId]: CorrectionEntry[] } }
  function emptyCorrectionStore() {
    return { version: 1, byTicket: {} };
  }

  function validCorrectionStore(store) {
    return !!(store && typeof store === 'object' && store.byTicket && typeof store.byTicket === 'object');
  }

  /** Returns a new store with the entry appended to the ticket's history. */
  function addCorrection(store, ticketId, entry) {
    if (entry.category !== null && !T.categoryById(entry.category)) {
      throw new Error(`Unknown category "${entry.category}"`);
    }
    const base = validCorrectionStore(store) ? store : emptyCorrectionStore();
    const history = (base.byTicket[ticketId] || []).concat([{
      category: entry.category,
      previous: entry.previous,
      at: entry.at,
      by: entry.by || 'Unknown',
      note: entry.note || ''
    }]);
    const byTicket = Object.assign({}, base.byTicket, { [ticketId]: history });
    return { version: 1, byTicket };
  }

  function historyFor(store, ticketId) {
    return validCorrectionStore(store) ? (store.byTicket[ticketId] || []) : [];
  }

  /** The correction currently in force, or null if none / reset to automatic. */
  function currentCorrection(store, ticketId) {
    const h = historyFor(store, ticketId);
    const last = h[h.length - 1];
    return last && last.category ? last : null;
  }

  /**
   * Resolve each ticket's final category (human correction beats the automatic
   * suggestion) and its review reasons. Returns new ticket objects.
   */
  function applyCategories(tickets, store) {
    // Repeat contacts are flagged once, on their most recent ticket.
    const perContact = new Map();
    const latestByContact = new Map();
    tickets.forEach(t => {
      if (!t.contactId) return;
      perContact.set(t.contactId, (perContact.get(t.contactId) || 0) + 1);
      const cur = latestByContact.get(t.contactId);
      const a = t.createdAt ? t.createdAt.getTime() : 0;
      const b = cur && cur.createdAt ? cur.createdAt.getTime() : 0;
      if (!cur || a > b || (a === b && t.id > cur.id)) latestByContact.set(t.contactId, t);
    });

    return tickets.map(t => {
      const correction = currentCorrection(store, t.id);
      const category = correction ? correction.category : t.autoClassification.category;
      const reasons = [];
      const codes = [];
      const flag = (code, reason) => { codes.push(code); reasons.push(reason); };
      const cat = T.categoryById(category);
      if (cat && cat.reviewReason) flag('category:' + cat.id, cat.reviewReason);
      const text = normaliseText(t.subject);
      T.REVIEW_PATTERNS.forEach(p => { if (p.pattern.test(text)) flag(p.code, p.reason); });
      if (!correction && t.autoClassification.confidenceLabel === 'low') flag('uncertain', 'Category suggestion is uncertain');
      if (!correction && t.autoClassification.alternatives.length) flag('ambiguous', 'Subject matches more than one category');
      const repeat = t.contactId ? perContact.get(t.contactId) : 0;
      const sharedContact = repeat > T.SHARED_CONTACT_THRESHOLD;
      if (repeat >= T.REPEAT_CONTACT_THRESHOLD && !sharedContact && latestByContact.get(t.contactId) === t) {
        flag('repeat', `Repeat contact (${repeat} tickets)`);
      }

      return Object.assign({}, t, {
        category,
        categorySource: correction ? 'human' : t.autoClassification.source,
        correction,
        categoryHistory: historyFor(store, t.id),
        contactTicketCount: repeat || (t.contactId ? 1 : 0),
        sharedContact,
        reviewReasons: reasons,
        reviewCodes: codes,
        searchText: [
          t.subject, t.number, t.id, t.contactId, t.contact && t.contact.name, t.contact && t.contact.email,
          t.contact && t.contact.phones.join(' '), t.contact && t.contact.phones.map(n => n.replace(/^\+?91/, '')).join(' '), t.assigneeName,
          t.entities.vehicles.join(' '), t.entities.orders.join(' '), t.entities.challans.join(' '), t.entities.utrs.join(' ')
        ].filter(Boolean).join(' ').toLowerCase()
      });
    });
  }

  return {
    parseDate, extractEntities, classifySubject, confidenceLabel, normalizeTicket, dedupeById,
    parseSnapshot, datasetFromLiveApi, datasetFromSample,
    emptyCorrectionStore, addCorrection, historyFor, currentCorrection, applyCategories
  };
});

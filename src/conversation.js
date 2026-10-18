/**
 * conversation.js
 * Turns Zoho Desk conversation data into one ordered list of messages, and
 * derives the facts an agent needs from it (vehicle / order / challan numbers,
 * what the customer asked, whether a human has replied) - without AI.
 *
 * Input is what the workspace server fetches from Zoho:
 *   items   - GET /tickets/{id}/conversations   (threads + comments, metadata)
 *   threads - GET /tickets/{id}/threads/{threadId}?include=plainText, keyed by id
 *
 * WhatsApp (instant message) threads are whole chat sessions rendered by Zoho
 * as an HTML transcript; parseImTranscript() reads that format. Email threads
 * are one message each.
 *
 * Pure functions; runs in the browser and in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./taxonomy'), require('./ticket-model'));
  } else {
    root.GI = root.GI || {};
    root.GI.conversation = factory(root.GI.taxonomy, root.GI.ticketModel);
  }
})(typeof self !== 'undefined' ? self : this, function (T, TM) {
  'use strict';

  /**
   * @typedef {Object} Message
   * @property {string} id
   * @property {string} threadId
   * @property {'customer'|'business'|'internal'} side
   * @property {'customer'|'bot'|'agent'|'note'} role
   * @property {string} author
   * @property {string|null} at          ISO timestamp
   * @property {string} channel          taxonomy.CHANNELS key
   * @property {string} text
   * @property {{author:string,text:string}|null} quote   Message the customer replied to (WhatsApp buttons)
   * @property {string[]} options        Buttons offered by the bot
   * @property {{type:string,url:string,label:string}[]} attachments
   * @property {boolean} truncated       Zoho cut the text short in its transcript
   */

  // ── HTML → text ──
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, code) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return isNaN(n) ? m : String.fromCodePoint(n);
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, code.toLowerCase()) ? ENTITIES[code.toLowerCase()] : m;
    });
  }

  function htmlToText(html) {
    if (!html) return '';
    return decodeEntities(String(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ''))
      .split('\n')
      .map(line => line.replace(/[ \t ]+/g, ' ').trim())
      .filter((line, i, all) => line || (i > 0 && all[i - 1]))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ── WhatsApp transcript times: "7 Oct, 1:03 PM GMT" (no year) ──
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  function parseTranscriptTime(s, sessionStart) {
    const m = /(\d{1,2})\s+([a-z]{3})[a-z]*,?\s+(\d{1,2}):(\d{2})\s*(AM|PM)?\s*(GMT|UTC|IST)?/i.exec(s || '');
    if (!m) return null;
    const month = MONTHS[m[2].toLowerCase()];
    if (month === undefined) return null;
    let hour = parseInt(m[3], 10) % 12;
    if ((m[5] || '').toUpperCase() === 'PM') hour += 12;
    if (!m[5]) hour = parseInt(m[3], 10);
    const offsetMin = (m[6] || '').toUpperCase() === 'IST' ? 330 : 0;
    const ref = sessionStart ? new Date(sessionStart) : new Date();
    let year = ref.getUTCFullYear();
    let t = Date.UTC(year, month, parseInt(m[1], 10), hour, parseInt(m[4], 10)) - offsetMin * 60000;
    // The transcript has no year: pick the one closest to the session start.
    const half = 183 * 86400000;
    if (t - ref.getTime() > half) t = Date.UTC(--year, month, parseInt(m[1], 10), hour, parseInt(m[4], 10)) - offsetMin * 60000;
    else if (ref.getTime() - t > half) t = Date.UTC(++year, month, parseInt(m[1], 10), hour, parseInt(m[4], 10)) - offsetMin * 60000;
    return new Date(t);
  }

  // ── WhatsApp (instant message) transcript ──
  // Each message is a <div style="margin-bottom: 25px..."> block with the
  // author and time on the left and a bubble on the right. Customer bubbles are
  // tinted #ebf3ff; GaadiInfo-side bubbles (bot or agent) are #f6f8fb.
  function splitBlocks(html) {
    const parts = String(html || '').split(/<div style="margin-bottom:\s*25px;/i);
    return parts.slice(1);
  }

  function firstMatch(re, s) {
    const m = re.exec(s);
    return m ? m : null;
  }

  function parseImTranscript(html, opts) {
    const o = opts || {};
    const out = [];
    splitBlocks(html).forEach((block, i) => {
      const authorM = firstMatch(/<div[^>]*font-size:\s*13px;\s*margin-bottom:\s*3px[^>]*>([\s\S]*?)<\/div>/i, block);
      const timeM = firstMatch(/<div[^>]*color:\s*#5A616F[^>]*>([\s\S]*?)<\/div>/i, block);
      if (!authorM) return;
      const author = htmlToText(authorM[1]);
      const timeText = timeM ? htmlToText(timeM[1]) : '';
      const at = parseTranscriptTime(timeText, o.sessionStart);
      const side = /background-color:\s*#ebf3ff/i.test(block) ? 'customer' : 'business';
      let bubble = block.slice((timeM ? timeM.index + timeM[0].length : authorM.index + authorM[0].length));

      // Quoted reply (customer tapped a button): <b>author</b> + quoted text, then the reply.
      let quote = null;
      const qm = /<b[^>]*>([\s\S]*?)<\/b>[\s\S]*?<div[^>]*margin-left:\s*26px[^>]*>([\s\S]*?)<\/div>/i.exec(bubble);
      if (qm) {
        quote = { author: htmlToText(qm[1]), text: htmlToText(qm[2]).replace(/\s*,\s*$/, '') };
        const replyM = /<div style="margin-top:\s*6px">([\s\S]*?)<\/div>/i.exec(bubble.slice(qm.index + qm[0].length));
        bubble = replyM ? replyM[1] : bubble.slice(qm.index + qm[0].length);
      }

      // Buttons the bot offered
      const options = [];
      bubble = bubble.replace(/<div[^>]*width:\s*200px[^>]*>([\s\S]*?)<\/div>/gi, (m, inner) => {
        const t = htmlToText(inner);
        if (t) options.push(t);
        return '';
      });
      bubble = bubble.replace(/<input[^>]*>/gi, '');

      const attachments = [];
      bubble.replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, (m, src) => {
        if (!/width:\s*20px/i.test(m)) attachments.push({ type: 'image', url: decodeEntities(src), label: 'Image' });
        return '';
      });
      bubble.replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
        attachments.push({ type: 'link', url: decodeEntities(href), label: htmlToText(label) || 'Link' });
        return '';
      });

      const text = htmlToText(bubble);
      out.push({
        index: i,
        side,
        author,
        at: at ? at.toISOString() : null,
        text,
        quote,
        options,
        attachments,
        truncated: /(\.\.\.|…)$/.test(text)
      });
    });
    return out;
  }

  // ── Email ──
  /** Remove the quoted history ("On Fri, ... wrote:") from an email body. */
  function stripEmailQuote(text) {
    let t = String(text || '');
    const cut = [
      /\s*On\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s[\s\S]{0,120}?wrote:/i,
      /\s*-{2,}\s*Original Message\s*-{2,}/i,
      /\n\s*From:\s.+\n\s*(Sent|Date):\s/i,
      /\s*-{5,}\s*Forwarded message/i
    ];
    cut.forEach(re => {
      const m = re.exec(t);
      if (m && m.index > 0) t = t.slice(0, m.index);
    });
    return t.trim();
  }

  // ── Assemble one conversation ──
  function lower(s) { return String(s || '').toLowerCase().trim(); }

  // Automated feedback replies that Zoho sends under an agent's name. They are
  // not a human answer and must not count as "an agent replied".
  const AUTOMATED_TEXT_RE = /^(sorry!?,? we let you down|thank(s| you) for (your )?(feedback|rating)|glad (we|to) (could )?help|good, bad)[.! ]*$/i;

  /**
   * @param {{items:Object[], threads:Object<string,Object>}} raw   Zoho payloads
   * @param {{ticket?:Object, agents?:Object}} ctx
   * @returns {{messages:Message[], sessions:number, warnings:string[]}}
   */
  function buildConversation(raw, ctx) {
    const c = ctx || {};
    const items = (raw && raw.items) || [];
    const threads = (raw && raw.threads) || {};
    const ticketChannel = c.ticket ? c.ticket.channel : null;
    const warnings = [];

    // Known human agents: from the agents list and from email replies sent by AGENT authors.
    const agentNames = new Set(Object.values(c.agents || {}).map(a => lower(a && a.name)).filter(Boolean));
    items.forEach(it => {
      if (it.author && it.author.type === 'AGENT') agentNames.add(lower(it.author.name));
      if (it.type === 'comment' && (it.commenter || it.author)) agentNames.add(lower((it.commenter || it.author).name));
    });

    const messages = [];
    let sessions = 0;
    const ordered = items.slice().sort((a, b) => new Date(a.createdTime || a.commentedTime || 0) - new Date(b.createdTime || b.commentedTime || 0));

    ordered.forEach(it => {
      const detail = threads[it.id] || null;
      const createdAt = it.createdTime || it.commentedTime || null;

      if (it.type === 'comment') {
        const who = (it.commenter || it.author || {}).name || 'Agent';
        messages.push(msg(it.id, it.id, 'internal', 'note', who, createdAt, 'internal', htmlToText(it.content || (detail && detail.content) || '')));
        return;
      }

      const source = (it.source && it.source.type) || (detail && detail.source && detail.source.type) || '';
      const channel = T.channelFor(it.channel || (detail && detail.channel), it.channel);
      sessions++;

      if (source === 'INSTANT_MESSAGE' || channel === 'whatsapp') {
        if (!detail || !detail.content) {
          warnings.push(`WhatsApp session ${it.id} could not be loaded.`);
          return;
        }
        parseImTranscript(detail.content, { sessionStart: createdAt }).forEach(m => {
          const human = agentNames.has(lower(m.author)) && !AUTOMATED_TEXT_RE.test(m.text.trim());
          const role = m.side === 'customer' ? 'customer' : human ? 'agent' : 'bot';
          messages.push(Object.assign(msg(`${it.id}:${m.index}`, it.id, m.side, role, m.author, m.at || createdAt, 'whatsapp', m.text), {
            quote: m.quote, options: m.options, attachments: m.attachments, truncated: m.truncated
          }));
        });
        return;
      }

      const display = /^\s*"?([^"<]+?)"?\s*</.exec(it.fromEmailAddress || '');
      const author = (display && display[1].trim()) || (it.author && it.author.name) || (detail && detail.author && detail.author.name) || '';
      const body = detail && (detail.plainText || detail.content)
        ? (detail.plainText || htmlToText(detail.content))
        : (it.summary || '');
      const isStaffNote = it.isDescriptionThread && ticketChannel === 'phone';
      const side = isStaffNote ? 'internal' : it.direction === 'out' ? 'business' : 'customer';
      const role = isStaffNote ? 'note' : side === 'business' ? 'agent' : 'customer';
      const text = channel === 'email' ? stripEmailQuote(body) : body.trim();
      const m = msg(it.id, it.id, side, role, author, createdAt, channel, text);
      m.truncated = !detail && /(\.\.\.|…)$/.test(body);
      if (Number(it.attachmentCount) > 0) m.attachments = [{ type: 'file', url: '', label: `${it.attachmentCount} attachment(s) in Zoho` }];
      messages.push(m);
    });

    // Drop exact repeats (sessions can share a boundary message) and order by time.
    const seen = new Set();
    const unique = messages.filter(m => {
      const key = [m.side, lower(m.author), (m.at || '').slice(0, 16), m.text.slice(0, 120)].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    unique.forEach((m, i) => { m.seq = i; });
    unique.sort((a, b) => (a.at && b.at ? new Date(a.at) - new Date(b.at) : 0) || a.seq - b.seq);
    unique.forEach(m => { delete m.seq; });
    return { messages: unique, sessions, warnings };
  }

  function msg(id, threadId, side, role, author, at, channel, text) {
    return { id: String(id), threadId: String(threadId), side, role, author: author || '', at: at || null, channel, text: text || '', quote: null, options: [], attachments: [], truncated: false };
  }

  // ── Facts and summary (no AI) ──
  const EXAMPLE_RE = /\(for example [^)]*\)/gi;
  const UPI_RE = /\b([a-z0-9._-]{3,})@([a-z]{2,15})\b(?![.@\w])/gi;
  const PHONE_RE = /(?<![\d\w])(?:\+?91[\s-]?)?([6-9]\d{9})(?![\d@])/g;
  const CHALLAN_ENDING_RE = /challan ending\s*\*?(\d{4,10})\*?/gi;
  const RATING_RE = /\b(good|bad|excellent|poor|average)\b/i;
  const GREETING_RE = /^(hi+|hello+|hlo+|hey|hai|sir|hi gaadiinfo support|hi, i need help with gaadiinfo)[!. ]*$/i;

  function addAll(set, list) { list.forEach(x => set.add(x)); }

  /** Vehicle, order, challan, UTR, UPI, phone numbers and amounts mentioned anywhere. */
  function conversationEntities(messages, extraTexts) {
    const vehicles = new Set(), orders = new Set(), challans = new Set(), utrs = new Set(), amounts = new Set();
    const challanEndings = new Set(), upiIds = new Set(), phones = new Set();
    const texts = messages.filter(m => m.side !== 'internal' || m.role === 'note').map(m => m.text).concat(extraTexts || []);
    texts.forEach(raw => {
      const text = String(raw || '').replace(EXAMPLE_RE, '');
      const e = TM.extractEntities(text);
      addAll(vehicles, e.vehicles); addAll(orders, e.orders); addAll(challans, e.challans);
      addAll(utrs, e.utrs); addAll(amounts, e.amounts);
      let m;
      CHALLAN_ENDING_RE.lastIndex = 0;
      while ((m = CHALLAN_ENDING_RE.exec(text))) challanEndings.add(m[1]);
      UPI_RE.lastIndex = 0;
      while ((m = UPI_RE.exec(text))) upiIds.add(m[0].toLowerCase());
      PHONE_RE.lastIndex = 0;
      while ((m = PHONE_RE.exec(text))) phones.add(m[1]);
    });
    // Challans whose full number is known shouldn't also be listed by their ending.
    Array.from(challanEndings).forEach(end => {
      if (Array.from(challans).some(c => c.endsWith(end))) challanEndings.delete(end);
    });
    return {
      vehicles: Array.from(vehicles), orders: Array.from(orders), challans: Array.from(challans),
      challanEndings: Array.from(challanEndings), utrs: Array.from(utrs), upiIds: Array.from(upiIds),
      phones: Array.from(phones), amounts: Array.from(amounts)
    };
  }

  function isOptionPick(m) {
    return m.side === 'customer' && m.quote && m.quote.text.split(/\s*,\s*/).some(o => lower(o) === lower(m.text));
  }

  /**
   * What happened in the conversation, in plain facts.
   * @returns {Object}
   */
  function conversationFacts(conv, ctx) {
    const c = ctx || {};
    const now = c.now || new Date();
    const messages = conv.messages || [];
    const customer = messages.filter(m => m.side === 'customer');
    const business = messages.filter(m => m.side === 'business');
    const agentMsgs = business.filter(m => m.role === 'agent');
    const botMsgs = business.filter(m => m.role === 'bot');

    const picks = [];
    let rating = null;
    customer.forEach(m => {
      if (!m.quote) return;
      if (/good\s*,\s*bad|bad\s*,\s*good/i.test(m.quote.text) && RATING_RE.test(m.text)) rating = m.text.trim();
      else if (isOptionPick(m) && !picks.includes(m.text.trim())) picks.push(m.text.trim());
    });

    // What the customer actually wrote (not greetings, button taps or bare numbers)
    const statements = customer
      .filter(m => !m.quote && m.text && !GREETING_RE.test(m.text.trim()))
      .filter(m => !/^[a-z]{2}\s?\d{1,2}\s?[a-z]{1,3}\s?\d{4}$/i.test(m.text.trim()))
      .map(m => ({ at: m.at, text: m.text.trim() }));

    const lastAgent = agentMsgs[agentMsgs.length - 1] || null;
    const lastCustomer = customer[customer.length - 1] || null;
    const afterAgent = lastAgent ? customer.filter(m => m.at && lastAgent.at && new Date(m.at) > new Date(lastAgent.at)) : customer;
    const waitingSince = afterAgent.length ? afterAgent[0].at : null;

    const statusMsgs = business.filter(m => /challan status|order\s+gi-|status:/i.test(m.text));
    const latestStatus = statusMsgs.length ? statusMsgs[statusMsgs.length - 1] : null;

    const entities = conversationEntities(messages, c.extraTexts);
    // Category from what the customer wrote - usually far more telling than the subject.
    const customerText = statements.map(s => s.text).concat(picks.filter(p => !/order status|other question|need more help|solved/i.test(p))).join(' . ');
    const suggestion = customerText ? TM.classifySubject(customerText) : null;

    const dates = messages.map(m => m.at).filter(Boolean).sort();
    const customerSessions = new Set(customer.map(m => m.threadId)).size;
    return {
      customerName: (customer[0] && customer[0].author) || null,
      counts: { customer: customer.length, bot: botMsgs.length, agent: agentMsgs.length, notes: messages.filter(m => m.role === 'note').length, sessions: conv.sessions || 0, customerSessions },
      firstAt: dates[0] || null,
      lastAt: dates[dates.length - 1] || null,
      picks,
      rating,
      statements,
      lastCustomer: lastCustomer ? { at: lastCustomer.at, text: lastCustomer.text } : null,
      lastAgent: lastAgent ? { at: lastAgent.at, author: lastAgent.author, text: lastAgent.text } : null,
      humanReplied: agentMsgs.length > 0,
      waitingForHuman: !!waitingSince,
      waitingSince,
      waitingHours: waitingSince ? Math.max(0, (now - new Date(waitingSince)) / 3600000) : null,
      statusShared: latestStatus ? { at: latestStatus.at, text: latestStatus.text, truncated: latestStatus.truncated, role: latestStatus.role, author: latestStatus.author } : null,
      entities,
      suggestion: suggestion && suggestion.category !== T.UNCLASSIFIED ? suggestion : null
    };
  }

  function fmtDay(iso) {
    if (!iso) return '';
    return new Intl.DateTimeFormat('en-IN', { timeZone: T.TIMEZONE.id, day: 'numeric', month: 'short' }).format(new Date(iso));
  }
  function fmtHours(h) {
    if (h === null || h === undefined) return '';
    if (h < 1) return 'under an hour';
    if (h < 48) return `${Math.round(h)} hours`;
    return `${Math.round(h / 24)} days`;
  }
  function quoteText(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  /** A short plain-language summary built only from the facts above. */
  function summarise(facts, ctx) {
    const c = ctx || {};
    const channelLabel = c.channelLabel || 'chat';
    const parts = [];
    const who = facts.customerName || 'The customer';
    const span = facts.firstAt && facts.lastAt && fmtDay(facts.firstAt) !== fmtDay(facts.lastAt)
      ? `between ${fmtDay(facts.firstAt)} and ${fmtDay(facts.lastAt)}` : facts.firstAt ? `on ${fmtDay(facts.firstAt)}` : '';
    const n = facts.counts.customerSessions;
    const sessions = n > 1 ? `${n} times` : 'once';
    parts.push(`${who} contacted us on ${channelLabel} ${sessions}${span ? ' ' + span : ''} and sent ${facts.counts.customer} message${facts.counts.customer === 1 ? '' : 's'}.`);

    const e = facts.entities;
    const refs = [];
    if (e.vehicles.length) refs.push(`vehicle ${e.vehicles.join(', ')}`);
    if (e.orders.length) refs.push(`order ${e.orders.join(', ')}`);
    if (e.challans.length) refs.push(`challan ${e.challans.join(', ')}`);
    else if (e.challanEndings.length) refs.push(`challan ending ${e.challanEndings.join(', ')}`);
    if (refs.length) parts.push(`It concerns ${refs.join(', ')}.`);

    if (facts.picks.length) parts.push(`They chose: ${facts.picks.join(', ')}.`);
    if (facts.statements.length) {
      const last = facts.statements[facts.statements.length - 1];
      parts.push(`${facts.statements.length > 1 ? 'Latest' : 'They wrote'}: “${quoteText(last.text, 140)}”.`);
    }
    if (facts.statusShared) {
      parts.push(facts.statusShared.role === 'bot'
        ? `The bot shared the challan status on ${fmtDay(facts.statusShared.at)}.`
        : `${facts.statusShared.author || 'An agent'} sent an order update on ${fmtDay(facts.statusShared.at)}.`);
    }
    if (facts.rating) parts.push(`They rated an earlier chat “${facts.rating}”.`);
    if (!facts.humanReplied) {
      parts.push(facts.waitingSince
        ? `No agent has replied yet — waiting ${fmtHours(facts.waitingHours)}.`
        : 'No agent has replied yet.');
    } else if (facts.waitingForHuman) {
      parts.push(`Last agent reply was on ${fmtDay(facts.lastAgent.at)}; the customer has written since and has been waiting ${fmtHours(facts.waitingHours)}.`);
    } else {
      parts.push(`${facts.lastAgent.author || 'An agent'} replied last, on ${fmtDay(facts.lastAgent.at)}.`);
    }
    return parts.join(' ');
  }

  return {
    htmlToText, decodeEntities, parseTranscriptTime, parseImTranscript, stripEmailQuote,
    buildConversation, conversationEntities, conversationFacts, summarise
  };
});

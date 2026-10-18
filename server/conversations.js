/**
 * Fetches a ticket's full conversation from Zoho Desk (all WhatsApp sessions,
 * emails and internal comments), caches the raw payloads, and returns the
 * normalised message list from src/conversation.js.
 */
const { buildConversation } = require('../src/conversation');
const { mapLimit, ZohoError } = require('./zoho');

const PAGE = 100;

async function fetchRaw(zoho, ticketId) {
  const items = [];
  for (let from = 0; ; from += PAGE) {
    const page = await zoho.get(`/tickets/${ticketId}/conversations`, { from, limit: PAGE });
    const data = page.data || [];
    items.push(...data);
    if (data.length < PAGE) break;
  }
  const threadItems = items.filter(it => it.type === 'thread');
  const details = await mapLimit(threadItems, 4, it =>
    zoho.get(`/tickets/${ticketId}/threads/${it.id}`, { include: 'plainText' }).catch(err => ({ __error: err.message }))
  );
  const threads = {};
  const failed = [];
  threadItems.forEach((it, i) => {
    if (details[i] && !details[i].__error) threads[it.id] = details[i];
    else failed.push(it.id);
  });
  return { items, threads, failed };
}

function createConversationService({ zoho, cache, ttlMs, now }) {
  const clock = now || (() => new Date());

  /**
   * @param {string} ticketId
   * @param {{refresh?:boolean, modifiedAt?:string, threadCount?:number, ticket?:Object, agents?:Object}} opts
   */
  async function get(ticketId, opts) {
    const o = opts || {};
    const cached = cache.read('conversations', ticketId);
    // Stale when the ticket changed after we fetched it, or Zoho now has more message threads.
    const cachedThreads = cached ? cached.raw.items.filter(it => it.type === 'thread').length : 0;
    const fresh = cached && clock() - new Date(cached.fetchedAt) < ttlMs &&
      (!o.modifiedAt || new Date(cached.fetchedAt) >= new Date(o.modifiedAt)) &&
      (o.threadCount === null || o.threadCount === undefined || isNaN(o.threadCount) || cachedThreads >= o.threadCount);

    let record = cached;
    let source = 'cache';
    if (!zoho.configured) {
      if (!cached) throw new ZohoError('not_configured', 'Zoho Desk is not connected on the server, so conversations cannot be loaded.');
    } else if (o.refresh || !fresh) {
      const raw = await fetchRaw(zoho, ticketId);
      record = { ticketId, fetchedAt: clock().toISOString(), raw };
      cache.write('conversations', ticketId, record);
      source = 'zoho';
    }

    const conv = buildConversation(record.raw, { ticket: o.ticket, agents: o.agents });
    if (record.raw.failed && record.raw.failed.length) {
      conv.warnings.push(`${record.raw.failed.length} message thread(s) could not be loaded from Zoho.`);
    }
    return {
      ticketId,
      fetchedAt: record.fetchedAt,
      source,
      stale: source === 'cache' && !fresh,
      sessions: conv.sessions,
      messages: conv.messages,
      warnings: conv.warnings
    };
  }

  return { get };
}

module.exports = { createConversationService, fetchRaw };

#!/usr/bin/env node
/**
 * fetch-tickets.js
 * Pulls tickets from the Zoho Desk API and writes data/tickets.json.
 * Used by the GitHub Actions workflow (.github/workflows/fetch-tickets.yml).
 *
 * Read-only: the script only makes GET requests. Nothing is written to Zoho.
 * See docs/zoho-integration.md for what each run does and what changed.
 *
 * Environment variables:
 *   ZOHO_ORG_ID           Zoho Desk organization ID
 *   ZOHO_API_TOKEN        OAuth access token with Desk.tickets.READ scope
 *   ZOHO_DOMAIN           API domain, e.g. desk.zoho.in or desk.zoho.com (default: desk.zoho.in)
 *   CLOSED_LOOKBACK_DAYS  Optional. Also keep closed tickets created in the last N days in
 *                         `closedTickets`. Default 0 = open tickets only (original behaviour).
 *
 * Output (schemaVersion 2 - a superset of the original file):
 *   fetchedAt, tickets, contacts, agents   same keys and meaning as before
 *                                          (`tickets` = every ticket that is not closed)
 *   closedTickets                          closed tickets in the lookback window
 *   sync                                   run metadata: counts, duplicates removed, failures
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { statusGroupFor } = require('../src/taxonomy');
const { dedupeById } = require('../src/ticket-model');

const SCHEMA_VERSION = 2;
const PAGE_LIMIT = 100;

// Fields requested from the list-tickets API. The first group is what the
// original script requested; the second was added for the dashboard and was
// checked against the live API (Zoho silently ignores unknown field names, and
// only returns statusType when status is also requested).
const TICKET_FIELDS = [
  'id', 'subject', 'status', 'createdTime', 'closedTime', 'priority', 'channel', 'threadCount',
  'contactId', 'assigneeId', 'customerResponseTime', 'webUrl',
  'ticketNumber', 'statusType', 'modifiedTime', 'channelCode', 'category', 'subCategory',
  'dueDate', 'responseDueDate', 'onholdTime', 'departmentId', 'isSpam'
];

function createClient({ orgId, token, domain }) {
  const base = `https://${domain}/api/v1`;
  const headers = {
    'Authorization': `Zoho-oauthtoken ${token}`,
    'orgId': orgId,
    'Content-Type': 'application/json'
  };

  function request(urlPath) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, base);
      const opts = { headers, method: 'GET' };
      https.get(url.href, opts, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 204) {
            resolve({ data: [] }); // Zoho returns 204 No Content past the last page
          } else if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          } else {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(new Error('Invalid JSON: ' + body.slice(0, 200))); }
          }
        });
      }).on('error', reject);
    });
  }

  return { base, request };
}

const pause = ms => new Promise(r => setTimeout(r, ms));

/**
 * Page through every ticket (all statuses). Any page failure aborts the run, so
 * a partial ticket list is never written.
 * `opts.fields: null` asks Zoho for its default field set instead (adds
 * lastThread and the ticket's email / phone) - used by the private workspace
 * server only, never by this public sync.
 */
async function fetchAllTickets(client, opts) {
  const fields = opts && opts.fields === null ? null : TICKET_FIELDS;
  const collected = [];
  let from = 0;
  let pages = 0;

  while (true) {
    const url = `${client.base}/tickets?from=${from}&limit=${PAGE_LIMIT}${fields ? `&fields=${fields.join(',')}` : ''}&sortBy=createdTime`;
    const data = await client.request(url);
    const tickets = data.data || [];
    pages++;
    if (tickets.length === 0) break;
    collected.push(...tickets);
    if (tickets.length < PAGE_LIMIT) break;
    from += PAGE_LIMIT;

    // Rate-limit courtesy: 200ms pause between pages
    await pause(200);
  }

  // Offset pagination can return a ticket twice when tickets share a createdTime.
  const { tickets, duplicates } = dedupeById(collected);
  return { tickets, pages, scanned: collected.length, duplicatesRemoved: duplicates };
}

function isClosedTicket(t) {
  return statusGroupFor(t.status, t.statusType) === 'closed';
}

function parseLookbackDays(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : 0;
}

/**
 * Split into `tickets` (not closed - the original output) and `closedTickets`
 * (closed and created within the lookback window).
 */
function splitTickets(all, { lookbackDays, now }) {
  const open = all.filter(t => !isClosedTicket(t));
  const closedCreatedSince = lookbackDays > 0 ? new Date(now.getTime() - lookbackDays * 86400000) : null;
  const closed = closedCreatedSince
    ? all.filter(t => isClosedTicket(t) && t.createdTime && new Date(t.createdTime) >= closedCreatedSince)
    : [];
  return { open, closed, closedCreatedSince };
}

async function fetchContacts(client, ids) {
  const contacts = {};
  const failures = [];
  const unique = [...new Set(ids.filter(Boolean))];
  for (const id of unique) {
    try {
      const c = await client.request(`${client.base}/contacts/${id}?fields=id,firstName,lastName,email,phone`);
      contacts[id] = c;
    } catch (e) {
      console.warn(`Could not fetch contact ${id}: ${e.message}`);
      failures.push({ contactId: id, error: e.message.slice(0, 120) });
    }
    await pause(100);
  }
  return { contacts, failures };
}

async function fetchAgents(client) {
  try {
    const data = await client.request(`${client.base}/agents?limit=100`);
    const agents = (data.data || []).reduce((map, a) => {
      map[a.id] = { id: a.id, name: a.name || `${a.firstName || ''} ${a.lastName || ''}`.trim(), email: a.emailId };
      return map;
    }, {});
    return { agents, error: null };
  } catch (e) {
    console.warn('Could not fetch agents:', e.message);
    return { agents: {}, error: e.message.slice(0, 120) };
  }
}

function buildSnapshot({ startedAt, finishedAt, open, closed, closedCreatedSince, lookbackDays, contacts, agents,
  contactFailures, agentsError, pages, scanned, duplicatesRemoved }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    fetchedAt: finishedAt.toISOString(),
    tickets: open,
    closedTickets: closed,
    contacts,
    agents,
    sync: {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      pagesFetched: pages,
      recordsScanned: scanned,
      duplicatesRemoved,
      openTickets: open.length,
      closedTicketsIncluded: closed.length,
      closedLookbackDays: lookbackDays,
      closedCreatedSince: closedCreatedSince ? closedCreatedSince.toISOString() : null,
      contactFailures,
      agentsError
    }
  };
}

/** Write via a temp file + rename so a crash never leaves a half-written file. */
function writeAtomic(file, data) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

async function main() {
  const orgId = process.env.ZOHO_ORG_ID;
  const token = process.env.ZOHO_API_TOKEN;
  const domain = process.env.ZOHO_DOMAIN || 'desk.zoho.in';
  if (!orgId || !token) {
    console.error('Missing ZOHO_ORG_ID or ZOHO_API_TOKEN environment variables.');
    process.exit(1);
  }
  const lookbackDays = parseLookbackDays(process.env.CLOSED_LOOKBACK_DAYS);
  const client = createClient({ orgId, token, domain });
  const startedAt = new Date();

  console.log(`Fetching tickets from ${domain}...`);
  const { tickets: all, pages, scanned, duplicatesRemoved } = await fetchAllTickets(client);
  const { open, closed, closedCreatedSince } = splitTickets(all, { lookbackDays, now: startedAt });
  console.log(`Fetched ${all.length} tickets (${duplicatesRemoved} duplicate records removed): ` +
    `${open.length} not closed, ${closed.length} closed within ${lookbackDays} day lookback.`);

  const { contacts, failures } = await fetchContacts(client, open.map(t => t.contactId));
  console.log(`Fetched ${Object.keys(contacts).length} contacts (${failures.length} failed).`);

  const { agents, error: agentsError } = await fetchAgents(client);
  console.log(`Fetched ${Object.keys(agents).length} agents.`);

  const snapshot = buildSnapshot({
    startedAt, finishedAt: new Date(), open, closed, closedCreatedSince, lookbackDays, contacts, agents,
    contactFailures: failures, agentsError, pages, scanned, duplicatesRemoved
  });

  const outFile = path.join(__dirname, '..', 'data', 'tickets.json');
  writeAtomic(outFile, snapshot);
  console.log(`Written to ${outFile}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

module.exports = { TICKET_FIELDS, isClosedTicket, parseLookbackDays, splitTickets, buildSnapshot, fetchAllTickets, writeAtomic };

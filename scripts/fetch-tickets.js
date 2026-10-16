#!/usr/bin/env node
/**
 * fetch-tickets.js
 * Pulls all non-closed tickets from Zoho Desk API and writes data/tickets.json.
 * Used by the GitHub Actions workflow (.github/workflows/fetch-tickets.yml).
 *
 * Environment variables:
 *   ZOHO_ORG_ID    â Zoho Desk organization ID
 *   ZOHO_API_TOKEN â OAuth access token with Desk.tickets.READ scope
 *   ZOHO_DOMAIN    â API domain, e.g. desk.zoho.in or desk.zoho.com (default: desk.zoho.in)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ORG_ID = process.env.ZOHO_ORG_ID;
const TOKEN = process.env.ZOHO_API_TOKEN;
const DOMAIN = process.env.ZOHO_DOMAIN || 'desk.zoho.in';

if (!ORG_ID || !TOKEN) {
  console.error('Missing ZOHO_ORG_ID or ZOHO_API_TOKEN environment variables.');
  process.exit(1);
}

const BASE = `https://${DOMAIN}/api/v1`;
const HEADERS = {
  'Authorization': `Zoho-oauthtoken ${TOKEN}`,
  'orgId': ORG_ID,
  'Content-Type': 'application/json'
};

function request(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const opts = { headers: HEADERS, method: 'GET' };
    https.get(url.href, opts, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        } else {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('Invalid JSON: ' + body.slice(0, 200))); }
        }
      });
    }).on('error', reject);
  });
}

async function fetchAllTickets() {
  const allTickets = [];
  let from = 0;
  const limit = 100;
  const fields = 'id,subject,status,createdTime,closedTime,priority,channel,threadCount,contactId,assigneeId,customerResponseTime,webUrl';

  while (true) {
    const url = `${BASE}/tickets?from=${from}&limit=${limit}&fields=${fields}&sortBy=createdTime`;
    const data = await request(url);
    const tickets = data.data || [];
    if (tickets.length === 0) break;

    // Filter out Closed tickets
    const open = tickets.filter(t => t.status !== 'Closed');
    allTickets.push(...open);

    if (tickets.length < limit) break;
    from += limit;

    // Rate-limit courtesy: 200ms pause between pages
    await new Promise(r => setTimeout(r, 200));
  }

  return allTickets;
}

async function fetchContacts(ids) {
  const contacts = {};
  const unique = [...new Set(ids.filter(Boolean))];
  for (const id of unique) {
    try {
      const c = await request(`${BASE}/contacts/${id}?fields=id,firstName,lastName,email,phone`);
      contacts[id] = c;
    } catch (e) {
      console.warn(`Could not fetch contact ${id}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return contacts;
}

async function fetchAgents() {
  try {
    const data = await request(`${BASE}/agents?limit=100`);
    return (data.data || []).reduce((map, a) => {
      map[a.id] = { id: a.id, name: a.name || `${a.firstName || ''} ${a.lastName || ''}`.trim(), email: a.emailId };
      return map;
    }, {});
  } catch (e) {
    console.warn('Could not fetch agents:', e.message);
    return {};
  }
}

async function main() {
  console.log(`Fetching tickets from ${DOMAIN} (org ${ORG_ID})...`);

  const tickets = await fetchAllTickets();
  console.log(`Fetched ${tickets.length} non-closed tickets.`);

  const contactIds = tickets.map(t => t.contactId);
  const contacts = await fetchContacts(contactIds);
  console.log(`Fetched ${Object.keys(contacts).length} contacts.`);

  const agents = await fetchAgents();
  console.log(`Fetched ${Object.keys(agents).length} agents.`);

  const output = {
    fetchedAt: new Date().toISOString(),
    tickets,
    contacts,
    agents
  };

  const outDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'tickets.json');
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`Written to ${outFile}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

# Zoho Desk integration

How ticket data gets from Zoho Desk to the dashboard, what each field means, and what changed in the dashboard update of 17 October 2026.

The integration is **read-only**: it makes GET requests only. The dashboard never sends replies, changes statuses, or writes anything to Zoho.

## Data paths

| Path | When it is used | What it loads |
|---|---|---|
| **Scheduled sync** (`.github/workflows/fetch-tickets.yml` → `scripts/fetch-tickets.js` → `data/tickets.json`) | Every 15 minutes and on manual run | Every ticket that is not closed, with contact details and agent names |
| **Live browser call** (`index.html`, only if a token is entered in ⚙ settings) | Tried first when a token is saved | The latest 100 tickets. Zoho usually blocks browser requests (CORS), and this path sends an empty `orgId` header (see known issues) |
| **Sample preview** | Only when someone clicks “Preview layout with sample data” | Generated tickets, labelled as not real |

## What the sync did before this change

1. Paged through `GET /api/v1/tickets` 100 at a time (`sortBy=createdTime`, ascending), requesting 12 fields: `id, subject, status, createdTime, closedTime, priority, channel, threadCount, contactId, assigneeId, customerResponseTime, webUrl`.
2. Dropped tickets whose `status` was exactly `"Closed"`.
3. Fetched each distinct contact one at a time (`GET /contacts/{id}`). A contact that failed to load was logged and left out.
4. Fetched up to 100 agents.
5. Wrote `{ fetchedAt, tickets, contacts, agents }` to `data/tickets.json`. The workflow committed it if it had changed.

Any ticket-page failure stopped the run before anything was written, so the previous file stayed in place.

## What changed

Every original key and its meaning is preserved: `tickets` is still "every ticket that is not closed", and `contacts` and `agents` are unchanged. The changes are additive or bug fixes.

| Change | Why |
|---|---|
| 11 more fields requested: `ticketNumber, statusType, modifiedTime, channelCode, category, subCategory, dueDate, responseDueDate, onholdTime, departmentId, isSpam` | Needed for correct status mapping, ticket numbers, and SLA/priority availability. The full field list was checked against the live API on 17 Oct 2026. Zoho ignores unknown field names silently, and returns `statusType` only when `status` is also requested. |
| Closed is decided by Zoho's `statusType`, not the status name | A custom status, `AUTO Closed No Response`, has `statusType: Closed`. The old exact-name check counted it as open. |
| Duplicate records are removed by Zoho ticket ID; the newest `modifiedTime` wins | Offset pagination returned the same ticket twice when two tickets share a `createdTime`: 1 duplicate in 900 records in the 17 Oct sample. Duplicates were being counted as separate tickets. |
| HTTP 204 is treated as "no more pages" | Zoho answers 204 (empty body) past the last page. The old script threw "Invalid JSON" whenever the ticket count was an exact multiple of 100. |
| Optional `closedTickets` list, controlled by the `CLOSED_LOOKBACK_DAYS` repository variable (default **0** = original behaviour) | Closed tickets are needed for period totals, closed counts and time-to-close. It is opt-in because it adds more customer data to the published file (see the privacy section). |
| `sync` block: pages, records scanned, duplicates removed, open/closed counts, lookback, `contactFailures`, `agentsError` | Contact and agent failures used to appear only in the Actions log. The dashboard now shows them. |
| `schemaVersion: 2` | The dashboard still reads version 1 files. |
| Atomic write (temp file + rename) | A crash mid-write can no longer leave a truncated file. |
| Workflow `concurrency` group | Two overlapping runs can no longer race on the commit. |
| The org ID is no longer printed in the run log | It is not needed there. |

Re-running the sync on unchanged Zoho data writes an identical file, so the commit step makes no commit. Zoho ticket IDs are kept as strings everywhere: they exceed JavaScript's safe-integer range and would be corrupted as numbers.

### Turning on closed tickets

In GitHub, go to Settings → Secrets and variables → Actions → **Variables** and add `CLOSED_LOOKBACK_DAYS`, for example `90`. Closed tickets *created* in that window are then included. The dashboard marks periods that start before the window as partial.

## Workspace server (added 17 October 2026)

`server/` is a separate, optional read path for agents. It is also read-only, and authenticates with a Self Client refresh token instead of an hourly access token. It calls:

| Endpoint | Used for |
|---|---|
| `GET /tickets` (same paging as the sync, without a `fields` list so Zoho adds `lastThread`, email and phone) | Full ticket list at start-up and every 60 minutes (catches deletes and merges) |
| `GET /tickets/search?modifiedTimeRange=<last check>,<now>&sortBy=-modifiedTime` | Every 30 seconds: only the tickets changed since the last check, with the customer's contact embedded. Usually one call. Each check re-reads the previous 2 minutes so nothing slips between checks |
| `GET /tickets/{id}/conversations` | Every thread and internal comment on a ticket |
| `GET /tickets/{id}/threads/{threadId}?include=plainText` | Full content of each thread. A WhatsApp thread is one chat session, delivered as an HTML transcript that `src/conversation.js` parses |
| `GET /tickets/{id}/metrics` | First response time, reply count and reopens for WhatsApp and email tickets, read in the background once per change (turn off with `ZOHO_TICKET_METRICS=off`). Zoho reports "00:00 hrs" with a reply count of 0 when nobody has replied; that is stored as "no reply yet", not as a 0-minute reply |
| `GET /contacts/{id}` | Customer name and contact details (cached for 7 days) |
| `GET /agents` | Agent names (cached for 1 hour) |
| `GET /tickets/{id}` | Fresh copy of a ticket before and after an agent action (only with `ZOHO_WRITE=on`) |
| `PATCH /tickets/{id}` | Agent actions: `assigneeId`, `status`, `resolution` (only with `ZOHO_WRITE=on`, only when an agent clicks) |
| `POST /tickets/{id}/comments` | The internal note recording each action (`isPublic: false`) |
| `GET /tickets/{id}/comments` | Checking whether a note that timed out was saved, before retrying |

Optionally, a Zoho Desk webhook can call the server's `POST /api/zoho/webhook?token=<secret>` on ticket changes. The server ignores the payload and simply runs the search check above straight away. It never writes back to Zoho.

Scopes needed: `Desk.tickets.READ, Desk.contacts.READ, Desk.basic.READ, Desk.search.READ`, plus `Desk.tickets.UPDATE` for agent actions (notes may need `Desk.tickets.ALL`; verify on a test ticket). The workspace never sends customer messages through the API. Conversations and contacts are cached in `.cache/` on the server machine, which is git-ignored. Setup: [workspace-server.md](workspace-server.md).

Facts about the WhatsApp data that shaped the parser, observed on 17 Oct 2026:

- The bot flow posts as **"Complaint Received"**.
- Customers' button taps arrive as replies quoting the bot's options.
- The bot's challan-status message is cut off with "…" in Zoho's transcript.
- Feedback replies such as "Sorry! we let you down." are sent automatically under an agent's name. They are treated as bot messages, not human replies.

## Field reference

What the dashboard shows, and where each value comes from. "Real" means taken from Zoho as-is, "derived" means computed by the dashboard, and "unavailable" means the data cannot support it yet. Coverage figures are from the 17 Oct 2026 sample of 899 tickets.

| Dashboard field | Source | Type | Notes |
|---|---|---|---|
| Ticket ID, number, subject, link | `id`, `ticketNumber`, `subject`, `webUrl` | Real | Only `https://desk.zoho.*` links are rendered |
| Created, closed, last customer message, last updated | `createdTime`, `closedTime`, `customerResponseTime`, `modifiedTime` | Real | Displayed and bucketed in IST |
| Status | `status` + `statusType` | Real, grouped | Groups are Open, On hold and Closed. Unknown statuses count as unresolved |
| Channel | `channel`, `channelCode` | Real, grouped | `GaadiInfo Care` / `Gaadi Info Cares` = WhatsApp (two numbers). Seen in the sample: 58% WhatsApp, 33% phone, 9% email |
| Owner | `assigneeId` + agents list | Real | 95% of tickets were unassigned |
| Customer name / email / phone | contacts list | Real | Open tickets only; failures are listed in `sync.contactFailures` |
| Priority | `priority` | Real but **empty** | Null on 100% of tickets, so the dashboard reports it as unavailable |
| Zoho category | `category`, `subCategory` | Real but **empty** | Null on 100% of tickets |
| SLA due date | `dueDate` | Real but **almost empty** | Set on 1 ticket, so SLA is reported as unavailable |
| Query type | Subject keyword rules, or an agent's correction | **Derived** | See `src/taxonomy.js`. About 64% stay unclassified because the subject is a greeting or template |
| Vehicle / order / challan / UTR numbers, amounts | Subject text | **Derived** | Pattern-matched; labelled "in subject" |
| No reply yet | `threadCount` ≤ 1 on WhatsApp/email | **Derived**, lower bound | Who sent the last message is not synced |
| Backlog age | `createdTime` vs page load | **Derived** | |
| Review flags | Category, keywords, repeat contact, uncertainty | **Derived** | |
| Conversation text | Workspace server, on demand | **Real** (server only) | Not in the public snapshot, on purpose |
| First response time | not synced | **Unavailable** | Needs the ticket metrics API, one call per ticket |
| Last message direction | Workspace server conversation | **Real per ticket** (server only) | Shown as "Agent reply: none yet / customer wrote again since" in the drawer; not yet aggregated across all tickets |

## Known issues (not changed)

- **The sync has never produced data.** `data/tickets.json` has never been committed and the Pages URL returns 404. Before this change, the live site therefore fell back to generated sample data, shown as if it were real. It now shows an empty state.
- **The access token expires.** `ZOHO_API_TOKEN` is an OAuth access token, which lasts about an hour. The scheduled sync will fail with HTTP 401 until it uses a refresh-token flow.
- **Contact fetching is one request per contact.** The 17 Oct sample had 435 distinct contacts on open tickets. That is about 435 requests per run, or roughly 42,000 a day at a 15-minute schedule, which is likely to hit Zoho API credit limits. `include=contacts` on the list call, or caching contacts between runs, would remove most of these calls.
- **The live browser path sends an empty `orgId` header.** The setup form asks for an org *domain*, not an org ID. It now requests the newest 100 tickets (`-createdTime`) rather than the oldest 100.
- **Privacy.** The repository is public and GitHub Pages is public. Once the sync works, `data/tickets.json` will publish customer names, emails, phone numbers, and subjects containing vehicle numbers, UTRs and amounts. Move the data, or the whole dashboard, behind authentication before enabling the sync.

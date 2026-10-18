# GaadiInfo Support Dashboard

A lightweight, no-build HTML dashboard for GaadiInfo's WhatsApp and email escalations in Zoho Desk. It shows why customers are contacting us, the open backlog, and a working ticket queue. It is designed for GitHub Pages deployment.

> **Privacy:** this repository and its GitHub Pages site are public. Once the sync runs, `data/tickets.json` contains customer names, emails, phone numbers and ticket subjects. Put the data behind authentication before enabling the sync. See [docs/zoho-integration.md](docs/zoho-integration.md).

![Dashboard Preview](https://img.shields.io/badge/status-active-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

## Quick Start

1. **Clone this repo**
   ```bash
   git clone https://github.com/YOUR_USERNAME/gaadiinfo-dashboard.git
   cd gaadiinfo-dashboard
   ```

2. **Serve the folder and open it** (for example `python3 -m http.server`, then open http://localhost:8000). The setup overlay offers two options:
   - **Connect to Zoho Desk**: enter an API token to try loading tickets live from the browser. Generate a token at [Zoho API Console](https://api-console.zoho.com/).
   - **Continue with synced data**: use `data/tickets.json` from the scheduled sync.

3. **Deploy to GitHub Pages**
   - Go to repo Settings → Pages → Source: `main` branch, `/ (root)` folder → Save
   - Your dashboard will be live at `https://YOUR_USERNAME.github.io/gaadiinfo-dashboard/`

## Workspace server (full chats, summaries, challan details)

Run the dashboard through the workspace server to work tickets end to end. It adds:

- an agent Inbox (customers waiting for a reply, longest wait first; Follow-ups; Mine) with the ticket open beside it
- a Next step card on every ticket — assign, waiting with a follow-up date, resolve with a reason, escalate, internal notes — written straight to Zoho when `ZOHO_WRITE=on`, read back before it shows as saved
- the customer's phone and email, with Call, Email and Copy buttons
- full WhatsApp and email conversations, and a summary of each chat (rule-based, plus optional AI from Claude)
- vehicle, order and challan numbers pulled from the chat, and the challan status the bot shared
- suggested replies from Claude in Hinglish, Hindi and English, following an editable playbook ([server/reply-playbook.md](server/reply-playbook.md)); agents check, copy and send them from Zoho
- an Overview for managers: new vs closed, waiting times, reasons for contact, arrival times, channels, team, and first response times from Zoho
- live updates: changes in Zoho reach every open browser within about 30 seconds, or near-instantly with the optional webhook

Start it with:

```bash
npm install
npm start          # http://localhost:8000
```

One-time setup (Zoho refresh token, optional Anthropic key and status service): [docs/workspace-server.md](docs/workspace-server.md). Conversations and credentials stay on the machine running the server. Never publish them through the public repository or GitHub Pages.

## Data Refresh Options

The dashboard tries these sources in order:

### Option A: Direct API (simplest)
Enter your Zoho Desk credentials in the setup screen. The dashboard calls the Zoho Desk API directly from the browser. This works when Zoho's CORS policy allows it (typically from `localhost` or approved origins).

### Option B: Pre-fetched JSON via GitHub Actions (recommended for GitHub Pages)
Since Zoho Desk API doesn't allow browser CORS from arbitrary origins, the recommended approach for GitHub Pages is a scheduled GitHub Actions workflow that fetches ticket data and commits it as `data/tickets.json`.

**Setup:**
1. Go to repo Settings → Secrets and variables → Actions
2. Add these repository secrets:
   - `ZOHO_ORG_ID` — your Zoho Desk org ID
   - `ZOHO_API_TOKEN` — your Zoho Desk OAuth token
   - `ZOHO_DOMAIN` — your Zoho domain (e.g. `desk.zoho.in` or `desk.zoho.com`)
3. Enable the workflow: Actions → "Fetch Zoho Desk Tickets" → Enable workflow
4. The workflow runs every 15 minutes and on manual trigger
5. Optional: add a repository **variable** (not secret) `CLOSED_LOOKBACK_DAYS`, e.g. `90`, to also sync closed tickets created in that window. This enables closed counts, time-to-close and complete period totals. Leave it unset to keep the original open-tickets-only behaviour.

The dashboard automatically detects `data/tickets.json` and uses it when direct API calls fail. The header shows when the data was last synced, and warns if the sync looks like it has stopped (no successful run in 45 minutes).

### No data
If neither source is available, the dashboard says so and explains how to fix it. It no longer substitutes sample data automatically. A **"Preview layout with sample data"** button loads clearly labelled generated tickets for trying the interface.

What the sync does, what changed, and which fields are real, derived or unavailable: [docs/zoho-integration.md](docs/zoho-integration.md).

## File Structure

```
├── index.html                          # Dashboard UI
├── src/
│   ├── taxonomy.js                     # Query categories, status/channel/priority mappings, keyword rules (edit here)
│   ├── ticket-model.js                 # Snapshot adapter, normalisation, dedupe, classification, corrections
│   └── metrics.js                      # Filters, aggregations, metric definitions and availability
├── data/
│   └── tickets.json                    # Auto-generated by GitHub Actions
├── scripts/
│   └── fetch-tickets.js                # Node.js script used by GitHub Actions
├── test/                               # node --test suites
├── docs/
│   └── zoho-integration.md             # Integration behaviour and field reference
├── .github/
│   └── workflows/
│       └── fetch-tickets.yml           # Scheduled data fetch workflow
└── README.md
```

## Features

- **Why customers are contacting us**: tickets by query type (challan status, refunds, payment issues and so on). Types are suggested from the subject by keyword rules (English and Hinglish), and any ticket without enough evidence stays "Other / unclassified"
- **Summary**: tickets, open and unresolved, unassigned, no reply yet. Closed count, time to close and SLA overdue appear when the data supports them. Anything not yet measurable is listed with the reason
- **New tickets per day** (IST), channel, status, backlog age and owner breakdowns. Select any row to filter
- **One filter bar** (created date, channel, query type, status, owner, search), applied to every number and list
- **Needs attention**: unresolved tickets with review flags (complaints, legal language, refunds and payments, repeat customers), with the riskiest first
- **Ticket queue** with a detail drawer: status, channel, owner, timestamps, customer, vehicle/order numbers found in the subject, review flags, and a link to reply in Zoho
- **Category corrections** with history. These are saved in the browser until a shared store exists, and can be exported as JSON
- **Customer View**: customers with the most tickets
- **Agent table**: tickets, unresolved, closed and time to close per owner
- **Dark Mode** — follows the system theme
- **Responsive** — Works on desktop, tablet, and phone

## Zoho Desk API Setup

1. Go to [Zoho API Console](https://api-console.zoho.com/)
2. Create a **Self Client** application
3. Generate a token with scope: `Desk.tickets.READ, Desk.contacts.READ, Desk.basic.READ`
4. Use the access token in the dashboard setup or as the `ZOHO_API_TOKEN` secret

> **Note:** OAuth tokens expire. For long-running setups, use a refresh token flow in the GitHub Actions script. See `scripts/fetch-tickets.js` for details.

## Local Development

No build step. Serve the folder with any static server (`python3 -m http.server`) and open it. Browsers block `fetch()` of `data/tickets.json` from `file://` URLs.

Category names, status and channel mappings, and classification rules live only in `src/taxonomy.js`.

Run the tests (Node 20+, no dependencies):

```bash
npm test
```

## License

MIT — built for [GaadiInfo / Vehicore Technologies](https://gaadiinfo.com)

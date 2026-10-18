# Workspace server

The workspace server runs the escalation dashboard with everything an agent needs to work a ticket in one place:

- an **Inbox**: a queue of customers waiting for a reply (longest wait first), with the ticket open beside it
- the **customer's phone number and email**, with Call, Email and Copy buttons, plus any other numbers they typed in the chat
- the **full conversation**: every WhatsApp session (customer, bot and agent messages, button choices), every email, and internal notes. "Key messages" folds the bot menus into one line per chat; "Everything" shows them all
- a **summary** of the chat, built from the messages without AI, plus an optional **AI summary** from Claude
- a **suggested reply** drafted by Claude in Hinglish, Hindi and English, with what to check before sending (see [Suggested replies](#suggested-replies))
- **vehicle, order and challan numbers**, amounts, UTR and UPI IDs found anywhere in the chat, with copy buttons
- the **challan status** the WhatsApp bot already shared, and a live status check once GaadiInfo's status service is connected
- **live updates**: new tickets and new customer messages appear within about 30 seconds, without reloading the page (see [How it stays live](#how-it-stays-live))
- an **Overview** for managers: new vs closed, customers waiting and for how long, why customers contact us, when tickets arrive, channels, the team, ownership and next steps, and first response times read from Zoho
- a **Next step** card on every ticket: assign, take over or hand over; waiting on customer, team or partner with a follow-up date; resolve with a reason; escalate; internal notes. Each change is written to Zoho (see [Changing tickets from the workspace](#changing-tickets-from-the-workspace))
- **Follow-ups** and **Mine** queues, so a ticket with a passed follow-up date, or with no next step at all, can't be forgotten

It **never messages customers**: replies are still sent from Zoho Desk. Ticket changes (owner, status, notes) are written to Zoho only when `ZOHO_WRITE=on` and an agent clicks; otherwise the workspace only reads.

## Why a server

Customer chats contain names, phone numbers, UPI IDs and payment details. The GitHub repository and its Pages site are public, so this data must never be committed there. The server keeps the Zoho and Anthropic credentials, and the cached conversations, on the machine it runs on. Browsers only talk to the server.

## Set it up (about 10 minutes, once)

You need Node.js 20 or later.

```bash
npm install
```

### 1. Connect Zoho Desk (one-time refresh token)

A refresh token doesn't expire, unlike the hourly access tokens. The server swaps it for a fresh access token automatically, so you never paste a token again.

1. Open the [Zoho API Console](https://api-console.zoho.in/) and choose **Self Client**. Create one if needed. Copy the **Client ID** and **Client Secret**.
2. On the **Generate Code** tab, enter the scope `Desk.tickets.READ,Desk.tickets.UPDATE,Desk.contacts.READ,Desk.basic.READ,Desk.search.READ`, choose 10 minutes, and click **Create**. Copy the grant code. (`Desk.search.READ` lets the server fetch only changed tickets every 30 seconds; `Desk.tickets.UPDATE` lets agents change tickets from the workspace — leave it out to stay read-only.)
3. Within those 10 minutes, run:

   ```bash
   ZOHO_CLIENT_ID=<client id> ZOHO_CLIENT_SECRET=<client secret> npm run zoho:token -- <grant code>
   ```

   This saves the refresh token to `.env.local`. That file is git-ignored, and the token is never printed.
4. Add your Zoho Desk organisation ID to `.env.local`. It's in Zoho Desk → Setup → Developer Space → API.

   ```
   ZOHO_ORG_ID=<org id>
   ```

### 2. Optional: Claude (suggested replies and AI summaries)

1. Sign in to the [Claude Console](https://console.anthropic.com/) with the account that has your Claude API credits, open **API keys**, and create a key named, say, `gaadiinfo-workspace`.
2. Add it to `.env.local` on the server machine. Don't paste it into chat, email or the repository.

   ```
   ANTHROPIC_API_KEY=<key>
   ```

3. If your key isn't tied to a workspace, Claude answers "This API key is not scoped to a workspace". Either create the key inside a workspace (Console → Workspaces → choose one → API keys), or add the workspace's ID (it starts with `wrkspc_`):

   ```
   ANTHROPIC_WORKSPACE_ID=<wrkspc_…>
   ```

4. Restart the server (`npm start`). The start-up log should say `AI suggested replies: on` and `AI summaries: on`.
5. Optional but recommended: in the Console, set a monthly spend limit for the workspace the key belongs to.

Nothing is generated until an agent clicks **Suggest a reply** or **Summarise with AI**. Results are cached until the conversation changes, so reopening a ticket costs nothing. Each request sends that one ticket's conversation to Anthropic. With the default model, `claude-opus-5-5` (US$4 per million input tokens and US$20 per million output tokens at list price), expect roughly 5–12 US cents per reply draft and less per summary; the Console's usage page shows the real figures. You can change the model with `AI_MODEL`.

What the AI summary does and doesn't do:

- It is told to use only facts in the conversation, to copy vehicle, challan and payment references exactly, and never to promise refunds, timelines or outcomes.
- It treats the transcript as data, so instructions written by a customer are ignored.
- If Claude's safety checks decline a request, the server automatically retries on Anthropic's recommended fallback model (`fallbacks: "default"`). If every model declines, the agent sees "Claude declined to summarise this conversation".
- Agents can still use the rule-based summary, which needs no AI and is always shown.

### 3. Optional: live challan status

GaadiInfo's WhatsApp bot already looks up "Your Challan Status" by vehicle number. If that service has an HTTP endpoint, point the server at it:

```
GAADIINFO_STATUS_URL=https://<internal host>/<path>?vehicle={vehicle}&order={order}
GAADIINFO_STATUS_TOKEN=<token, sent as Authorization: Bearer>   # if it needs one
```

`{vehicle}`, `{order}` and `{challan}` are filled in from the ticket. Each vehicle and order number in the drawer then gets a **Status** button. Until this is set, the drawer shows the status the bot shared in the chat and a link to the government e-challan site.

### 4. Start it

```bash
npm start
```

Open http://localhost:8000. With the server, there is no token screen; the server holds the credentials.

## Suggested replies

Open a ticket and click **Suggest a reply**. Claude reads the whole conversation, the numbers found in it, the query type, the live status result (if the status service is connected) and GaadiInfo's reply playbook, and returns:

- **Customer needs** — one line on what they want now
- **Do first** — what the agent should do before or alongside replying
- **Check before sending** — facts the reply depends on; each one appears in the draft as a placeholder such as `[settlement date]`
- **Asks the customer for** — details the reply requests (vehicle number, order ID, UTR…)
- the **same reply in Hinglish, Hindi (Devanagari) and English**; the tab for the language the customer writes in opens first

The agent edits the text if needed, clicks **Copy reply** and sends it from Zoho Desk. The workspace never sends anything itself. To steer a draft, type a note such as "refund was started on 12 Oct" and click **Regenerate**.

Safeguards:

- **Playbook.** [`server/reply-playbook.md`](../server/reply-playbook.md) holds tone, what may and may not be promised, what to ask for, and when to escalate. Edit it; the next draft uses it, with no restart. Anything marked **[NOT SET]** (refund and settlement timelines, for example) is never stated to customers until you fill it in. The repository is public: for internal-only rules, copy the file outside the repository and set `REPLY_PLAYBOOK_FILE`.
- **No invented facts or promises.** Missing facts become `[placeholders]` that the agent must fill, and **Copy reply** warns if any are left. Refunds, timelines and outcomes are never promised unless the playbook, the status service or the agent's note says so.
- **Customer text is data.** Instructions written by a customer inside the chat are ignored.
- **Supervisor flag** for legal threats, abuse, double deductions and the other cases in the playbook.
- **WhatsApp 24-hour window.** If the customer last wrote more than 24 hours ago, the card says that WhatsApp only allows a free-form reply within 24 hours, so Zoho will ask for an approved template (or the agent can call).
- **Stale drafts.** If the customer writes again after a draft was made, the card says so and offers to regenerate.
- If Claude's safety checks decline a request, Anthropic retries on its recommended fallback model. If every model declines, the agent sees an error and writes the reply themselves.

## How it stays live

```
Zoho Desk ──(every 30 s: "what changed since last check?")──▶ server ──(push)──▶ every open browser
          └─(optional webhook: "something changed", instant)─┘
```

1. **The server checks Zoho every 30 seconds** for tickets modified since its last check (`/tickets/search` with a time range). That is usually a single API call, about 2,900 a day. If your Zoho plan's API allowance is tight, raise `ZOHO_POLL_SECONDS`. Each check overlaps the previous one by 2 minutes, so a ticket edited at the boundary is never missed.
2. **Browsers are told immediately.** Each open workspace keeps a connection to the server (`/api/events`). When something changes, the ticket list refreshes in place. If the agent has that ticket open, its conversation reloads and a "New activity on this ticket" note appears. Nobody needs to press refresh.
3. **First response times.** After each change, the server reads Zoho's ticket metrics (`/tickets/{id}/metrics`) for that ticket: when the first agent reply came, how many replies, reopens. On first start it reads them for every WhatsApp and email ticket in the background, two at a time, which takes a few minutes; afterwards only changed tickets are read. Turn this off with `ZOHO_TICKET_METRICS=off`.
4. **A full reload runs every 60 minutes** to pick up deleted, merged or spam-marked tickets, which a "changed since" check can't see.
5. **Problems are shown, not hidden.** The top-right indicator reads "Live · checked 12s ago" when healthy. It changes to "Zoho sync problem — retrying" (with the error in a banner) if Zoho refuses a check, or "Live updates reconnecting…" if the browser loses its connection to the server. `/api/health` reports the same state.

### Optional: instant updates with a Zoho webhook

Polling means a new message can take up to 30 seconds to appear. For near-instant updates, let Zoho tell the server when something changes:

1. Add a long random secret to `.env.local` and restart the server:

   ```
   ZOHO_WEBHOOK_SECRET=<long random string>
   ```

2. The server must be reachable from the internet over HTTPS. If it runs on an office machine, use a tunnel such as Cloudflare Tunnel or ngrok, and keep `WORKSPACE_PASSWORD` set. Only the webhook path skips the password, and it requires the secret instead.
3. In Zoho Desk go to **Setup → Developer Space → Webhooks → New Webhook**:
   - URL: `https://<your public host>/api/zoho/webhook?token=<the same secret>`
   - Events: **Ticket Add**, **Ticket Update**, **Ticket Thread Add**
4. Save. If Zoho tests the URL first, the server answers with 200. Then update any ticket and check that the server log or `/api/health` shows a fresh `lastPollAt` within a few seconds.

The webhook carries no data the server trusts. It only makes the server run its normal check now instead of waiting for the next 30-second tick. If the webhook stops, polling carries on as before.

## Changing tickets from the workspace

Agents set what happens next without switching to Zoho. Every ticket has a **Next step** card:

| Button | What it does in Zoho | Required |
|---|---|---|
| Assign to me / Take over / Hand over | Sets the owner | — |
| Waiting on customer | Sets the waiting status (`On Hold`) and books a follow-up | Reason + follow-up date (max 14 days) |
| Waiting on team / partner | Same, waiting on GaadiInfo's team or the traffic department / bank | Reason + follow-up date |
| Resolve | Closes the ticket and fills Zoho's Resolution field | Resolution code + note; confirmation if the customer spoke last |
| Escalate | Assigns to the supervisor and sets the status back to Open | Reason |
| Add note / Reopen | Internal note / sets Open | Note |

How a change is made safe:

1. The server re-reads the ticket from Zoho. If someone changed it since the agent opened it (owner, status, a new message), it refuses and says what changed. The agent can look again or choose **Save anyway**.
2. It writes the change, then reads the ticket back. Only if Zoho shows the change does the agent see "Saved in Zoho ✓".
3. It adds an **internal** note: `[Workspace] Waiting on customer: Payment proof (UTR or screenshot). Follow up by … — Asha · ref ws-…`. Zoho attributes API changes to the account that owns the token, so the note records who actually did it.
4. It appends the action to `.cache/audit/YYYY-MM.jsonl`.

A double click or a retry carries the same action id, so it is applied once. If Zoho doesn't answer, the agent is told the change "may or may not have been saved", and **Retry** first checks Zoho for the note before posting again.

Follow-up dates live on the workspace server (and in the Zoho note) until a Zoho custom field is added for them. A customer message always puts the ticket back in **Needs reply**, whatever its follow-up date.

**Turn it on**

1. Generate the Zoho token with `Desk.tickets.UPDATE` (step 1 above). If adding notes fails with a permission error, regenerate it with `Desk.tickets.ALL` instead of `Desk.tickets.READ,Desk.tickets.UPDATE`.
2. Check that your Zoho statuses are named `Open`, `On Hold` and `Closed`. If not, set `ZOHO_STATUS_OPEN`, `ZOHO_STATUS_WAITING` and `ZOHO_STATUS_CLOSED`.
3. Add to `.env.local`:

   ```
   ZOHO_WRITE=on
   SUPERVISOR_EMAIL=<the supervisor's Zoho email>
   ```

4. Restart, and try every button on one test ticket. Confirm each change and note in Zoho.

**Check:** closing a ticket in Zoho may email the customer, depending on Zoho's notification settings. The workspace leaves that setting as it is.

**Turn it off:** set `ZOHO_WRITE=off` (or remove it) and restart. Agents change tickets in Zoho again; nothing else changes.

### Who did it: logins

Give each agent their own login, using the email of their Zoho agent account:

```
WORKSPACE_USERS=asha@gaadiinfo.com:<password>,ravi@gaadiinfo.com:<password>
```

Their actions are then recorded under their verified name. Without logins, agents pick their name under **Working as** (top right), and notes say "self-selected". With `WORKSPACE_USERS` set, the shared `WORKSPACE_PASSWORD` is not used. Passwords can't contain commas.

## Sharing it with the team

By default the server listens on this computer only (`127.0.0.1`). To let colleagues on the office network use it:

```
HOST=0.0.0.0
WORKSPACE_USERS=<email:password pairs, see above>   # or WORKSPACE_PASSWORD=<a strong shared password>
```

The server refuses to listen on a network address without logins or a password. Run it on an office machine or behind your VPN, never on a public host without HTTPS in front of it.

## Settings

All settings can go in `.env.local` or the environment.

| Variable | Default | Purpose |
|---|---|---|
| `ZOHO_ORG_ID` | none | Zoho Desk organisation ID (required for live data) |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` | none | Self Client credentials; written by `npm run zoho:token` |
| `ZOHO_API_TOKEN` | none | Alternative to a refresh token; stops working after about an hour |
| `ZOHO_DOMAIN` / `ZOHO_ACCOUNTS_DOMAIN` | `desk.zoho.in` / `accounts.zoho.in` | Zoho data centre |
| `ZOHO_POLL_SECONDS` | `30` | How often to check Zoho for changed tickets (minimum 10) |
| `ZOHO_FULL_REFRESH_MINUTES` | `60` | How often to reload the whole ticket list |
| `ZOHO_WEBHOOK_SECRET` | none | Turns on `/api/zoho/webhook` for instant updates |
| `ANTHROPIC_API_KEY` | none | Turns on suggested replies and AI summaries |
| `ANTHROPIC_WORKSPACE_ID` | none | Claude Console workspace to use, for keys not tied to one (sent as `anthropic-workspace-id`) |
| `AI_MODEL` | `claude-opus-5-5` | Model for suggested replies and AI summaries |
| `AI_REPLIES` | `on` | Set `off` to disable suggested replies even when a key is present |
| `AI_SUMMARIES` | `on` | Set `off` to disable AI summaries even when a key is present |
| `REPLY_PLAYBOOK_FILE` | `server/reply-playbook.md` | The rules suggested replies follow |
| `ZOHO_TICKET_METRICS` | `on` | Set `off` to stop reading first response times from Zoho |
| `GAADIINFO_STATUS_URL`, `GAADIINFO_STATUS_TOKEN` | none | Live challan / order status service |
| `CLOSED_LOOKBACK_DAYS` | `30` | Closed tickets created in this window are included, so the closed count and time to close work |
| `HOST`, `PORT` | `127.0.0.1`, `8000` | Where the server listens |
| `WORKSPACE_PASSWORD` | none | One shared password for the workspace (required when `HOST` is not local, unless `WORKSPACE_USERS` is set) |
| `WORKSPACE_USERS` | none | Named logins, `email:password` pairs separated by commas; the email must match the agent's Zoho email |
| `ZOHO_WRITE` | `off` | `on` lets agents change owner, status and notes in Zoho from the workspace |
| `ZOHO_STATUS_OPEN`, `ZOHO_STATUS_WAITING`, `ZOHO_STATUS_CLOSED` | `Open`, `On Hold`, `Closed` | Zoho status names the workspace sets |
| `SUPERVISOR_EMAIL` | none | Zoho email of the person escalations go to |
| `CACHE_DIR` | `.cache` | Cached conversations, contacts and AI summaries (contains customer data; git-ignored) |
| `SNAPSHOT_FILE` | `data/tickets.json` | Ticket list used when Zoho isn't connected |

## Data the server keeps

`.cache/` holds the conversations, contact details, Zoho ticket metrics, AI summaries and suggested-reply drafts it has fetched or generated. Contacts are refreshed after 7 days, or sooner when a changed ticket brings fresh details. Conversations are refreshed whenever the ticket changes or an agent clicks reload.

Phone numbers come from the Zoho contact (`mobile` for WhatsApp customers, `phone` for others) or the ticket itself. Emails come from the contact or the ticket. The Call and Email buttons only open the agent's own phone or mail app (`tel:` / `mailto:`); the workspace never contacts a customer by itself. Delete the folder to clear it. Category corrections are still stored in each agent's browser and can be exported from Reports.

## Without the server

`index.html` still works as a static page, on GitHub Pages or opened from disk, using `data/tickets.json`. It shows ticket subjects only, with a note that full chats need the server.

# OpenReach

**Self-hosted, open-source LinkedIn outreach automation.** Build drip campaigns that visit profiles, send connection requests, follow up when people accept and stop when they reply. Run them from several LinkedIn accounts, inside working hours and under strict safety limits. Everything stays on your own server.

OpenReach is an independent project. It is not affiliated with LinkedIn or with any commercial outreach tool.

> **Read this first.** Automating a LinkedIn account goes against [LinkedIn's User Agreement](https://www.linkedin.com/legal/user-agreement) (section 8.2) and can get the account restricted or banned. OpenReach keeps activity slow and human-paced, but it cannot make automation invisible. You are responsible for how you use it, and for complying with privacy and anti-spam law (GDPR, CAN-SPAM and so on) when you contact people. Start with the built-in **simulator**, which never touches LinkedIn.

## Features

| | |
|---|---|
| **Visual sequence builder** | Chain steps: view profile, follow, like a post, endorse skills, invite (with a personalized note), message, InMail, email, withdraw invite, and wait. Branch on *invite accepted within N days*, *already connected*, *has email*, *has replied*, *has an open profile* or *what the reply was* (interested, out of office, ...). |
| **Personalization** | `{{firstName}}`, `{{company\|your team}}` fallbacks, `{Hi\|Hello}` spintax, and any CSV column as a variable. Live preview against a real lead. |
| **AI writing and personalization** | *Write with AI* on invitation, message, InMail and email steps drafts 1 to 5 versions from a short brief (offer, audience, tone, length, language, call to action); insert one, or use them all as A/B variants. Nothing is sent from the writer. *AI variables* (campaign **Settings**) are named instructions such as "one friendly line about their role": the AI writes a value per lead from their profile in the background before the step runs, and templates use it as `{{ai:icebreaker}}`. Values are cached per lead, rewritten when the instruction changes, and previewed on a real lead, both in the settings and inside each step of the builder (the full message with its length against the limit). Simulated values cached before you connect a real AI provider are rewritten by it. If writing fails or takes longer than `AI_WAIT_MAX_MIN`, the variable's fallback is sent and the failure shows in the activity feed; other leads keep going meanwhile. Invitation notes, InMails and messages are kept within LinkedIn's limits after variables are filled in. Works with Anthropic (Claude) or any OpenAI-compatible API (OpenAI, OpenRouter, Ollama, LM Studio, ...); token usage is recorded per workspace. Without a provider, a built-in simulator writes templated text, which is only ever sent from simulated accounts: real accounts send the fallback instead. |
| **A/B testing** | Invitation notes, messages, InMails and emails can have 2 to 5 variants. Each lead gets one variant per step, always the same one, and the campaign's Results tab shows sends, acceptances, replies and the rate per variant. A variant is marked *Leading* only once every variant has 20 sends and the gap is statistically clear. Pick a winner by hand, or let the step pick automatically after a number of sends, once one variant is ahead; leads who already got a variant keep it. Editing or removing a variant in the sequence starts its results over and ends its win. |
| **Lead import** | CSV upload with automatic column mapping. From LinkedIn: people searches (LinkedIn or Sales Navigator), the people who reacted to or commented on a post, an event's attendees and a group's members, collected in the background with live progress. Each account collects at most its daily import limit (1,000 profiles by default, warm-up applies), only in its working hours and never straight after an action. Duplicates are removed per workspace, and blacklisted or suppressed people are left out. Single profiles can be added by hand. |
| **InMail and Sales Navigator** | An *InMail* step writes to people you aren't connected to, with a subject, from their profile or from Sales Navigator. It has its own daily limit (10 by default) and uses the account's InMail credits, except for open profiles, which are free. Without credits, leads who aren't open profiles are skipped with the reason; when LinkedIn says the credits are used up, InMail pauses for a day. Leads who are already connected get a normal message instead, which counts toward the daily message limit. |
| **Safety** | Per-account daily and weekly limits, a 7-day warm-up ramp, working hours and days in the account's time zone, randomized pauses between actions, and human-like scrolling and typing. LinkedIn's own pushback (for example the weekly invite cap) puts that action on a 24-hour cool-down. |
| **Multiple accounts and sender rotation** | Each account has its own session, proxy, schedule and limits. A campaign can send from several accounts: each new lead goes to the account with the most room left today (or to the one it is already connected to), and stays with the account that first contacted it, so a person always hears from the same sender. Every account still keeps to its own limits, hours and delays. If an account is paused or logged out, the others take over the leads it hadn't contacted yet. The campaign page shows each lead's sender and results per sender. |
| **Email mailboxes** | Email steps send from your own mailboxes (Gmail, Microsoft 365 or any SMTP server, with app passwords), separate from LinkedIn accounts. Each mailbox has its own daily limit with a warm-up ramp, sending days and hours in its time zone, random gaps between emails, a signature and a from name. A campaign can rotate leads across several mailboxes; each lead stays with the mailbox that first emailed it. Emails carry a proper Message-ID, plain text plus simple HTML, an unsubscribe link and one-click `List-Unsubscribe` headers; a follow-up can *reply in the same thread*. Replies and bounces are read over IMAP (read-only): replies stop the sequence and show in the inbox, bounces mark the address invalid. A deliverability check looks up MX, SPF, DKIM and DMARC and says what to fix. Open and click tracking exist per campaign and are off by default. A simulated mailbox sends nothing and makes up replies and bounces for demos. |
| **Tasks** | A *Manual task* step (call, LinkedIn by hand, email by hand, or any other to-do) creates a task for a teammate, with instructions filled in per lead and a due time. The lead waits at that step until the task is completed or skipped, or until it is skipped automatically a chosen number of days after it is due. The **Tasks** page lists open, overdue and finished tasks with filters, call/email/profile links, and a call outcome and notes when you complete one; the dashboard and sidebar show what is due today. One-off tasks can be added for any lead. A lead that replies or leaves the campaign has its open task skipped. |
| **SMS and WhatsApp** | *Send SMS* and *Send WhatsApp* steps go out through Twilio (account SID, auth token, a from number or Messaging Service, and a WhatsApp sender) to leads with a phone number, inside the integration's sending hours and under a daily limit per channel, a short random gap apart. SMS steps can have A/B variants. Numbers saved without a country code are used when you set a default country code. Replies arrive through a signed Twilio webhook into the unified inbox and stop the sequence like any reply; you can text back from the inbox. *STOP* (and STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT) puts the person on the do-not-contact list in every campaign; *START* lets them be texted again. WhatsApp messages to people who haven't written in the last 24 hours need an approved template (its Content SID goes in the step). Without Twilio, a simulator records the messages and sends nothing. |
| **Unified inbox** | Conversations from every account and mailbox in one place. Replies are detected automatically and stop the lead's sequence (or, if you choose, let it carry on after certain kinds of reply). You can reply from the inbox. |
| **Reply classification and suggested replies** | Every new reply is labelled in the background as interested, meeting booked, question, not now, not interested, out of office, wrong person, unsubscribe or other, with how sure the AI is. The inbox shows the label, filters by it, lets you correct it, and hints at the pipeline stage it suggests. *Suggest reply* drafts up to three answers from the conversation; you pick one, edit it, and nothing is sent until you press Send. People who clearly ask to be left alone (unsubscribe, or a confident *not interested*) go on a do-not-contact list and stop in every campaign; review or undo it under **Settings → Blacklist → Do not contact**. Without an AI provider, keyword rules stand in. |
| **Analytics** | Daily activity, an acceptance and reply funnel, and per-campaign results and timelines. Live activity feed. |
| **Team** | Workspaces with owner, admin and member roles. |
| **Integrations** | Signed webhooks (`lead.connected`, `lead.replied`, `lead.classified`, `lead.finished`, ...) for Zapier, Make, n8n or your CRM. CSV export of any list or campaign. **Settings → Integrations** holds per-workspace provider settings (AI, email finding and verification, enrichment, CRM, SMS) with encrypted keys and a *Test connection* button. Until you add one, a built-in simulator stands in, so every feature works offline with made-up data that never reaches anyone (CRM sync only runs once you add a CRM). |
| **Blacklist** | By profile, company, keyword or email domain. Checked when leads are added and again before every action. |

## Quick start

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`, so there is no native build step).

```bash
git clone https://github.com/hasnainakber9/openreach.git && cd openreach
npm install
npm run build
npm start
```

Open http://localhost:8787 and create the first user. That user owns the installation, and sign-up closes after it.

### Try it without LinkedIn

```bash
npm run seed -w server                      # demo@openreach.local / demo-password
DEMO_SPEED=600 TICK_MS=300 npm start        # one simulated day ≈ 2.4 minutes
```

The seed creates two simulated LinkedIn accounts, 60 leads and a running campaign that rotates between them. With `DEMO_SPEED`, the scheduler's clock runs faster, so within a few minutes you'll see invitations accepted, follow-ups sent and replies landing in the inbox.

### Development

```bash
npm run dev        # API on :8787 (auto-reload) + Vite on :5173 with /api proxied
npm test           # engine, API and unit tests (vitest)
npm run typecheck
```

## Deploy

OpenReach needs an **always-on** server with a **persistent disk**: the campaign engine runs continuously, and the database lives on disk. Serverless platforms such as Vercel or Netlify functions can't run it.

### Render (one click)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/hasnainakber9/openreach)

The button reads [`render.yaml`](render.yaml). It creates a Docker web service on the Starter plan, a 1 GB disk mounted at `/data`, and a generated `APP_SECRET` and `SETUP_TOKEN`. When the service is live:

1. In Render, open the service, go to **Environment**, and copy the `SETUP_TOKEN` value.
2. Open your `https://openreach-xxxx.onrender.com` URL and create the owner account with that token.

### Any Docker host (VPS, Railway, Fly.io, home server)

Each push to `main` publishes an image to `ghcr.io/hasnainakber9/openreach:latest` (see `.github/workflows/ci.yml`).

```bash
curl -O https://raw.githubusercontent.com/hasnainakber9/openreach/main/docker-compose.yml
# edit APP_SECRET and SETUP_TOKEN in docker-compose.yml, then:
docker compose up -d
```

The app listens on port 8787. Put it behind HTTPS (Caddy, nginx or your platform's proxy) before entering real LinkedIn cookies. Data lives in the `openreach-data` volume.

To build from source instead, run `docker build -t openreach .`.

## Connecting a real LinkedIn account

1. Install the browser once: `npx playwright install chromium` (the Docker image already includes it).
2. Log in to linkedin.com in your normal browser. Open Developer Tools, then Application (Storage), then Cookies, then `https://www.linkedin.com`, and copy the value of **`li_at`**.
3. In OpenReach, go to **LinkedIn accounts → Add account**, choose *Real LinkedIn*, and paste the cookie. It is encrypted at rest with AES-256-GCM.
4. Add a **proxy** in the account's home country. A residential proxy is best, so that LinkedIn always sees the same location.
5. Press **Test connection**. The account card then shows the LinkedIn name it is signed in as.

If LinkedIn logs the session out or asks for a verification check, the account switches to **Needs login** and stops. Its campaigns keep their place. Paste a fresh cookie and press **Resume**.

Recommended starting limits for an established account: 15–25 invites/day (≤100/week), 30–50 messages/day, and 60–80 profile views/day. For new or quiet accounts, keep warm-up on.

## Connecting a mailbox

Email steps send from **Mailboxes** (owners and admins manage them). Set `PUBLIC_URL` first: every campaign email carries an unsubscribe link, and a real mailbox will not send without it (except one moved over from a LinkedIn account's SMTP settings, which keeps sending as before with a `mailto:` unsubscribe header only).

1. Create an **app password**. Gmail / Google Workspace: turn on 2-step verification, then Google Account → Security → App passwords. Outlook / Microsoft 365: Microsoft account → Security → Advanced security options → App passwords. Signing in with Google or Microsoft (OAuth) is **not** included, and some Microsoft 365 tenants turn SMTP AUTH off (an admin can enable it per mailbox).
2. In OpenReach, go to **Mailboxes → Add mailbox**, pick the provider (it fills in the SMTP and IMAP servers), and enter the address and the app password for both. Passwords are encrypted at rest and never shown again; if you later change a server's host, port or username, enter the password again.
3. Press **Test connection**, run the **Deliverability check** for your domain, and fix what it flags (SPF, DKIM and DMARC matter most).
4. Keep **Warm up** on for a new mailbox (it starts at a few emails a day and reaches the daily limit over a couple of weeks), and choose the mailbox under the campaign's **Settings → Send email from**.

If the server refuses the login, the mailbox switches to **Needs attention** and stops; fix the settings and press **Resume**. SMTP settings that were saved on a LinkedIn account before mailboxes existed are moved to a mailbox automatically, with the account's email limit, schedule and pauses and no warm-up.

## How it works

```
web/      React + Vite single-page app
server/
  src/engine/       the campaign engine
    engine.ts       scheduler: per-account loop, limits, delays, step execution, retries
    sequence.ts     sequence schema + validation (tree of action / wait / condition nodes)
    sync.ts         pulls accepted invitations and new messages; wakes or stops leads
    limits.ts       working hours, time zones, warm-up, daily/weekly caps
    template.ts     variables, fallbacks, spintax, note trimming
  src/drivers/
    types.ts        LinkedInDriver interface — the only thing the engine talks to
    simulator.ts    fake LinkedIn network for demos and tests
    playwright/     real browser driver; selectors.ts holds every LinkedIn-specific selector
  src/mail/         mailboxes, email composing, the mail runner, IMAP replies/bounces, deliverability, links
  src/messaging/    the SMS/WhatsApp runner and the signed Twilio webhook (STOP/START, replies)
  src/routes/       REST API (Fastify)
  src/db/           SQLite schema and migrations
```

- Every lead in a campaign has a position in the sequence tree and a `next_run_at` time. Waits and conditions only read the database, so they advance immediately at any hour. Actions wait for their account to be inside working hours, under its limits and past its randomized cool-off from the previous action.
- About every 45 minutes during working hours, each account syncs its recent connections and inbox. An accepted invite moves the lead down the *Yes* branch straight away. A reply stops the lead (configurable per campaign, see below).
- Each account's actions run one at a time through a single browser. Different accounts run in parallel.
- When a campaign has several senders, a lead is pinned to one of them just before its first LinkedIn step. Rotation only decides which account takes a lead; it never lets an account go past its own limits. Removing a sender from a campaign (or deleting the account) hands its not-yet-contacted leads to the others; leads it already contacted keep running from it (or stop, if the account is deleted).

### What happens when a lead replies

Each campaign decides with two settings, **Stop when a lead replies** and **Keep going after these replies**:

| Stop on reply | Keep going after | What happens to the lead in this campaign |
|---|---|---|
| on | nothing chosen (default) | Stops as *replied* as soon as the reply is synced. |
| on | some categories | Waits (at most `REPLY_HOLD_MIN`) for the reply to be classified. A chosen category lets the sequence carry on, anything else stops it as *replied*, and so does a reply still unclassified when the time is up. |
| off | (ignored) | Carries on. Conditions such as *has replied* or *reply is* look again right away. |

An *If reply is…* condition goes down *Yes* when the lead's latest reply since it joined the campaign is in the chosen categories, and down *No* when it hasn't replied. A reply that isn't classified yet waits for its category (up to `REPLY_HOLD_MIN`, then it counts as *other*). Example: keep going after *out of office*, then *If reply is: out of office* → *Wait 5 days* → *Message* ("Welcome back...").

Whatever the settings, a reply classified as *unsubscribe* (even a polite one, unless the classifier is less than 50% sure), or as *not interested* with at least 70% confidence, puts the person on the do-not-contact list and stops them in every campaign. Less certain opt-outs are only labelled, so a misread reply never silently drops a real prospect, but they still stop the lead in a stop-on-reply campaign: *not interested* and *unsubscribe* can't be chosen under "Keep going after these replies". Only the lead's latest reply counts, so a late answer about an older message changes nothing. Changing a category by hand in the inbox counts like a classification.

### When LinkedIn changes its markup

The browser driver finds elements by accessible names (for example *“Invite Jane to connect”*) rather than by CSS classes, which LinkedIn renames often. If an action starts failing, the selectors to update are all in `server/src/drivers/playwright/selectors.ts`. The driver is tested against a local mock of LinkedIn's markup (`server/test/playwright-driver.test.ts`), which checks the driver's own logic. It cannot check the live site. Please open an issue or PR when you spot drift.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | |
| `DATA_DIR` | `./data` | SQLite database, browser profiles, generated secret |
| `APP_SECRET` | generated into `DATA_DIR/app-secret` | Key for encrypting session cookies, SMTP passwords and integration API keys. Back it up: changing it makes saved sessions unreadable. |
| `SETUP_TOKEN` | | If set, creating the first (owner) account requires this value. **Set it on any public server**, or whoever opens the URL first owns the installation. |
| `ALLOW_SIGNUP` | `false` | Let anyone create a new workspace after the first user |
| `RUN_WORKER` | `true` | Set `false` to run the API without the campaign engine |
| `TICK_MS` | `2000` | Scheduler loop interval |
| `SYNC_INTERVAL_MIN` | `45` | Minutes between connection/inbox syncs per account |
| `PLAYWRIGHT_HEADLESS` | `true` | `false` shows the browser window (useful for debugging locally) |
| `PLAYWRIGHT_EXECUTABLE_PATH` | | Use a specific Chrome/Chromium binary |
| `DEMO_SPEED` | `1` | Speed up the scheduling clock (demo/simulator only) |
| `PUBLIC_URL` | | External https:// address of this server. Used for links that leave the app (unsubscribe, tracking, invites); never taken from request headers. |
| `JOB_CONCURRENCY` | `4` | Background jobs (enrichment, AI, CRM sync, ...) running at once. Jobs run inside the campaign engine, so they need `RUN_WORKER`. |
| `AI_WAIT_MAX_MIN` | `30` | How long a step waits for its `{{ai:...}}` variables before sending with the fallbacks |
| `MAIL_SYNC_INTERVAL_MIN` | `5` | Minutes between IMAP checks for replies and bounces, per mailbox |
| `REPLY_HOLD_MIN` | `30` | How long a lead that replied waits for its reply to be classified, in campaigns that keep going after some replies |

Inbound SMS and WhatsApp need `PUBLIC_URL`: Twilio signs each webhook request for that exact URL, and OpenReach refuses requests whose signature doesn't match. The Twilio card under **Settings → Integrations** shows the URL to paste into your number's *A message comes in* webhook.

## API and webhooks

Everything in the UI goes through the JSON API under `/api`, authenticated with the session cookie. Webhook deliveries look like this:

```json
{ "event": "lead.replied", "occurredAt": "2026-01-07T10:14:00.000Z",
  "data": { "lead": { "id": 12, "profileUrl": "https://www.linkedin.com/in/…", "firstName": "Ava", "company": "Northwind", "connectionStatus": "connected" },
            "message": "Thanks for reaching out! …" } }
```

To verify a delivery, compute `sha256=` + HMAC-SHA256(body, secret) and compare it with the `X-OpenReach-Signature` header.

## Limitations

- **Email finding** (looking up work emails from third-party databases) is not included. Email steps use addresses from your CSV, or from a 1st-degree connection's contact info.
- Mailboxes sign in with passwords (app passwords) over SMTP and IMAP; OAuth sign-in for Google and Microsoft is not included. The IMAP reader (imapflow) and the bounce parsing are tested against fake inbox data only. Replies are only detected in the mailbox's own INBOX, matched to our emails by `In-Reply-To`/`References` or to a lead by sender address; mail filed elsewhere by a rule is missed. Real mailboxes never send to reserved test domains (`.example`, `.test`, ...). OpenReach does not warm mailboxes up by exchanging emails with other mailboxes; warm-up here only ramps the daily limit.
- Open and click tracking (off by default) records personal data and is approximate: privacy proxies and link scanners open mail too. Check the law that applies to you before turning it on.
- Imports from posts, events and groups, InMail and Sales Navigator messaging are new and **best effort** on real accounts: their selectors are written from LinkedIn's public markup and tested only against the local mock. Sales Navigator search import is best effort too. Event attendees and group members are only visible to accounts attending the event or in the group.
- With real accounts, whether a lead has an *open profile* is not detected yet (LinkedIn shows no reliable marker), so the *has an open profile* branch only works with the simulator for now.
- LinkedIn imports and AI personalization run as background jobs inside the campaign engine, so they need `RUN_WORKER` (the default).
- The Anthropic and OpenAI-compatible providers follow the vendors' public API docs and are tested against fakes, not the live services. The default Claude models are `claude-sonnet-5-5` (writing) and `claude-haiku-5-5` (classification); change them in the integration's settings. AI text is generated from profile fields only; it can still be wrong, so preview it before launching.
- Reply classification can be wrong, especially for short or sarcastic replies; check the inbox and correct the category when it matters. Without an AI provider it uses simple English keyword rules. When several replies arrive in one sync, only the newest is classified.
- Pipeline stages are not built yet: the inbox only *suggests* a stage from the reply.
- The Twilio integration follows Twilio's public API and webhook documentation and is tested against fakes, not the live service. Delivery receipts (sent/delivered/failed callbacks) are not tracked: a message counts as sent once Twilio accepts it. WhatsApp templates are not created or approved from OpenReach; do that in Twilio and paste the Content SID. A lead's phone number is matched to inbound messages after normalizing both to international form, so a number saved in national form only matches with the default country code set.
- SMS daily limits and sending hours are per workspace and channel (from the Twilio integration's settings; the simulator uses 100 a day each, 09:00–19:00 UTC). Check the rules for texting in each country you send to (consent, quiet hours, sender registration such as US A2P 10DLC).
- LinkedIn only shows coarse message timestamps, so inbox messages are time-stamped when they are first synced.
- SQLite and an in-process scheduler (with a database-backed job queue for background work) suit one server running dozens of accounts. Beyond that you'd want Postgres.

## License

MIT

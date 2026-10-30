# OpenReach

**Self-hosted, open-source LinkedIn outreach automation.** Build drip campaigns that visit profiles, send connection requests, follow up when people accept and stop when they reply. Run them from several LinkedIn accounts, inside working hours and under strict safety limits. Everything stays on your own server.

OpenReach is an independent project. It is not affiliated with LinkedIn or with any commercial outreach tool.

> **Read this first.** Automating a LinkedIn account goes against [LinkedIn's User Agreement](https://www.linkedin.com/legal/user-agreement) (section 8.2) and can get the account restricted or banned. OpenReach keeps activity slow and human-paced, but it cannot make automation invisible. You are responsible for how you use it, and for complying with privacy and anti-spam law (GDPR, CAN-SPAM and so on) when you contact people. Start with the built-in **simulator**, which never touches LinkedIn.

## Features

| | |
|---|---|
| **Visual sequence builder** | Chain steps: view profile, follow, like a post, endorse skills, invite (with a personalized note), message, email, withdraw invite, and wait. Branch on *invite accepted within N days*, *already connected*, *has email* or *has replied*. |
| **Personalization** | `{{firstName}}`, `{{company\|your team}}` fallbacks, `{Hi\|Hello}` spintax, and any CSV column as a variable. Live preview against a real lead. |
| **Lead import** | CSV upload with automatic column mapping. LinkedIn and Sales Navigator search URLs are scraped in the background. Single profiles can be added by hand. Duplicates are removed per workspace. |
| **Safety** | Per-account daily and weekly limits, a 7-day warm-up ramp, working hours and days in the account's time zone, randomized pauses between actions, and human-like scrolling and typing. LinkedIn's own pushback (for example the weekly invite cap) puts that action on a 24-hour cool-down. |
| **Multiple accounts** | Each account has its own session, proxy, schedule and limits. Each campaign runs from one account. |
| **Unified inbox** | Conversations from every account in one place. Replies are detected automatically and stop the lead's sequence. You can reply from the inbox. |
| **Analytics** | Daily activity, an acceptance and reply funnel, and per-campaign results and timelines. Live activity feed. |
| **Team** | Workspaces with owner, admin and member roles. |
| **Integrations** | Signed webhooks (`lead.connected`, `lead.replied`, `lead.finished`, ...) for Zapier, Make, n8n or your CRM. CSV export of any list or campaign. |
| **Blacklist** | By profile, company, keyword or email domain. Checked when leads are added and again before every action. |

## Quick start

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`, so there is no native build step).

```bash
git clone <this repo> && cd openreach
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

The seed creates a simulated LinkedIn account, 60 leads and a running campaign. With `DEMO_SPEED`, the scheduler's clock runs faster, so within a few minutes you'll see invitations accepted, follow-ups sent and replies landing in the inbox.

### Development

```bash
npm run dev        # API on :8787 (auto-reload) + Vite on :5173 with /api proxied
npm test           # engine, API and unit tests (vitest)
npm run typecheck
```

### Docker

```bash
docker compose up -d --build
```

Data lives in the `openreach-data` volume. Set `APP_SECRET` in `docker-compose.yml` before the first start.

## Connecting a real LinkedIn account

1. Install the browser once: `npx playwright install chromium` (the Docker image already includes it).
2. Log in to linkedin.com in your normal browser. Open Developer Tools, then Application (Storage), then Cookies, then `https://www.linkedin.com`, and copy the value of **`li_at`**.
3. In OpenReach, go to **LinkedIn accounts → Add account**, choose *Real LinkedIn*, and paste the cookie. It is encrypted at rest with AES-256-GCM.
4. Add a **proxy** in the account's home country. A residential proxy is best, so that LinkedIn always sees the same location.
5. Press **Test connection**. The account card then shows the LinkedIn name it is signed in as.

If LinkedIn logs the session out or asks for a verification check, the account switches to **Needs login** and stops. Its campaigns keep their place. Paste a fresh cookie and press **Resume**.

Recommended starting limits for an established account: 15–25 invites/day (≤100/week), 30–50 messages/day, and 60–80 profile views/day. For new or quiet accounts, keep warm-up on.

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
  src/routes/       REST API (Fastify)
  src/db/           SQLite schema and migrations
```

- Every lead in a campaign has a position in the sequence tree and a `next_run_at` time. Waits and conditions only read the database, so they advance immediately at any hour. Actions wait for their account to be inside working hours, under its limits and past its randomized cool-off from the previous action.
- About every 45 minutes during working hours, each account syncs its recent connections and inbox. An accepted invite moves the lead down the *Yes* branch straight away. A reply stops the lead (configurable per campaign).
- Each account's actions run one at a time through a single browser. Different accounts run in parallel.

### When LinkedIn changes its markup

The browser driver finds elements by accessible names (for example *“Invite Jane to connect”*) rather than by CSS classes, which LinkedIn renames often. If an action starts failing, the selectors to update are all in `server/src/drivers/playwright/selectors.ts`. The driver is tested against a local mock of LinkedIn's markup (`server/test/playwright-driver.test.ts`), which checks the driver's own logic. It cannot check the live site. Please open an issue or PR when you spot drift.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | |
| `DATA_DIR` | `./data` | SQLite database, browser profiles, generated secret |
| `APP_SECRET` | generated into `DATA_DIR/app-secret` | Key for encrypting session cookies and SMTP passwords. Back it up: changing it makes saved sessions unreadable. |
| `ALLOW_SIGNUP` | `false` | Let anyone create a new workspace after the first user |
| `RUN_WORKER` | `true` | Set `false` to run the API without the campaign engine |
| `TICK_MS` | `2000` | Scheduler loop interval |
| `SYNC_INTERVAL_MIN` | `45` | Minutes between connection/inbox syncs per account |
| `PLAYWRIGHT_HEADLESS` | `true` | `false` shows the browser window (useful for debugging locally) |
| `PLAYWRIGHT_EXECUTABLE_PATH` | | Use a specific Chrome/Chromium binary |
| `DEMO_SPEED` | `1` | Speed up the scheduling clock (demo/simulator only) |

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
- **InMail** and Sales Navigator messaging are not supported. Sales Navigator *search import* is best effort.
- LinkedIn only shows coarse message timestamps, so inbox messages are time-stamped when they are first synced.
- SQLite and an in-process scheduler suit one server running dozens of accounts. Beyond that you'd want Postgres and a job queue.

## License

MIT

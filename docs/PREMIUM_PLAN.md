# OpenReach Premium: architecture plan

This is the shared plan for the premium build on the `premium` branch. Each step below is implemented by a
different person (or agent), in this order:

`foundation → g1-rotation → g1-abtest → g1-sources → g2-ai-writer → g2-ai-replies → g3-mailboxes → g3-tasks-sms → g4-data → g5-pipeline → g5-agency → g5-crm → g5-billing → postgres`

Read sections 1–3 before starting any step, then your step in section 4. If you must deviate, change this file in
the same commit, say why in one line under **Deviations** in the status table, and keep later steps consistent.

Feature inspiration comes from public feature lists of Dripify, Expandi, Reply.io, Salesflow, Apollo.io and
HeyReach. We write our own code, copy, UI and names. Never copy their code, text, branding or designs.

## 0. Status

| Step | Migration | Status | Deviations |
|---|---|---|---|
| foundation | M1 | done | `features` sits on the `user` object of `/api/auth/me` (the web stores that object as `Me`). NAV `badge` is typed `'inbox'` only; g3-tasks-sms adds `'tasks'` with its count. Extra small files: `providers/hash.ts` (hash helpers for simulators), `test/suppression.test.ts`. |
| g1-rotation | M2 | done | Limit/usage helpers moved to `engine/capacity.ts` (re-exported from `engine.ts`) to avoid an import cycle with `services/rotation.ts`. `chooseSender` rule 1 only returns *active* senders (a lead connected to a logged-out account is not stuck), and rule 2 leaves a lead unassigned when every sender's queue already covers its remaining capacity (score ≤ 0) instead of overbooking one. `runAccount` re-runs the global `advanceFreeSteps()` right after a sync so accepted invites move on in the same pass. `markConnected` links the `accepted` activity to the campaign only when the lead is unassigned or pinned to that account (keeps per-sender stats honest). Campaign and account mutating routes now call `requireWriter`. Seed creates two simulated seats. `enrichLead(ctx, lead, person, accountId?)`. |
| g1-abtest | M3 | done | Variants are assigned when the step's action runs (after the lease, before sending), not when the lead walks onto the step, so leads waiting on limits when a winner is picked get the winner. `variantStats(rows, metric, ids?)` takes the variant ids so unsent variants show; `leader` is only set on a strict best rate (ties: none), and auto-pick (`bestVariant`) only picks that leader once every variant has a send and the leader has at least one result (an all-0% start, common while invites wait to be accepted, keeps splitting). Extra migration M3b (appended after review): `campaign_node_winners.variant` is nullable, and a NULL row with `decided_by = 'user'` records "split again" so auto-pick doesn't undo it (changing the step's `autoPickAfter` re-arms auto-pick); `campaign_variant_starts` records when a variant letter was (re)introduced or its text changed, and stats only count sends since then. Saving the sequence (`syncVariants` in the PATCH transaction) drops a winner whose variant was removed or edited. `validateSequence` refuses metric `accepted` on non-connect steps. Manual picks also log `ab_winner`. The activity feed and lead timeline show the variant; the seed's demo invite has two variants. Per-sender split of A/B results is not built. |
| g1-sources | M4 | done | An `inmail` step for a lead already connected to the sender is sent as a normal message (no credit spent) and logged as a `message` activity with the InMail step's `node_id`/variant (detail says so), so it counts against the account's daily message limit; when that limit is spent the lead waits for the next working day, and `variantRows` counts these `message` rows for InMail steps. Imports: each attempt restarts `found` (progress) but the daily scrape budget sums `imports.scraped` ([M4b]), which keeps what earlier attempts loaded on the same `day`. Only one import per account runs at a time (a later one is a `RetryLater` of 5 min while an earlier import's job is running), and inside the driver lock a run re-reads the import and does nothing if it is no longer `running` or its job run was aborted (timed out), so a retried job never scrapes twice. The legacy `POST /api/leads/import/search` validates its URL with `sourceUrlProblem`. Imports and actions share the account's pause both ways: the import holds `next_action_at` while it scrapes, and `runAction` re-reads `next_action_at` inside the driver lock and skips (keeping the lead's place) when an import ran meanwhile. Import waits are `RetryLater` with a user-readable `imports.note`: account not active (30 min), outside working hours, the pause after an action, budget spent (next working day), `LIMIT_REACHED` (1 day). A session error during a scrape marks the account `needs_login` through `accountNeedsLogin()` (now exported from `engine.ts` and used by `guarded()`) and the import resumes after reconnecting; `NOT_FOUND` and the third failed attempt fail the import. `imports.blacklisted` counts blacklisted *and* suppressed people. Playwright event attendees follow the event page's attendee link (a people search) instead of `/events/<id>/attendees`. `is_open_profile` without a preceding `view_profile` is a sequence *warning* (not an error). `GET /api/imports` also returns `accountId/accountName`, `options`, `jobId`; a cancelled/failed job shows its import as failed. The Playwright `viewProfile` does not detect open profiles yet (no reliable marker), so `leads.open_profile` is only filled by the simulator. Simulator crowds: post 20–39 engagers (¾ reacted, ¼ commented, some both), event 40–79, group 150–299. |
| g2-ai-writer | M5 | done | Extra small file `ai/complete.ts` (`completeAi` records usage for every AI call, `completeJson` = zod-validated JSON with one retry); `aiNamesIn` lives in `engine/template.ts` (re-exported from `ai/personalize.ts`). Because variants are assigned when a step runs (g1-abtest), `prefetchAi` in `moveTo` requests the names of the lead's stored variant, or of every variant when none is stored yet. A pending value older than `AI_WAIT_MAX_MIN` is marked `failed` by `resolveAiVars` ("Not ready after N minutes", activity `ai_personalize` failed) so later steps don't wait again; failed values stay failed until the instruction or length changes. `runAction` returns `'ai_wait'` for a parked lead and `runAccount` then tries its next candidate in the same pass. The job wakes only leads parked for AI (`next_run_at` within the 2-minute recheck, `attempts = 0`). Rendered text over a network limit (message 8,000, InMail subject 200 / body 1,900, email subject 300) is shortened and the activity detail says "(shortened from X to N characters)"; notes keep using `clampNote`. Anthropic: SDK `maxRetries: 0` (the queue retries), base URL pinned, no `temperature` (current models reject sampling parameters; the field is still sent to OpenAI-compatible APIs), effort `medium` for the writer tier and `low` for the classifier, `max_tokens` = requested + 8,000 because adaptive thinking counts against it, server-side refusal fallback (`fallbacks: "default"`) on models that support it; `test()` retrieves both models (no tokens spent). The OpenAI-compatible API key is optional (local servers); the private-address block for `baseUrl` waits for g5-billing's hosted mode. The preview route also takes unsaved `variables`. Steps that use `{{ai:x}}` also get a "Preview AI text on lead" picker in the builder (`AiLeadPreview`): it writes the saved variables for that lead once (shared by every step until the variables change), and each field's template preview renders that lead with `aiValues`, so the sent text and its length against the campaign's `noteLimit` (now passed to the builder; the note field used a fixed 300) show before launch. Simulated values cached before a real AI integration was added are regenerated by it (`requestAiVars` treats ready + simulated rows as stale when the workspace's AI provider is real), instead of real accounts sending the fallback for them; the per-run "simulated text not sent" note is logged only with the step's outcome, so retries and holds don't repeat it. `/api/ai/write` also accepts `sms`. The simulated AI returns JSON drafts only for writer prompts (they carry a `channel:` line), so its plain greeting for other prompts is unchanged. `server/vitest.config.ts` raises the per-test timeout to 30 s: the longest engine test got close to vitest's 5 s default with every file running in parallel. The seed's demo message uses `{{ai:icebreaker}}`. |
| g2-ai-replies | M6 | done | `replyDecision(settings, lead)` reads `leads.reply_category/_at` (a category older than `replied_at` belongs to an earlier reply, so the reply is still pending). The reply hold's deadline is `leads.replied_at + REPLY_HOLD_MIN` (no extra column), so spurious wake-ups re-hold without moving it. `walk()` only gates leads with `hold_reason = 'reply'`; `runAction` gates every replied lead as before. When a classification lands, reply holds are resolved before suppression, so a held lead whose reply is not in the list ends `replied` and only its other campaigns become `skipped`. A message's category reaches its conversation and lead only when it is their latest inbound message (a late answer about an older message changes nothing). `ai.classify` uses one `completeAi` call: a malformed answer is `other`/0 without a retry; a final failure logs a failed `classified` activity. Replies from people who aren't leads are classified too (inbox sorting). The keyword classifier lives in `ai/categories.ts` (`keywordCategory`); a not-interested phrase qualified by timing ("at the moment") is `not_now` 0.65. The `classified` activity goes to the lead's running campaign (else its latest). `lead.classified` data adds `source`; `lead.replied` adds `channel`; `publicLead`/`serializeLead` add `replyCategory`. Routes: `?category=none` lists unclassified threads; thread detail adds `categoryConfidence/categorySource` and message `confidence`; the suggest route defaults to 3 drafts and shares the AI rate limit (`aiThrottle(ctx)`); `POST /api/inbox/:id/reply` now needs `requireWriter`. `POST /api/suppressions` also stops matching leads' running campaigns right away (`{ added, stopped }`); `GET` returns `{ total, page, pageSize, items }` with `leadName`. Extra sequence warning when a `reply_sentiment` condition lists categories outside `continueOnCategories`. `SimulatorOptions.replies` defaults to `[]` (= the built-in list); `engine.test.ts`'s "keeps going after a reply when stop-on-reply is off" now passes a question reply, because a "Not interested" reply suppresses the lead by design. Opt-outs never continue: `replyDecision` stops on `unsubscribe`/`not_interested` whatever the list says, `continueOnCategories` refuses them (stored settings that have them still load, filtered), and the settings UI leaves both out of "Keep going after these replies". In the keyword classifier, "we're all set/good" only declines when nothing but a thank-you follows ("we're all set for Tuesday" confirms), a "not interested" next to a meeting/interested phrase scores 0.55, qualifiers no longer soften an unsubscribe, and a negated opt-out scores 0.4. When an older reply syncs late (another sender's thread) and moves `replied_at` past the stamp of the lead's already classified latest reply, its classification re-stamps the lead with that latest category and resolves holds. |
| g3-mailboxes | M7 | done | `ctx.mailer` in `makeWorld` is a recording fake (`fakeMailer()`: records real-transport sends too and never opens a connection, with queued `failures`) rather than one that throws, so real-mailbox paths are testable; `fakeImap()` helper; `ctx.dns`/`ctx.imap` default to stubs that throw. `email_messages.status` also has a transient `sending` (the row is written before SMTP so link tokens carry its id). Email node `replyInThread` is optional (absent = false) so existing typed sequences stay valid. `chooseMailbox` also keeps a lead pinned to a LinkedIn sender on that sender's legacy mailbox. SMTP `EAUTH` → mailbox `needs_attention` (also an IMAP login failure in `email.sync`); an SMTP recipient refusal marks the lead's email invalid and skips the step. Real mailboxes without SMTP settings also go `needs_attention`. Syncs are scheduled for active and paused mailboxes at any hour. `processInbound` calls `handleInboundReply` (now with `mailbox`) once per lead per sync with the newest reply, strips quoted text, ignores mail dated before the mailbox existed; uidValidity changes restart from `since` (max(created, now − 14 d)). Simulated replies are hashed from (mailbox id, email row id). Opens/clicks count every hit; the first logs `email_open`/`email_click`. `PATCH /api/campaigns/:id` on a running campaign refuses changes that leave no sender or LinkedIn steps without an account (409). Extra: `GET /api/mailboxes/:id`; inbox `?channel=` and `?mailboxId=`; `/api/deliverability/check` also takes `mailboxId` (domain + preset); `campaignStats` adds `email` and `byMailbox`; campaign lead items add `mailbox`; `serializeLead` adds `emailStatus/emailStatusReason`, `publicLead` adds `emailStatus`; editing a lead's email clears its status. The accounts API still accepts `smtp` (no longer in the UI); `ensureLegacyMailboxes` runs at startup only. `test/integrations.test.ts`'s form-body test now echoes on `/form-echo/:token`, since `/u/:token` is the real unsubscribe route. Seed adds a simulated mailbox and an email campaign. Review fixes: a `failed` outbound row doesn't count as "already emailed" (release, retire and `chooseMailbox` stickiness), so a lead whose send was refused moves to another mailbox; mailboxes migrated from account SMTP settings keep sending without `PUBLIC_URL` (mailto-only `List-Unsubscribe`); a blank password on PATCH is kept only when host, port and user are unchanged (else 400 "Enter the password again"); IMAP without TLS from the start requires STARTTLS (`doSTARTTLS`), a server that doesn't offer it puts the mailbox on needs attention; sender-address reply matching only considers leads this mailbox emailed. |
| g3-tasks-sms | M8 | done | `SmsProvider` gains a `policy` (`smsDailyLimit`, `whatsappDailyLimit`, `timezone`, `sendStart/End`, `defaultCountryCode`, `whatsapp`), so the runner reads limits from the provider instead of the integration row; the simulator's policy is fixed (100/day each, 09:00–19:00 UTC, every day). `auto_skip_at = due_at + autoSkipAfterDays` (counted from the due date, and moved with it when `PATCH` changes `dueAt`). Campaigns whose steps are only tasks/SMS/WhatsApp/waits/conditions need no LinkedIn account or mailbox (`senderProblem`). `normalizePhone(raw, defaultCountryCode?)` also strips `whatsapp:`/`tel:` prefixes. Inbound: every message (STOP/START included) is stored in its phone thread, so duplicates are found by `MessageSid` in `messages.external_id`; senders matching no lead get a conversation without a lead; STOP also suppresses the normalized number itself (a lead's phone in national form can't be normalized by `suppressLead`), and the runner checks that number before sending. Runner errors: `AUTH`/`QUOTA` or a setup error raised before any request (no HTTP status) keep the lead's place, mark the integration and pause that workspace's sending for 30 min; Twilio `BAD_REQUEST`/`NOT_FOUND` (invalid or unsubscribed number) skip the step for that lead; others retry like LinkedIn. Real sends record `usage_events` (`kind 'sms'`, operation `sms.send`/`whatsapp.send`). `task.completed` is emitted for skips too (the task's `status` says which). Extra: inbox `?channel=sms|whatsapp` and replying to SMS/WhatsApp threads through the provider (refused for numbers that sent STOP); `serializeIntegration` adds `webhookUrl` for Twilio; `GET /api/tasks` also takes `status=all` and `leadId`, items add `overdue/nodeId/completedAt/createdAt`; `GET /api/tasks/counts?tz=` for "due today" in the browser's zone; account/mailbox retirement skips tasks of the leads it stops (`skipTasksOfStoppedLeads`); WhatsApp `contentSid` must look like `HX` + 32 hex. `test/integrations.test.ts`'s form-body test now echoes on `/api/public/twilio/echo/:id`, since `/api/public/twilio/:id/inbound` is the real webhook. Not built: Twilio delivery-status callbacks, a seed demo, editing a task from the web UI (the `PATCH` route exists). |
| g4-data | M9 | done | Extra column `leads.enrichment_options` (what the last finished lookup did, for the 10-minute reuse check and the `find_email` gate) and index `enrichment_runs_workspace`. Interfaces gain optional fields only: `FoundEmail.reason/credits`, `VerifyResult.credits`, `EnrichResult.credits`, `EnrichInput.domain`. The simulated verifier only judges reserved (`.example`, ...) addresses; real ones come back `unknown` ("connect an email verifier"), so a demo never labels a real address valid. The simulated enricher's values go into the `enrichment` JSON only (flagged `simulated`), never into lead fields or `company_domain`. When the verifier answers `unknown`, the finder's own status stands. Existing addresses are verified only when unchecked/`unknown` (or with `overwrite`); a bounce (`invalid`) stands, and a finder address that bounced is looked up again. Run counters: `found` = leads with an email after the lookup (existing ones included), `verified` = status `valid`, `failed` = lookup failed; a re-run never pushes `done` past `total`. Usage rows are recorded for simulated calls too, with 0 credits. Job: transient errors (timeouts, outages) with nothing found retry up to 3 attempts, then the lead is marked `failed`; AUTH/QUOTA flag the integration and the waterfall carries on with the next finder. Hunter finder 404/451 = not found; ZeroBounce/NeverBounce key errors that come back as HTTP 200 are mapped to AUTH/QUOTA. Imports: `importLeads(..., { emailSource })` (default `user`) returns `addedIds` and uses `ON CONFLICT DO NOTHING RETURNING id`; CSV and LinkedIn imports take `autoEnrich` (unset = workspace setting); the CSV response adds `enrichRunId`; `POST /api/leads` returns the new `id`. Extra route `GET /api/enrichment/runs` (latest 10). `GET /api/leads` also filters `enrichment=queued`; CSV export adds email status/source and company domain. The legacy account-SMTP email path also refuses `email_source = 'simulated'`. Campaign warnings for Find email with the simulated finder, and for *email verified* without a Find email step. The `find_email` gate releases a lead whose address needs no (more) checking, or once a lookup with `find` finished since it entered the step (or within 10 minutes before). `.gitignore`'s `data/` (meant for `DATA_DIR`) also matched `server/src/providers/data/`, so foundation's `types.ts`/`simulated.ts` were never committed; a `!server/src/providers/data/` negation fixes that. Not built: a seed demo of the new step. |
| g5-pipeline | M10 | done | The "first contact → contacted" hook lives in `logActivity` (`advanceOnActivity` in `services/pipeline.ts`) instead of separate engine/mail/messaging hooks, so every channel and inbox replies are covered in one place. The migration backfill also maps `reply_category` interested/meeting_booked to those stages. Category moves apply only for the lead's latest reply; `pipeline.autoLost` moves any `not_interested` (no confidence threshold). `publicLead(l, ctx?)` adds `stage` and `ownerId` when given `ctx` (every webhook caller passes it); `serializeLead(l, stages?)` adds `stageId/stage/stageChangedAt/stageManual/ownerId`. Extra routes: `GET/PUT /api/pipeline/settings` (`autoLost`); the board takes `stageId&offset` for one column's "Load more"; `POST /api/leads/bulk` returns `{ updated, matched }`; stage `DELETE` takes `moveTo` in the body or query; new open stages are inserted before won/lost; at most 30 stages. `GET /api/leads` adds `stageId/tag/ownerId` filters, `GET /api/leads/:id` adds `owner`, CSV export adds `stage`; `PATCH /api/leads/:id` canonicalizes `tags` (existing spelling wins, new names get a tag row). Tag rename onto another tag's name is 409 (no merge); the tag filter is `LIKE` on the JSON-quoted name with `ESCAPE` (case-insensitive) without a JS re-check in list queries. Timeline: inbound messages only (each send already has an activity row), activity `replied`/`task_created` left out as duplicates, cursor `at.rank.id` so same-millisecond items page correctly. Inbox thread detail adds `stage`; its header has a stage select (`STAGE_LABELS` removed from `format.ts`). Web: `LeadDrawer` moved to `components/LeadDrawer.tsx` (shared by Leads and Pipeline), `ColorTag` added to `ui.tsx`, the Settings Pipeline tab (stages, auto-lost toggle, tag management) is `pages/PipelineSettings.tsx`, and Settings honours `?tab=`. |
| g5-agency | M11 | done | Users inserted straight into `users` (old seed scripts, tests) get their membership from `users.workspace_id/role` on their next sign-in (`ensureLegacyMembership`, the only reader of `users.role`). `features.agency` is set only when the user runs an agency from the active workspace (foundation's test pins `{}` for a plain owner), so *Turn on agency mode* lives in **Settings → Team** for owners of standard workspaces; `/api/auth/me` adds `workspace_kind`, `parent_name` and `agency: { id, name } \| null`. `CLIENT_ALLOWED` also has GET `/api/tags` (board tag colors); `test/tasks-sms.test.ts`'s read-only check now sets the role on `memberships` and expects clients to get 403 on GET `/api/tasks` (not in the allowlist). Invites: times use the wall clock like sessions (the demo clock would expire them in minutes); the `invite.email` payload carries the token sealed (`tokenEnc`), since only its hash is stored; inviting an address again replaces its pending invite; inviting an existing member is 409; email needs both `SMTP_URL` and `PUBLIC_URL`; GET `/api/invites` returns `{ items, emailEnabled }`. `POST /api/team` also takes role `client`; only owners grant or change `owner`, and an owner can be removed by another owner while one remains. Removing a membership clears that user's lead ownership and task assignments in the workspace. `roleIn` is the higher of the direct role and the role inherited from the agency (a lower direct row, e.g. an accepted invite, never demotes an agency admin; `listWorkspaces` follows the same rule), and `POST /api/invites` is 409 for anyone who already reaches the workspace. `isWorkspaceMember` = `roleIn` other than `client`, so agency owners/admins can own leads and take tasks in a client; `/api/team` lists them there with `inherited: true` (no edit/remove; 404 on PATCH/DELETE), assignment pickers leave out clients, and removing or demoting someone (in the agency too) clears their lead ownership and task assignments wherever they lost access (`releaseAssignments`). `TRUST_PROXY` is parsed into a hop count or address list, never "trust every hop" (the left-most `X-Forwarded-For` entry is client-chosen and would reset the sign-in throttle); a hop count becomes a trust function because Fastify reads a bare number as "trust nothing". Custom domains (review): only the agency owner changes them (`canEditDomain` on GET/PUT `/api/agency/branding`; 403 otherwise), the `PUBLIC_URL` host (or, without it, the request's host) and `localhost`/`.local`/`.internal` names are refused (400), `CUSTOM_DOMAINS` limits them and is required while signup is open, and `/api/branding` serves the domain's branding to a signed-in user only when their workspace is that agency or one of its clients. Invite email `from` is `{ name, address }` (`OutgoingEmail.from` widened) so the product name stays a display name; product names reject `< > @ , ; : " \` and control characters. `/api/branding` adds `source` (`domain`/`workspace`/`default`); GET/PUT `/api/agency/branding` act on the active workspace (agency or client, admins; 409 for standard) and return own values, `inherited` and `effective`. `deleteWorkspace` also sends sessions inside it back home and closes the accounts' drivers. Web: `session.ts` (`Me`, `MeContext`, `canWrite`), `branding.ts`, `BrandMark` in `ui.tsx`; clients get Results and Leads tabs on a campaign and a board without the lead drawer. Not built: a seed demo agency; the workspace switcher on phone widths (the sidebar footer is hidden there). |
| g5-crm | M12 | planned | |
| g5-billing | M13 | planned | |
| postgres | none (translator) | planned | |

Every step finishes with `npm run typecheck`, `npm test` and `npm run build` green from the repo root, README
updated (features table, configuration table, limitations), and its row above set to `done`.

---

## 1. Baseline (what exists today)

- **Server** (`server/src`): Fastify 5, zod, sync SQLite wrapper `db/db.ts` over `node:sqlite` (`get/all/run/insert/update/tx`,
  nested `tx` joins the outer one, `BEGIN IMMEDIATE`). One migration entry (index 0) in `db/schema.ts`.
- **Ctx** (`context.ts`): `db, clock, config, sealer, drivers, webhooks, mailer, random`. Tests build it with a `ManualClock`,
  `:memory:` DB and seeded `random` (`test/helpers.ts → makeWorld`).
- **Engine** (`engine/engine.ts`): `tick()` runs every active account in parallel. Per account: sync every
  `SYNC_INTERVAL_MIN` in working hours, `advanceFreeSteps` (wait/condition), then at most one action when working,
  past `next_action_at` and under limits (`exhaustedActions`: daily limits with warm-up, weekly connect cap, 24 h
  cool-downs after `LIMIT_REACHED`). Campaign leads walk a tree sequence (`engine/sequence.ts`). Campaigns have one
  `account_id`. Email steps run inside the account loop, using the account's `smtp_enc` or a dry run.
- **Drivers**: `LinkedInDriver` interface; `SimulatorDriver` (state in `sim_people`, keyed by account); Playwright driver
  with every selector in `drivers/playwright/selectors.ts`, tested against `test/fixtures/linkedin-mock.ts`.
- **Auth**: cookie sessions; `users.workspace_id` + `users.role` (`owner|admin|member`); `requireAdmin` blocks only
  `member`. Most mutating routes have no role check (members may run campaigns).
- **Web** (`web/src`): React 19 + Vite + react-router 7; `api.ts` (`api()`, `useApi(path, poll)`, shared types),
  `components/ui.tsx` (Button, Pill, Modal, Field, Toggle, Empty, Meter, Tabs, Stat, ErrorNote, Pager, toasts,
  `useAction`), `styles.css`. Sidebar nav is hard-coded in `App.tsx`. Settings tabs: Team, Blacklist, Webhooks & CRM, Your profile.
- **Tests**: vitest; 31 pass, 9 Playwright tests skip without Chromium.

---

## 2. Principles and conventions

### 2.1 Module layout

New server code goes in these folders (create them as needed; keep files small and single-purpose):

```
server/src/
  jobs/         queue.ts (JobQueue), types.ts (JobPayloads), handlers.ts (registerHandlers: the one place handlers are wired)
  providers/    registry.ts, store.ts (integrations rows + resolver), http.ts (httpJson, ProviderError, RateLimiter)
    ai/ data/ crm/ sms/        one folder per kind: types.ts, simulated.ts, <vendor>.ts (one module per vendor)
  ai/           prompts.ts, writer.ts, personalize.ts, classify.ts, categories.ts
  mail/         mailboxes.ts, compose.ts, runner.ts, inbound.ts, imap.ts, deliverability.ts, tracking.ts, unsubscribe.ts
  messaging/    runner.ts (SMS/WhatsApp), twilio-webhook.ts
  services/     existing + suppression.ts, settings.ts, usage.ts, rotation.ts, replies.ts, tasks.ts, pipeline.ts,
                tags.ts, memberships.ts, workspaces.ts, enrichment.ts
  crm/          sync.ts, triggers.ts
  billing/      plans.ts, stripe.ts, limits.ts
  routes/       one file per area: integrations.ts, jobs.ts, ai.ts, mailboxes.ts, tasks.ts, pipeline.ts, agency.ts, crm.ts, billing.ts, public.ts
web/src/pages/  Integrations.tsx (Settings tab), Mailboxes.tsx, Tasks.tsx, Pipeline.tsx, Agency.tsx, Billing.tsx, Invite.tsx
```

Style: match existing code. Short "why" comments, no banner comments, camelCase in TS and JSON, snake_case in SQL,
`serializeX()` functions turn rows into API JSON. Reuse `parse()`, `idParam`, `HttpError`, `notFound()`.

### 2.2 Migrations

- `MIGRATIONS` in `server/src/db/schema.ts` is append-only. **Never edit an existing entry.** Each step appends
  exactly one entry, labelled with a comment `// [M7] g3-mailboxes: mailboxes, email messages`. The M-numbers in this
  plan are labels; the real index is the array position. If an earlier step was rolled back, your entry simply lands
  one slot earlier. (Delete any local dev database created by a rolled-back run; tests use `:memory:`.)
- If a step needs a fix after its entry exists in a commit, append another entry; do not edit.
- Migrations must be safe on existing databases: `ALTER TABLE ... ADD COLUMN` with `NULL` or a constant default; FKs on
  added columns must default to `NULL`; `UNIQUE` goes in a separate `CREATE UNIQUE INDEX`; data backfills use plain
  `INSERT ... SELECT` / `UPDATE ... WHERE` and must tolerate rows pointing at deleted parents (filter with
  `IN (SELECT id FROM parent)`).
- Data upgrades that need secrets or JSON parsing (for example decrypting SMTP settings) are **not** migrations: write
  an idempotent `ensureX(ctx)` and call it from `buildContext` after the DB is open.

**Portable SQL subset** (from foundation on, so the postgres step only has to convert the pre-existing code):

1. Ids: `id INTEGER PRIMARY KEY` (never `AUTOINCREMENT`). Composite-key join tables use `PRIMARY KEY (a, b)`.
2. Times are `INTEGER` milliseconds from `ctx.clock.now()`. Booleans are `INTEGER` 0/1. JSON is `TEXT` parsed in JS
   (`json()` helper); no `json_extract`/`json_each`. Fractions are `REAL`.
3. Never `INSERT OR IGNORE/REPLACE`; use `INSERT ... ON CONFLICT (cols) DO NOTHING` or `DO UPDATE SET x = excluded.x`.
4. Never select or aggregate a boolean expression: `SUM(CASE WHEN x = 'y' THEN 1 ELSE 0 END)`, not `SUM(x = 'y')`.
5. No two-argument scalar `MAX(a, b)`/`MIN(a, b)`; use `CASE WHEN`.
6. camelCase result aliases must be double-quoted: `created_at AS "createdAt"`. (Postgres folds unquoted names.)
7. No `COLLATE NOCASE` on new columns; store emails lower-cased and compare with `lower(x) = lower(?)` when needed.
8. Need the new id? Use `db.insert()` or `db.get('INSERT ... RETURNING id')`. Do not rely on `run().id` in new code.
   `insert()`'s return value only means something for tables with an `id INTEGER PRIMARY KEY` column; tables keyed
   otherwise (`sessions`, `memberships`, `campaign_accounts`, `workspace_settings`, `branding`, ...) must ignore it.
9. No date functions in SQL; compute day strings (`localParts`) and month strings (`YYYY-MM`) in JS.
10. `LIKE` is only used for user search boxes and is assumed case-insensitive (postgres translates it to `ILIKE`).
11. `ORDER BY` on nullable columns must not depend on NULL ordering (add `CASE WHEN col IS NULL THEN 1 ELSE 0 END`).
12. Only `DB` methods touch the database. Never use `ctx.db.raw`.

### 2.3 Provider pattern (all external services)

Every external service is optional. The app must run, build and pass tests with no keys and no network.

- A **kind** is a capability with one TS interface: `ai`, `email_finder`, `email_verifier`, `enrichment`, `crm`,
  `sms`. (Mailboxes and Stripe billing are not workspace integrations: mailboxes are first-class objects (g3) and
  billing is installation-level env config (g5-billing).)
- A **provider definition** (`providers/registry.ts`):
  ```ts
  export interface ProviderDef<K extends ProviderKind = ProviderKind> {
    id: string;                     // 'simulated' | 'anthropic' | 'openai_compat' | 'hunter' | 'apollo' | ...
    kind: K;
    label: string;
    description: string;
    docsUrl?: string;
    simulated?: boolean;
    fields: FieldSpec[];            // drives the generic config form in the UI
    credentials: z.ZodTypeAny;      // secret fields only (sealed)
    settings: z.ZodTypeAny;         // non-secret fields
    create(ctx: Ctx, cfg: { integrationId: number | null; workspaceId: number; credentials: any; settings: any }): KindInstance<K>;
  }
  export interface FieldSpec { key: string; label: string; type: 'text' | 'password' | 'url' | 'number' | 'select' | 'textarea' | 'toggle'; secret?: boolean; required?: boolean; placeholder?: string; help?: string; options?: { value: string; label: string }[] }
  export interface BaseProvider { readonly providerId: string; readonly simulated: boolean; test(): Promise<{ ok: boolean; message: string }> }
  ```
  `KindInstance<K>` maps a kind to its interface through `interface ProviderKinds { ai: AiProvider; ... }` in
  `registry.ts`. Foundation writes every kind's interface (`providers/<kind>/types.ts`, shapes as given in the step
  that first uses it: 4.5 ai, 4.8 sms, 4.9 email_finder/email_verifier/enrichment, 4.12 crm) **and** a simple
  deterministic `simulated` implementation of each, because the spec asks for "an interface per kind with a simulated
  implementation" in foundation and so the Integrations page has something to show and test. Later steps add the real
  vendors and refine the simulated behaviour (for example g2-ai-replies adds keyword classification); interface
  changes are additive only. Defs are registered in `providers/index.ts` (`registerProvider(def)`), imported once from
  `buildContext`.
- **Simulated provider**: every kind ships one. It works offline and is deterministic: it derives pseudo-randomness
  from a hash of its inputs (so results do not depend on call order) and uses `ctx.random` only where order is fixed.
  (This deviates slightly from "seeded by ctx.random" so cached and re-run results stay identical.)
- **Resolution**: `ctx.providers.get(workspaceId, kind)` returns the first enabled configured integration of that kind
  (lowest `priority`), else the simulated instance. `ctx.providers.list(workspaceId, kind)` returns all enabled ones in
  priority order (used by waterfalls), or `[simulated]` when none is configured. **Exception: `crm` never falls back**
  (`get` returns `null`, `list` returns `[]`): CRM sync runs only for integrations the user added, otherwise every
  workspace would churn sync jobs against a fake CRM. To demo it, add "Simulated CRM" explicitly (the simulated provider
  can be saved as an integration row like any other). `ctx.providers.status(workspaceId)` says per kind what is in use.
- **Simulated output never reaches a real recipient.** Text generated by a simulated AI provider is only sent through a
  simulated channel (simulator LinkedIn account, simulated mailbox, simulated SMS); on a real channel the step uses
  the fallback and logs why. Simulated finders only return `@<company>.example` addresses (`email_source =
  'simulated'`) and real mailboxes refuse to send to them. Simulated SMS/CRM never transmit.
- **HTTP**: all outbound calls use `httpJson(ctx, url, { method, headers, body, timeoutMs = 15000, limiter })` from
  `providers/http.ts`, which goes through `ctx.fetch` (tests inject a fake), applies `AbortSignal.timeout`, and maps
  failures to `ProviderError(code, message, { retryAfterMs, status })` with codes `AUTH | QUOTA | RATE_LIMIT |
  BAD_REQUEST | NOT_FOUND | UNAVAILABLE | TIMEOUT`. 401/403 → `AUTH`, 402 → `QUOTA`, 429 → `RATE_LIMIT` (reads
  `Retry-After`), 5xx/network → `UNAVAILABLE`, abort → `TIMEOUT`. Error messages never include keys, auth headers or
  full request URLs with query-string keys: `httpJson` takes the credential values and scrubs them from any message
  (some vendors echo the key back), and only a short vendor error string (≤ 200 chars) from the response is kept, never
  the raw body. Requests use `redirect: 'error'` so credentials are never replayed to another host. `ProviderError`
  carries `integrationId` so the job queue can mark the right integration. `RateLimiter` is an in-memory token bucket
  keyed by integration id.
- **User-supplied hosts** (OpenAI-compatible `baseUrl`, mailbox SMTP/IMAP hosts, Pipedrive `companyDomain`) are
  SSRF and token-leak vectors. Rules: `baseUrl` must be `http(s)://` with no credentials in it; Pipedrive
  `companyDomain` must match `^[a-z0-9][a-z0-9-]{0,62}$` (it is interpolated into `https://{x}.pipedrive.com`);
  hostnames are validated as hostnames. When billing is enabled (a hosted, multi-tenant installation), hosts that
  resolve to loopback, private, link-local or metadata addresses are refused; self-hosted installs allow them so local
  models (Ollama, LM Studio) and in-house SMTP keep working.
- Keep each vendor's request/response mapping in its own module. Write down the endpoint and doc URL at the top, and
  say plainly in a comment that it follows the vendor's public docs and was tested only against fakes.

### 2.4 Job queue

Durable queue in the `jobs` table, run by `JobQueue` (`ctx.jobs`) inside the engine process:

```ts
ctx.jobs.enqueue(type, payload, { workspaceId, runAt?, dedupeKey?, maxAttempts? }): number   // returns job id (existing id if deduped)
ctx.jobs.register(type, handler, { concurrency?: number; maxAttempts?: number; timeoutMs?: number })
type Handler<T> = (job: { id: number; workspaceId: number | null; payload: T; attempts: number }, h: { ctx: Ctx; progress(done: number, total?: number): void; signal: AbortSignal }) => Promise<unknown>
throw new RetryLater(ms, reason)   // reschedule without using up an attempt (rate limits, waiting on something)
throw new PermanentError(message)  // fail now, no retry (bad config, missing row)
```

- Payload types live in `jobs/types.ts` as `interface JobPayloads { 'ai.personalize': {...}; ... }`; each step adds its
  keys. Handlers are wired only in `jobs/handlers.ts → registerHandlers(ctx)` (called from `buildContext`).
- `Engine.tick()` calls `ctx.jobs.tick()`, so jobs run only where the engine runs (`RUN_WORKER`), and tests drive them
  with `runFor()`. API-only tests call `await ctx.jobs.drain()` (runs due jobs until none are left, bounded rounds).
- `tick()` claims at most `JOB_CONCURRENCY` (default 4) **minus the jobs already in flight in this process**,
  respecting per-type concurrency, and returns a promise for the jobs it started. The production engine timer is
  `setInterval`, so ticks overlap while a long job runs; the in-memory in-flight count (not the tick) is what bounds
  concurrency, and `Engine.tick()` awaiting the jobs only matters for tests. Claim = one
  `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *` statement (the postgres step adds `FOR UPDATE SKIP LOCKED`
  there; keep the claim SQL in one method).
- Retries: on a thrown error, `attempts < max_attempts` → `queued` again with `run_at = now + min(30s × 4^(attempts−1), 6h) × (0.8 + 0.4 × ctx.random())`;
  otherwise `failed` with `last_error`. `ProviderError` codes `AUTH`/`QUOTA`/`BAD_REQUEST` are permanent and also set the
  integration's `last_status = 'error'`. `RATE_LIMIT` becomes `RetryLater(retryAfterMs ?? 60s)`.
- Running jobs carry `locked_until = now + timeoutMs (default 10 min)`; `h.progress()` also pushes `locked_until`
  forward, and long handlers (`leads.import`, `email.sync`) register a larger `timeoutMs` and report progress at least
  every few minutes. The timeout is **enforced** in `run()` (a wall-clock timer re-armed by `progress()`, since the demo
  clock runs fast): a run that goes `timeoutMs` without finishing or reporting progress is settled as a normal
  (retryable) failure, `h.signal` is aborted (handlers pass it to fetch/Playwright calls), its concurrency slots are
  freed, and anything the abandoned promise does later (result, error, `progress()`) is ignored. Crash recovery: the first tick after start re-queues every `running` job (SQLite has one worker
  process, so they are all orphans); later ticks re-queue `running` jobs whose lock expired **and that are not in this
  process's in-flight set** (that case only matters for Postgres multi-instance). Without this, a 1000-profile import
  would be re-queued mid-run and scrape twice.
- Dedupe: `dedupe_key` is unique among `queued`/`running` jobs (partial unique index). Keys always start with the type and
  include the workspace or entity id, e.g. `ai.classify:msg:812`. Enqueue uses `ON CONFLICT DO NOTHING` and then returns
  the live job's id. Consequence: an enqueue while the same key is *running* is absorbed by the running job. So handlers
  work from the current database state (not only the payload snapshot), and callers re-enqueue whenever they find
  pending work with no live job (see `resolveAiVars` in 4.5).
- `POST /api/jobs/:id/retry` returns 409 when another live job already holds the same `dedupe_key` (the partial unique
  index would otherwise make it a 500).
- Cleanup: once an hour (tracked in memory) delete `done`/`cancelled` jobs older than 7 days and `failed` older than 30 days.
- Handlers are idempotent (a job can run twice after a crash) and load every row with `AND workspace_id = ?` using the
  job's `workspaceId`.

### 2.5 Secrets

- All secrets (API keys, tokens, SMTP/IMAP passwords, Twilio auth token) are sealed with
  `ctx.sealer.seal(JSON.stringify(obj))` into a `*_enc` column. Never log them, never return them.
- API responses show `mask(secret)` (`services/crypto.ts`): `••••` + last 4 characters when the secret is 12+ chars,
  otherwise `••••`. Responses also carry `hasCredentials: boolean`.
- Updates: a secret field that is omitted or `''` keeps the saved value (same rule as today's SMTP password). Send
  `null` explicitly to clear it.
- Tests assert that the plaintext secret appears nowhere in the JSON response and not in the DB column.
- Installation-level secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SMTP_URL`, `DATABASE_URL`) come from env only.

### 2.6 Tenant isolation

- Every table that holds tenant data has `workspace_id` or hangs off a parent that has one. Every query from a route
  includes `workspace_id = user(req).workspace_id` (directly or through a join to the owning row). A row from another
  workspace is a **404**, never a 403.
- IDs in request bodies (`accountIds`, `mailboxIds`, `leadIds`, `assigneeId`, `ownerId`, `integrationId`, `stageId`, ...) are
  validated against the workspace before use (user ids: must be a member of the workspace). Bulk id lists are filtered
  with `AND workspace_id = ?`. Ids stored inside sequence JSON (`assigneeId`) are re-checked when used.
- Jobs carry `workspace_id`; handlers re-check ownership. The jobs API never lists system jobs (`workspace_id IS NULL`)
  and never returns payloads. Webhook/event payloads only go to the workspace's own hooks.
- Public endpoints (unsubscribe, tracking, Twilio, Stripe, invites, branding) identify the tenant only through a
  signed token, a signature-verified payload or a stored mapping, never through a client-supplied workspace id.
- Absolute links (unsubscribe, tracking, invites, Stripe return URLs, Twilio signature base) are built from
  `PUBLIC_URL` only, never from the request's `Host` header (host-header injection). `Host` is used only to pick
  branding (g5-agency).
- Every step's tests include at least one cross-workspace test (second workspace gets 404 / sees nothing).

### 2.7 Roles

`type Role = 'owner' | 'admin' | 'member' | 'client'` (defined in foundation in `http.ts`; `client` is first used in g5-agency).

Helpers in `http.ts` (foundation): `requireRole(req, ...roles)`, `requireAdmin(req)` = owner/admin (positive check;
today's version only rejects `member`, which would let a future `client` through), `requireWriter(req)` = any role
except `client`, `requireOwner(req)`.

| Action | owner | admin | member | client |
|---|---|---|---|---|
| Read dashboards, campaigns, inbox, pipeline | yes | yes | yes | yes (allowlist, g5-agency) |
| Run campaigns, manage leads, reply, tasks, tags, notes | yes | yes | yes | no |
| LinkedIn accounts (existing behaviour: members may manage) | yes | yes | yes | no |
| Mailboxes, integrations, webhooks, team, invites, pipeline stages, branding | yes | yes | no | no |
| Agency: create clients, overview, branding | yes (agency) | yes (agency) | no | no |
| Agency: rename/delete clients; billing | yes | no | no | no |

New mutating routes use `requireWriter` at minimum. Foundation also switches the webhook secret visibility check to
`requireAdmin` semantics.

### 2.8 Errors

- `HttpError` statuses: 400 validation, 401 not signed in, 402 plan limit (g5-billing, body `details: { code: 'plan_limit', limit, allowed, used }`),
  403 role, 404 missing or other workspace, 409 state conflict, 422 external service refused (provider/LinkedIn/SMTP;
  message is user-readable, no secrets), 429 our own rate limit.
- Background failures are visible: an `activity` row (`status: 'failed'`, short `detail`), `campaign_leads.last_error`
  for the lead, `integrations.last_status/last_message` for provider auth/quota failures, job `last_error` in the jobs API.
  One lead's failure never blocks the campaign; one provider's failure never blocks the engine loop.

### 2.9 LinkedIn safety

- Every new LinkedIn action type is added to `ACTION_TYPES` and `DEFAULT_LIMITS` so `exhaustedActions` (daily limit,
  warm-up ramp, cool-downs) covers it automatically, and it runs through the account loop (one action per account per
  tick, `next_action_at` randomized delay, working hours).
- Scraping (imports) counts against a per-account `scrape` daily profile budget (g1-sources), runs only in working hours
  through `ctx.drivers.use` (serialized with actions), and pushes `next_action_at` like an action does.
- Rotation (g1-rotation) only decides *which* account handles a lead; each account still checks its own limits, so no
  account can exceed its limits because of rotation.
- New Playwright code: selectors only in `selectors.ts`, accessible names first, comments say "best effort, not tested
  against the live site", extend `test/fixtures/linkedin-mock.ts` and `playwright-driver.test.ts` where practical.

### 2.10 Engine extension points (final shape after all steps)

```ts
async tick() {
  this.advanceFreeSteps();                 // g1-rotation: global, not per account
  await Promise.all([
    ...activeAccounts.map((a) => this.runAccount(a)),   // LinkedIn sync + one LinkedIn action
    this.mail.tick(),                      // g3-mailboxes: email nodes for campaigns that have mailboxes
    this.messaging.tick(),                 // g3-tasks-sms: sms/whatsapp nodes
    this.ctx.jobs.tick(),                  // foundation
  ]);
}
```

- **Node families** (keep these constants in `engine/sequence.ts`):
  `ACTION_TYPES` (LinkedIn, account-limited; `email` stays here for the legacy no-mailbox path),
  `FREE_NODE_TYPES = ['wait', 'condition', 'task', 'find_email']` (advanced by `walk()`; `task`/`find_email` hold the lead),
  `CHANNEL_NODE_TYPES = ['sms', 'whatsapp']` (+ `email` when the campaign has mailboxes).
- **Overlapping ticks**: the production timer is `setInterval`, so a tick can start while the previous one is still
  sending. `runAccount` is already guarded by `Engine.busy`; every new runner needs the same in-memory guard
  (`MailRunner`: per mailbox, `MessagingRunner`: per workspace), or a slow SMTP/Twilio call lets the next tick pick
  the same due lead and send twice.
- `advanceFreeSteps()` becomes global in g1-rotation, so raise `FREE_STEPS_PER_TICK` from 500 (per account) to 2000.
- **Holds** (g2-ai-replies adds `campaign_leads.hold_reason`): a lead waiting on something external keeps
  `next_run_at` at its deadline and `hold_reason` in `reply | task | enrich`. The thing it waits on clears the hold and
  sets `next_run_at = now`; if the deadline passes first, the engine applies the documented timeout behaviour.
  Held leads are also woken **spuriously** (sequence edits run `reconcile()`, which sets `next_run_at = now` for every
  active lead; sync wakes `condition` leads). Every hold handler therefore re-checks its condition and re-holds
  idempotently (no second task, no second enrich job, deadline unchanged).
- **Stopping leads** goes through `services/replies.ts` helpers from g2-ai-replies on: `stopCampaignLead(ctx, cl, state, reason)` and
  `stopLeadEverywhere(ctx, leadId, state, reason)`; they also close open tasks (g3-tasks-sms hooks in).
- **Inbound replies** from every channel go through `handleInboundReply(ctx, { lead, channel, conversationId, messageId, body, accountId?, mailboxId? })`
  (g2-ai-replies), which sets `replied_at`, applies stop-on-reply or holds, logs `replied`, emits `lead.replied`,
  enqueues `ai.classify` and (g5-pipeline) moves the stage.
- **Contact activity types** (count as "contacted" in analytics and stage automation): `CONTACT_ACTIVITY_TYPES` in
  `services/activity.ts` (foundation: `connect, message, email`; g1-sources adds `inmail`; g3-tasks-sms adds `sms, whatsapp`).
  Analytics queries use this constant instead of literal lists.

### 2.11 Events and webhooks

`Webhooks` gets `subscribe(fn: (workspaceId, event, data) => void)` (foundation). `emit()` delivers to HTTP hooks and
calls subscribers synchronously in a try/catch; subscribers only enqueue jobs (CRM uses this). New events are appended
to `WEBHOOK_EVENTS`:

| Event | Step | data |
|---|---|---|
| `lead.suppressed` | foundation | `{ lead, reason, source }` |
| `lead.classified` | g2-ai-replies | `{ lead, category, confidence, message, conversationId }` |
| `mailbox.needs_attention` | g3-mailboxes | `{ mailboxId, name, reason }` |
| `lead.email_bounced` | g3-mailboxes | `{ lead, email, reason }` |
| `task.created`, `task.completed` | g3-tasks-sms | `{ task, lead }` |
| `lead.enriched` | g4-data | `{ lead, emailStatus, source }` |
| `lead.stage_changed` | g5-pipeline | `{ lead, from, to, source }` |

All existing payload shapes stay as they are; new fields may be added, never removed. `publicLead()` gains fields as
steps add them (`stage`, `emailStatus`, `replyCategory`).

### 2.12 Testing

- Never hit the network. `makeWorld()` sets `ctx.fetch` to a function that throws `Network access in tests` unless a
  test passes its own fake; `ctx.dns`, `ctx.imap`, `ctx.stripe` get stubs. `test/helpers.ts` gains (foundation):
  `fakeFetch(routes)` (records calls; routes are `{ method, url: RegExp, reply: (req) => ({ status, json?, text?, headers? }) }`),
  `makeApi(w)` (modelled on `api.test.ts`'s `setup()`: `call()`, `register()`, `addUser(role)`, `as(user)`; `api.test.ts`
  itself does not have to change), and `drainJobs(w)`. From g3-mailboxes on, `ctx.mailer` in `makeWorld` is a recording
  fake whose real-transport path throws, so no test can reach an SMTP server through nodemailer.
- Tests that only make sense on SQLite (`migrateTo`, `PRAGMA foreign_key_check`) use `it.skipIf(ctx.db.dialect !== 'sqlite')`.
- Engine tests use `ManualClock` + `runFor()`. Seeded `random` everywhere.
- Each step adds tests in a new file named after it (`test/rotation.test.ts`, `test/abtest.test.ts`, ...) rather than
  growing `engine.test.ts`. Existing tests must keep passing unmodified except for helper changes noted in a step.
- Every step includes: happy path, limits/safety, role checks (member/client 403 where relevant), workspace isolation,
  secret masking where secrets exist.
- Playwright tests stay `skipIf(!haveBrowser)`.

### 2.13 UI patterns

- Pages use the existing skeleton: `.page-head` (h1 + p + actions), `.card`, `.grid grid-2|3`, `Tabs`, `Modal`
  (with `footer`), `Field` (always label every control), `Pill` for statuses (extend `STATUS_TONE` for new statuses),
  `useApi(path, poll)`, `useAction()` for buttons with busy state and toasts, `Empty` for empty states, `Pager`.
- New shared components go in `components/ui.tsx`, each added by the first step that uses it (no unused components):
  `SecretField` (shows "Saved ••••abcd, leave blank to keep"), `ProviderBadge` ("Simulated" badge with tooltip) and
  `ConfirmButton` (foundation); `CheckList` (accessible multi-select of options with status pills, for
  senders/mailboxes; g1-rotation); `ProgressBar` (g1-sources). Styles go in `styles.css` using the existing CSS variables.
- Navigation (foundation): `App.tsx` builds the sidebar from a `NAV` array
  `{ to, label, end?, roles?: Role[], feature?: keyof Features, badge?: 'inbox' | 'tasks' }`. `/api/auth/me` returns
  `features: Record<string, boolean>` (foundation returns `{}`; later steps add `billing`, `agency`). A step adds its
  nav entry only when its page exists. Final order: Dashboard, Campaigns, Leads, Pipeline, Tasks, Inbox,
  LinkedIn accounts, Mailboxes, Agency, Billing, Settings. Clients see Dashboard, Campaigns, Pipeline, Inbox.
- Keyboard and screen readers: every drag-and-drop has a button/select alternative; icon buttons have `aria-label`.
- Mirror every server JSON shape in `web/src/api.ts` types; labels for new node types/conditions in `format.ts`.

### 2.14 Dependencies

Allowed additions (pure JS, no install scripts): `@anthropic-ai/sdk` (g2-ai-writer), `imapflow` (g3-mailboxes),
`stripe` (g5-billing), `pg` + `@types/pg` (postgres; optionally `embedded-postgres` as a dev dependency). Everything
else (OpenAI-compatible, Hunter, Apollo, ZeroBounce, NeverBounce, HubSpot, Pipedrive, Twilio) uses `fetch` via
`httpJson`. Install with `npm install -w server <pkg>`. Never `npm audit fix --force`.

---

## 3. Shared configuration and Ctx

### 3.1 Ctx after all steps

```ts
export interface Ctx {
  db: DB;                      // postgres step: `Database` interface (SQLite class keeps the name DB)
  clock: Clock; config: Config; sealer: Sealer; drivers: DriverPool; webhooks: Webhooks; mailer: Mailer; random: () => number;
  fetch: typeof fetch;         // foundation (default globalThis.fetch)
  jobs: JobQueue;              // foundation
  providers: ProviderResolver; // foundation
  dns: DnsResolver;            // g3-mailboxes: { resolveMx, resolveTxt } (node:dns/promises Resolver by default)
  imap: ImapFactory;           // g3-mailboxes: (cfg) => ImapClient (imapflow adapter by default)
  stripe: StripeLike | null;   // g5-billing: null unless STRIPE_SECRET_KEY is set
}
```

`buildContext(config, clock, overrides)` keeps accepting overrides for every field.

### 3.2 Environment variables (all optional)

| Variable | Step | Default | Purpose |
|---|---|---|---|
| `PUBLIC_URL` | foundation | unset | External base URL (https://...). Needed for unsubscribe/tracking links, Twilio signature checks, invite links, Stripe return URLs. Features that need it say so in the UI when it is missing. |
| `JOB_CONCURRENCY` | foundation | `4` | Jobs running at once per process |
| `AI_WAIT_MAX_MIN` | g2-ai-writer | `30` | How long a step waits for AI variables before using fallbacks |
| `REPLY_HOLD_MIN` | g2-ai-replies | `30` | How long a replied lead is held for classification before stopping |
| `MAIL_SYNC_INTERVAL_MIN` | g3-mailboxes | `5` | IMAP polling interval per mailbox |
| `SMTP_URL`, `MAIL_FROM` | g5-agency | unset | Installation mailer for system email (invites). Without it the invite link is shown in the UI. |
| `TRUST_PROXY` | g5-agency | `false` | Trust `X-Forwarded-*` (client IP, Host-based branding) through proxies: `true` = 1 hop, a number = that many hops, or a list of proxy addresses/CIDRs |
| `CUSTOM_DOMAINS` | g5-agency | unset | Hostnames or `*.suffix` patterns allowed as custom domains; unset = any, but none while `ALLOW_SIGNUP=true` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | g5-billing | unset | Billing is off unless the key is set |
| `BILLING_PLANS` / `BILLING_PLANS_FILE` | g5-billing | unset | Plan JSON (inline or file path) |
| `DATABASE_URL` | postgres | unset | `postgres://...` switches to Postgres |
| `TEST_DATABASE_URL` | postgres | unset | Runs the test suite against Postgres |

`testConfig()` in `test/helpers.ts` gets every new field with a test-safe value (`publicUrl: 'http://localhost:8787'`).

---

## 4. Steps

Each step lists: migration SQL to append, server modules, Ctx/config, jobs, routes, engine, web, webhooks, env, tests.

### 4.1 foundation: job queue, integrations store, provider pattern, navigation

**Migration M1**

```sql
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',          -- queued | running | done | failed | cancelled
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_at INTEGER NOT NULL,
  dedupe_key TEXT,
  locked_until INTEGER,
  progress TEXT,                                   -- JSON { done, total }
  result TEXT,                                     -- JSON, small
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX jobs_due ON jobs(status, run_at);
CREATE INDEX jobs_workspace ON jobs(workspace_id, type, status);
CREATE UNIQUE INDEX jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

CREATE TABLE integrations (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                              -- ai | email_finder | email_verifier | enrichment | crm | sms
  provider TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  credentials_enc TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  last_status TEXT,                                -- ok | error
  last_message TEXT,
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, kind, provider)
);

CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  operation TEXT NOT NULL,                         -- ai.write | ai.personalize | ai.classify | ai.reply | finder.find | verifier.verify | enrich.person | crm.upsert | sms.send ...
  credits INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  month TEXT NOT NULL,                             -- 'YYYY-MM' (UTC)
  created_at INTEGER NOT NULL
);
CREATE INDEX usage_events_month ON usage_events(workspace_id, month, kind);

CREATE TABLE workspace_settings (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL,                             -- JSON
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, name)
);

-- Identities that must never be contacted again (unsubscribe, STOP, not interested, manual).
CREATE TABLE suppressions (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                              -- linkedin (public_id) | email (lower-cased) | phone (E.164)
  value TEXT NOT NULL,
  reason TEXT NOT NULL,                            -- unsubscribe | not_interested | sms_stop | bounce | manual
  source TEXT,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, kind, value)
);

-- Conversations become channel-agnostic: email/SMS threads have no LinkedIn account.
-- Rebuilt with messages so foreign keys stay valid while foreign_keys = ON inside the migration transaction.
CREATE TABLE conversations_new (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'linkedin',        -- linkedin | email | sms | whatsapp
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  thread_id TEXT NOT NULL,
  participant_name TEXT NOT NULL DEFAULT '',
  participant_url TEXT NOT NULL DEFAULT '',
  last_message_at INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  UNIQUE (account_id, thread_id)
);
INSERT INTO conversations_new (id, workspace_id, channel, account_id, lead_id, thread_id, participant_name, participant_url, last_message_at, unread)
  SELECT id, workspace_id, 'linkedin', account_id, lead_id, thread_id, participant_name, participant_url, last_message_at, unread FROM conversations;
CREATE TABLE messages_new (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations_new(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  UNIQUE (conversation_id, external_id)
);
INSERT INTO messages_new (id, conversation_id, external_id, direction, body, sent_at)
  SELECT id, conversation_id, external_id, direction, body, sent_at FROM messages;
DROP TABLE messages;
DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;   -- also rewrites messages_new's REFERENCES
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX conversations_workspace ON conversations(workspace_id, last_message_at);
CREATE INDEX conversations_lead ON conversations(lead_id);
```

**Server**

- `db/db.ts`: `readonly dialect = 'sqlite' as const`; constructor option `{ migrateTo?: number }` (tests only: runs
  only the entries with index `< migrateTo`, so `migrateTo: 1` is the original schema; a later `new DB` on the same
  file, or a `migrate()` call, runs the rest). No change to existing entries.
- `jobs/queue.ts`, `jobs/types.ts`, `jobs/handlers.ts` per 2.4. `JobQueue` exposes `enqueue`, `register`, `tick`,
  `drain`, `get(id, workspaceId)`, `list(workspaceId, filter)`, `retry(id, ws)`, `cancel(id, ws)`.
- `providers/registry.ts`, `providers/store.ts` (CRUD + `ProviderResolver`), `providers/http.ts`, `providers/index.ts`,
  and per kind `providers/<kind>/types.ts` + `simulated.ts` (2.3). Foundation registers only the six simulated
  providers (no real vendors); the UI shows every kind with "Built-in simulator" in use.
- `services/crypto.ts`: `mask(secret)`. `services/settings.ts`: `getSetting(ctx, ws, name, schema)`, `setSetting(...)`.
  `services/usage.ts`: `recordUsage(ctx, {...})`, `monthlyUsage(ctx, ws, month)`.
  `services/suppression.ts`: `suppressLead(ctx, lead, reason, source)` (inserts linkedin + email + phone identities,
  stops the lead's active campaign leads with state `skipped` and `last_error = 'Suppressed: <reason>'`, emits
  `lead.suppressed`), `suppressIdentity(ctx, ws, kind, value, reason, source)`, `suppressionReason(ctx, lead)`.
  `addLeadsToCampaign` counts suppressed leads as `suppressed` (new result key) and skips them; `runAction` checks
  `suppressionReason` right after `blacklistReason` and finishes the lead as `skipped`.
- `services/activity.ts`: export `CONTACT_ACTIVITY_TYPES`; use it in `routes/settings.ts` analytics and `campaignStats`.
- `http.ts`: `Role`, `requireRole`, `requireAdmin` (positive), `requireWriter`, `requireOwner`.
- `app.ts`: unauthenticated paths are `PUBLIC` exact matches **or** prefix `/api/public/`. Register `routes/integrations.ts`, `routes/jobs.ts`.
  Also register a small `application/x-www-form-urlencoded` content-type parser (`URLSearchParams` → plain object, no
  new dependency): g3-mailboxes needs it for RFC 8058 one-click unsubscribe and the confirmation form, g3-tasks-sms for
  Twilio. (Fastify answers 415 without it; the plan used to add it only in g3-tasks-sms, after g3-mailboxes needed it.)
  Form bodies are the one thing a cross-site `<form>` can send without a CORS preflight, so the `onRequest` hook answers
  415 to them on every `/api/` path except the provider-callback prefixes in `FORM_PREFIXES` (`/api/public/twilio/`);
  paths outside `/api` (`/u/:token`) accept them. This blocks login CSRF and same-site form posts to the JSON API
  (review finding). Never add a route that signs someone in or acts as the session user to `FORM_PREFIXES`.
- `webhooks.ts`: `subscribe()`; add `lead.suppressed`.
- `routes/auth.ts`: `/api/auth/me` adds `features: {}`.
- `Config`: `publicUrl?: string`, `jobConcurrency: number`. Ctx: `fetch`, `jobs`, `providers`.
- Leave the existing search import as it is (g1-sources moves it onto the queue).

**Routes**

| Method | Path | Role | Request → Response |
|---|---|---|---|
| GET | `/api/integrations/providers` | any | → `[{ id, kind, label, description, docsUrl, simulated, fields }]` |
| GET | `/api/integrations/status` | any | → `{ [kind]: { provider, label, simulated, integrationId \| null } }` |
| GET | `/api/integrations` | admin | → `[{ id, kind, provider, label, enabled, priority, settings, credentials: { key: masked }, hasCredentials, lastStatus, lastMessage, lastCheckedAt, createdAt, updatedAt }]` |
| POST | `/api/integrations` | admin | `{ kind, provider, label?, enabled?, settings?, credentials? }` → integration (409 if that provider already exists for the kind) |
| PATCH | `/api/integrations/:id` | admin | `{ label?, enabled?, settings?, credentials? }` (blank secret keeps) → integration |
| DELETE | `/api/integrations/:id` | admin | → `{ ok }` |
| POST | `/api/integrations/:id/test` | admin | → `{ ok, message }` (also stores `last_status`) |
| PUT | `/api/integrations/order` | admin | `{ kind, ids: number[] }` → `{ ok }` (sets `priority` = index) |
| GET | `/api/usage` | admin | `?month=YYYY-MM` → `{ month, rows: [{ kind, provider, operation, calls, credits, inputTokens, outputTokens }] }` |
| GET | `/api/jobs` | any | `?type&status&limit` → `[{ id, type, status, attempts, progress, lastError, runAt, createdAt, finishedAt }]` (workspace only) |
| GET | `/api/jobs/:id` | any | → job (+ `result`) |
| POST | `/api/jobs/:id/retry` | admin | failed → queued |
| POST | `/api/jobs/:id/cancel` | admin | queued → cancelled |

Test connection calls `instance.test()` with a 15 s timeout; simulated providers always return `{ ok: true }`.

**Web**

- `App.tsx`: `NAV` array per 2.13 (same five links as today plus Settings); `Me` gains `features`.
- Settings: the "Webhooks & CRM" tab becomes **Integrations** (`pages/Integrations.tsx`, rendered as a tab): a
  "Providers" section (per kind with registered providers: card per configured integration with status dot,
  `ProviderBadge`, Configure / Test connection / Remove; "Add provider" modal with a generic form built from `fields`;
  `SecretField` for secrets; up/down buttons to reorder within a kind) and the existing Webhooks section below.
  Members see the tab read-only (status only).
- `ui.tsx`: `SecretField`, `ProviderBadge`, `ConfirmButton` (the other shared components arrive with their first user, 2.13).

**Tests** (`test/jobs.test.ts`, `test/integrations.test.ts`, `test/migrations.test.ts`)

- Jobs: runs a handler; retry with exponential backoff (check `run_at` gaps with ManualClock); `RetryLater` does not
  consume attempts; `PermanentError` fails at once; max attempts → `failed`; dedupe returns the same id while queued
  and allows a new job after `done`; orphaned `running` jobs are re-queued on the first tick, but a job still in flight
  is not re-queued when its lock expires, and `progress()` extends the lock; two overlapping `tick()` calls never run
  more than `JOB_CONCURRENCY` jobs; concurrency limit per type; jobs API shows only own workspace; retry with a live
  duplicate key → 409; member cannot retry/cancel.
- Integrations (with a test-only provider registered in the test): create/patch/delete; secret masked in every response
  and not present in `credentials_enc` plaintext; blank secret keeps the old one; member gets 403 on mutations and
  list; other workspace gets 404; test route updates `last_status`; unknown provider/kind → 400; settings validated by
  the def's zod schema; `httpJson` scrubs an echoed key from error messages; each simulated provider is resolved when
  nothing is configured, except `crm` (`null`).
- Suppression: suppressed lead is skipped by `addLeadsToCampaign` and by the engine before its next action.
- Migration: DB built with `migrateTo: 1`, insert a conversation + messages, run the rest; rows survive,
  `PRAGMA foreign_key_check` is empty, deleting a conversation still cascades to messages.

### 4.2 g1-rotation: sender rotation across LinkedIn accounts

**Migration M2**

```sql
CREATE TABLE campaign_accounts (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, account_id)
);
CREATE INDEX campaign_accounts_account ON campaign_accounts(account_id);
INSERT INTO campaign_accounts (campaign_id, account_id, created_at)
  SELECT id, account_id, created_at FROM campaigns WHERE account_id IN (SELECT id FROM accounts);

ALTER TABLE campaign_leads ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE campaign_leads ADD COLUMN contacted_at INTEGER;
CREATE INDEX campaign_leads_account ON campaign_leads(account_id, state, next_run_at);

-- Leads that already had an action keep the account that did it.
UPDATE campaign_leads SET account_id = (SELECT c.account_id FROM campaigns c WHERE c.id = campaign_leads.campaign_id AND c.account_id IN (SELECT id FROM accounts))
  WHERE EXISTS (SELECT 1 FROM activity a WHERE a.campaign_id = campaign_leads.campaign_id AND a.lead_id = campaign_leads.lead_id AND a.status = 'ok' AND a.account_id IS NOT NULL);
UPDATE campaign_leads SET contacted_at = (SELECT MIN(a.created_at) FROM activity a WHERE a.campaign_id = campaign_leads.campaign_id AND a.lead_id = campaign_leads.lead_id AND a.status = 'ok' AND a.type IN ('connect', 'message', 'email'))
  WHERE account_id IS NOT NULL;

-- Connection state per (lead, account); leads.connection_status stays as "connected to any of our accounts".
CREATE TABLE lead_connections (
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL,                            -- pending | connected
  connected_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (lead_id, account_id)
);
CREATE INDEX lead_connections_account ON lead_connections(account_id, status);
-- Deviation (review): also credit a successful view_profile (before M2 a 1st-degree badge seen on a view was the usual
-- way a lead became connected, and it logged only view_profile); invites/messages/acceptances win over views.
INSERT INTO lead_connections (lead_id, account_id, status, connected_at, updated_at)
  SELECT l.id,
         (SELECT a.account_id FROM activity a
           WHERE a.lead_id = l.id AND a.account_id IN (SELECT id FROM accounts)
             AND (a.type IN ('connect', 'accepted', 'message') OR (a.type = 'view_profile' AND a.status = 'ok'))
           ORDER BY CASE WHEN a.type = 'view_profile' THEN 1 ELSE 0 END, a.id DESC LIMIT 1),
         l.connection_status, l.connected_at, l.created_at
  FROM leads l
  WHERE l.connection_status IN ('pending', 'connected')
    AND EXISTS (SELECT 1 FROM activity a WHERE a.lead_id = l.id AND a.account_id IN (SELECT id FROM accounts)
                  AND (a.type IN ('connect', 'accepted', 'message') OR (a.type = 'view_profile' AND a.status = 'ok')));
```

**Server**

- `services/rotation.ts`:
  - `setCampaignAccounts(ctx, campaignId, accountIds)`: replaces rows in a tx, keeps `campaigns.account_id = accountIds[0] ?? null`
    (old readers and the legacy JSON field keep working), releases unstarted leads pinned to removed accounts.
  - `campaignAccountIds(ctx, campaignId)`.
  - `connectionWith(ctx, lead, accountId, legacyAccountId?)`: `lead_connections` row status, else (legacy: lead has no
    rows at all) `lead.connection_status`, else `'none'`. Deviation (review): inside a campaign the engine passes
    `campaigns.account_id` as `legacyAccountId` and the legacy aggregate counts only for that first sender, so a second
    sender doesn't skip its own invite; `chooseSender` and the `is_connected`/`accepted_within` conditions pin a legacy
    lead to that first sender. Sync (no campaign) keeps crediting any account.
  - `retireAccount(ctx, accountId)` (before an account is deleted) also deletes its `lead_connections` rows and calls
    `refreshConnectionStatus(lead, 'none')`, so a lead known only to the deleted account is not left "connected" with no rows.
  - `chooseSender(ctx, campaign, lead, actionType, capacity)`: (1) if the lead has a `lead_connections` row (connected
    first, then pending, newest first) with an account in the campaign, return it even if busy; (2) among campaign
    accounts that are `active`, inside working hours and not exhausted for `actionType`, pick the highest
    `remaining(type) − waiting(type)` where `waiting` = active campaign leads pinned to that account with
    `contacted_at IS NULL` and `node_type = type` (all campaigns); tie → fewer active pinned leads → lower id. `capacity`
    is a per-tick cache `Map<accountId, { limits, used }>` so a tick does not recompute usage per lead.
  - `releaseUnstartedLeads(ctx, accountId, campaignId?)`: `UPDATE campaign_leads SET account_id = NULL WHERE account_id = ? AND state = 'active' AND contacted_at IS NULL`.
    Because a pause/sender change/session check can release a lead while its account's action is still running, the
    engine leases the row before the driver call (`next_run_at = now + 10 min WHERE account_id = a`, abort if 0 rows) and
    writes `account_id = a` together with `contacted_at`, so no second sender acts meanwhile and the contact stays pinned.
- `engine/sync.ts → markConnected(ctx, a, lead)`: upsert `lead_connections(lead, a, 'connected')`; keep updating
  `leads.connection_status`. Engine `connect` success upserts `(lead, account, 'pending')`; `withdraw_invite` deletes it.
  `syncAccount` today skips a person when `lead.connection_status === 'connected'`; with several accounts that would
  never record "B is connected too", so it must skip only when `lead_connections` already says connected **for this
  account**. `enrichLead` seeing `degree === 1` upserts the row for the account that viewed the profile.
- `refreshConnectionStatus(ctx, leadId)`: `leads.connection_status` becomes the aggregate (connected if any row is
  connected, else pending if any pending, else `none`, else unchanged for legacy leads without rows). Engine outcomes
  that today write `connection_status` directly (`connect`, `message`, `withdraw_invite`) write the per-account row and
  call this, so withdrawing A's invite cannot mark a lead connected through B as `none`. The `connect` and
  `withdraw_invite` "already connected" checks use `connectionWith(lead, account)`.
- `engine/engine.ts`:
  - `advanceFreeSteps()` becomes global (called once per tick before accounts):
    ```sql
    ... WHERE c.status = 'active' AND cl.state = 'active' AND cl.next_run_at <= $now AND (cl.node_type IN (<FREE_NODE_TYPES>) OR cl.node_type IS NULL)
      AND ( (cl.account_id IS NOT NULL AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = cl.account_id AND a.status = 'active'))
         OR (cl.account_id IS NULL AND EXISTS (SELECT 1 FROM campaign_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.campaign_id = c.id AND a.status = 'active'))
         OR NOT EXISTS (SELECT 1 FROM campaign_accounts ca WHERE ca.campaign_id = c.id) )   -- channel-only campaigns (g3+)
    ```
    This keeps today's rule: a paused/needs-login account freezes its leads' waits and conditions (so an
    "accepted within" deadline cannot pass while sync is not running).
  - `dueJobs(a, ...)` selects `cl.account_id = $acc OR (cl.account_id IS NULL AND EXISTS (campaign_accounts for $acc))`,
    pinned first (`ORDER BY CASE WHEN cl.account_id IS NULL THEN 1 ELSE 0 END, cl.next_run_at, cl.id`), up to 20 rows.
  - `nextActionJob(a)`: for each candidate: pinned to `a` → take; unassigned → `chooseSender`; if it returns `a`, pin
    (`account_id = a.id`) and take; if it returns another account, pin to that account and continue (that account's loop
    picks it up); never act for another account.
  - Conditions `is_connected` / `accepted_within` use `connectionWith(lead, cl.account_id)`; an unpinned lead counts as
    connected if it is connected to any campaign account, and is pinned to that account.
  - On first `ok` action of a type in `CONTACT_ACTIVITY_TYPES`, set `contacted_at`.
  - `guarded()` (needs_login) and the pause route call `releaseUnstartedLeads`. Account deletion: before delete,
    contacted leads pinned to it finish as `skipped` with `last_error = 'Sender account was removed'`; unstarted ones
    are released (the FK sets `NULL` anyway). Campaigns left with no accounts are paused; the others get
    `campaigns.account_id` reset to their first remaining sender (today's route pauses every campaign whose
    `account_id` matches, which would wrongly pause multi-sender campaigns).
  - Removing an account from a campaign (not deleting it) releases its unstarted leads; its contacted leads stay pinned
    and keep running from that account, since the same person keeps hearing from the same sender (documented in the UI hint).
- `routes/campaigns.ts`: create/patch accept `accountIds: number[]` (max 20, validated in workspace); `accountId`
  stays accepted and maps to `[accountId]`. Adding/removing senders is allowed while active. `start` needs ≥ 1 account
  (g3 relaxes to "≥ 1 sender of any channel"). `duplicate` copies `campaign_accounts`. Serialized campaign adds
  `accounts: [{ id, name, status }]`, `accountIds`, keeps `account`/`accountId` (first sender).
  `campaignStats` adds `bySender: [{ accountId, name, status, leads, invited, accepted, messaged, replied, acceptanceRate, replyRate }]`
  (from `activity.account_id` and pinned counts). Campaign leads list adds `sender: { id, name } | null`.
- `seed.ts` and `test/helpers.ts → makeCampaign` call `setCampaignAccounts`. `makeWorld` gains `addAccount(w, overrides)`.
- Webhook payloads for `action.performed`, `lead.connected`, `lead.replied` add `account: { id, name }`.

**Web**: campaign settings tab: `CheckList` of accounts ("Send from"), with a hint that leads stay with the account
that first contacted them. New-campaign modal uses the same list. Header shows "Runs from A, B +1". Leads tab gets a
"Sender" column. Results tab: per-sender table.

**Tests** (`test/rotation.test.ts`): two simulator accounts with `connect` limit 3 and 12 leads → after a working day
each account sent ≤ 3 invites and both sent some; a lead's follow-up message comes from the account that invited it;
a lead already connected to account B is pinned to B; B's sync records its own connection to a lead A already
connected; withdrawing A's invite keeps the lead `connected` through B; deleting one of two senders keeps the campaign
active; account A going `needs_login` releases A's unstarted leads to B
while A's contacted leads stay pinned and active; removing an account from a campaign releases unstarted leads;
member can PATCH `accountIds`, foreign account id → 404; legacy `accountId` still works; existing engine/API tests pass.

### 4.3 g1-abtest: message variants

**Migration M3**

```sql
ALTER TABLE activity ADD COLUMN node_id TEXT;
ALTER TABLE activity ADD COLUMN variant TEXT;
CREATE INDEX activity_campaign_node ON activity(campaign_id, node_id, variant);
CREATE TABLE campaign_lead_variants (
  campaign_lead_id INTEGER NOT NULL REFERENCES campaign_leads(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_lead_id, node_id)
);
CREATE TABLE campaign_node_winners (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  decided_by TEXT NOT NULL,                        -- auto | user
  decided_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, node_id)
);
```

**Sequence schema** (`engine/sequence.ts`): `connect`, `message`, `email` (and later `inmail`, `sms`) nodes get optional
`variants` (2–5 items, ids `A`–`E`, unique) and optional `abtest: { autoPickAfter: number | null (20–10000), metric: 'accepted' | 'replied' }`
(default metric: `accepted` for connect, `replied` otherwise). Variant shapes: connect `{ id, note }`; message/sms
`{ id, text }`; email/inmail `{ id, subject, body }`. The single-text fields stay required/valid; when `variants`
is present the builder also writes variant A into the single-text fields so old readers still work, and the engine
uses `variants`. Helper `nodeVariants(node)` returns `[{ id: 'A', ...singleFields }]` for plain nodes. Winners are
stored in `campaign_node_winners`, not in the sequence JSON (so the builder's draft never overwrites them).
`validateSequence` checks variant ids/count/content; `sequenceWarnings` checks each variant.

**Server**: `engine/variants.ts`:
- `assignVariant(ctx, campaign, cl, node)`: existing row → it; else winner (if any) → it; else index =
  first 4 bytes of `sha256(campaignId:nodeId:leadId)` mod n. Insert row. Plain nodes return `null` (no row, activity
  `variant` stays NULL). If the stored (or winning) variant was removed from the node by an edit, assign again among
  the current variants and update the row; if the node lost all its variants, use the single-text fields.
- `variantStats(rows, metric)` (pure): per variant `sent`, `accepted`, `replied`, `rate`; `leader`; `significant` when
  each variant has ≥ 20 sends and a two-proportion z-test of leader vs runner-up gives z ≥ 1.96.
  Sent = distinct leads with `ok` activity of the node's type for (campaign, node, variant). Accepted = of those, leads
  whose `lead_connections` row for the sending account (or `leads.connected_at`) is connected at or after the send.
  Replied = leads with a `replied` activity after the send.
- `maybePickWinner(ctx, campaign, node)`: when `autoPickAfter` is set, no decision is stored and total sends ≥ N, store
  the strict leader (none on a tie, while a variant is unsent, or while the leader has 0 results) with `decided_by = 'auto'`, log activity `ab_winner` (detail
  `"Node n3: variant B"`). Called before each new assignment.
- Engine passes the variant's content into `perform()`; `logActivity` accepts `nodeId` and `variant` (all engine
  actions now log `node_id`).

**Routes**: `GET /api/campaigns/:id/variants` (any) → `{ nodes: [{ nodeId, nodeType, metric, autoPickAfter, winner, decidedBy, variants: [{ id, sent, accepted, replied, rate, leader, significant }] }] }`;
`POST /api/campaigns/:id/nodes/:nodeId/winner` (writer) `{ variant: 'A'..'E' | null }` (null splits leads again and is
stored as a NULL-variant row, which keeps auto-pick off until the step's auto-pick setting changes). Template preview is called per variant as today.

**Web**: NodeEditor gets "Add A/B variant" (turns the text into variants A and B), variant tabs A–E with remove,
`TemplateField` + live preview per variant, and the auto-pick setting. Node summary shows "A/B: 3 variants". Results
tab: "A/B tests" card per node with rates, sends, a `Pill` "Winner"/"Leading", and "Use this variant" button.

**Tests** (`test/abtest.test.ts`): same lead/node always gets the same variant; 200 leads split roughly evenly
(each variant 30–70% for 2 variants); stats math on fixed rows (including z-test edge cases: zero sends, ties);
auto-pick after N sends sends all later leads the winner while earlier assignments keep theirs; manual winner route;
old sequences without `variants` validate and run with `variant` NULL; schema rejects 1 or 6 variants and duplicate ids.

### 4.4 g1-sources: post/event/group imports, InMail, Sales Navigator messages

**Migration M4**

```sql
ALTER TABLE imports ADD COLUMN kind TEXT NOT NULL DEFAULT 'search';   -- search | post | event | group
ALTER TABLE imports ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
ALTER TABLE imports ADD COLUMN job_id INTEGER;
ALTER TABLE imports ADD COLUMN day TEXT;                               -- account-local day, for the scrape budget
ALTER TABLE imports ADD COLUMN duplicates INTEGER NOT NULL DEFAULT 0;
ALTER TABLE imports ADD COLUMN blacklisted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE imports ADD COLUMN note TEXT;
ALTER TABLE imports ADD COLUMN finished_at INTEGER;
CREATE INDEX imports_account_day ON imports(account_id, day);
ALTER TABLE leads ADD COLUMN open_profile INTEGER;                     -- NULL unknown, 0/1 from view_profile
```

**Driver interface** (`drivers/types.ts`):

```ts
postEngagers(postUrl: string, which: { likers: boolean; commenters: boolean }, limit: number, onPage?: (found: number) => void): Promise<Person[]>;
eventAttendees(eventUrl: string, limit: number, onPage?: (found: number) => void): Promise<Person[]>;
groupMembers(groupUrl: string, limit: number, onPage?: (found: number) => void): Promise<Person[]>;
sendInMail(profileUrl: string, msg: { subject: string; body: string; via: 'profile' | 'sales_navigator' }): Promise<void>;
// Person gains `openProfile?: boolean` (filled by viewProfile when visible).
```

InMail errors: `NOT_AVAILABLE` ("No InMail credits and the profile is not open"), `LIMIT_REACHED` when LinkedIn says
credits are exhausted (→ 24 h cool-down like invites). Sales Navigator messaging is the same method with
`via: 'sales_navigator'` (it opens the lead in Sales Navigator); it is not a separate node.

- Simulator: deterministic people from `hash(url)` (same slug format as `search`); post engagers split likers/commenters
  by hash; `openProfile` = hash % 3 == 0; InMail credits `simOptions.inmailCredits` (default 50) per 30 days counted
  from the account's `ok` inmail activity; open profiles are free; InMail can schedule a reply like `sendMessage`.
- Playwright: best-effort flows (reactions dialog list, comments list, `/events/<id>/attendees`, `/groups/<id>/members`,
  InMail compose with subject field; Sales Navigator compose). All selectors/labels in `selectors.ts`; mock pages and
  tests added to the fixture.

**Limits** (`engine/limits.ts`): `DEFAULT_LIMITS.inmail = 10` (in `ACTION_TYPES`, so warm-up and cool-downs apply);
`DEFAULT_LIMITS.scrape = 1000` (profiles per day, a non-action key in `Limits`; warm-up applies). Usage for `scrape` =
`SUM(found)` of today's `imports` rows for the account (`day` column).

**Imports on the job queue** (`services/imports.ts`, job `leads.import` `{ importId }`, dedupe `leads.import:<id>`):
the handler (registered with `timeoutMs` 60 min; `onPage` calls `progress()`, which keeps the lock alive) loads the
import (workspace check), requires the account `active`, in working hours (else `RetryLater(nextWorkingTime − now)`)
and past its `next_action_at` (else `RetryLater` until then, so a scrape never lands right after an action), clamps
`limit` to the remaining `scrape` budget (if 0, `RetryLater` until the
next working day), calls the driver through `ctx.drivers.use`, updates `found` via `onPage`, imports with dedupe and
`skipBlacklisted` (and suppressed) counting `duplicates`/`blacklisted`, sets `note` when clamped ("Stopped at this
account's daily limit of N profiles. Run the import again tomorrow for more."), and pushes the account's
`next_action_at` by a random delay. `POST /api/leads/import/search` keeps its request/response but now enqueues
this job (note in README: imports run where the worker runs).

**Sequence**: action node `inmail { subject (≤ 200), body (≤ 1900), via, variants? }`; condition kind
`is_open_profile` (yes when `leads.open_profile = 1`; validation warns if no `view_profile` precedes it). Engine
`perform` case `inmail` renders subject/body (variant aware), records the outbound message in the inbox, sets `contacted_at`.
`CONTACT_ACTIVITY_TYPES` adds `inmail`.

**Routes**: `POST /api/leads/import/linkedin` (writer) `{ listId, accountId, source: 'search'|'post'|'event'|'group', url, limit (1–1000), likers?, commenters? }` → `{ importId }`,
URL checks per source (`/search/` or `/sales/`, `/posts/` or `/feed/update/`, `/events/`, `/groups/<id>`).
`GET /api/imports` adds `kind, duplicates, blacklisted, note, finishedAt, progress`.

**Web**: Import modal: tabs CSV | From LinkedIn | Single profile; "From LinkedIn" has a source select (search, post
likers/commenters with two checkboxes, event attendees, group members), account select, limit, and the progress list.
Builder palette: "Send InMail" (note: needs Premium/Sales Navigator credits or an open profile) and "If open profile".

**Tests** (`test/sources.test.ts`): each source imports deterministic people through the job queue; second run of the
same post adds 0 and counts duplicates; blacklisted/suppressed people are skipped and counted; scrape budget clamps
and sets the note; outside working hours the job waits; InMail through the engine respects the daily limit (limit 2
→ 2 per day), warm-up factor applies, no-credit non-open profile → skipped with reason; `is_open_profile` branching;
member/foreign-workspace checks on the new route. Playwright mock tests for the four new methods (skipped without a browser).

### 4.5 g2-ai-writer: AI provider, writer, personalization variables

Load the `claude-api` skill before writing the Anthropic provider, and use the official `@anthropic-ai/sdk`.

**Migration M5**

```sql
CREATE TABLE campaign_lead_ai (
  campaign_lead_id INTEGER NOT NULL REFERENCES campaign_leads(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  instruction_hash TEXT NOT NULL,                  -- regenerate when the instruction changes
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | ready | failed
  value TEXT,
  error TEXT,
  simulated INTEGER NOT NULL DEFAULT 0,
  requested_at INTEGER NOT NULL,
  generated_at INTEGER,
  PRIMARY KEY (campaign_lead_id, name)
);
```

**Provider kind `ai`** (`providers/ai/types.ts`):

```ts
export interface AiRequest { purpose: 'write' | 'personalize' | 'classify' | 'reply'; system: string; prompt: string; maxTokens: number; temperature?: number; tier: 'writer' | 'classifier' }
export interface AiResult { text: string; model: string; inputTokens: number; outputTokens: number }
export interface AiProvider extends BaseProvider { complete(req: AiRequest): Promise<AiResult> }
```

- `anthropic`: credentials `{ apiKey }`; settings `{ writerModel = 'claude-sonnet-5-5', classifierModel = 'claude-haiku-5-5' }`.
  Client constructed with `fetch: ctx.fetch` so tests use fakes. `test()` makes a 1-token request (or the SDK's
  models list call) to the classifier model.
- `openai_compat`: credentials `{ apiKey }`; settings `{ baseUrl, writerModel, classifierModel }`; `POST {baseUrl}/chat/completions` via `httpJson`
  (`baseUrl` rules in 2.3: user-supplied hosts).
- `simulated`: deterministic templated text from the prompt's lead data (hash-seeded), with plausible token counts.
- Every call records `usage_events` (`kind 'ai'`, operation `ai.<purpose>`, tokens).

**Server**
- `ai/prompts.ts`: prompt builders. Lead/profile data goes in a clearly delimited data block with an instruction to
  treat it as data, not instructions (prompt-injection guard). Outputs requested as JSON where structured; parsed with
  zod; on parse failure, one retry, then `ProviderError('BAD_REQUEST')`.
- `ai/writer.ts → writeDrafts(ctx, ws, { nodeType, brief, variants, lead? })`: returns drafts using our template
  variables (`{{firstName}}`, `{{company|...}}`); connect notes clamped to the campaign `noteLimit`/300, InMail
  subject ≤ 200, SMS ≤ 320. Never sends.
- Personalization variables: campaign settings gain `aiVariables: [{ name (/^[a-z][a-zA-Z0-9_]{0,30}$/), instruction (≤ 1000), fallback (≤ 300, may be ''), maxChars (20–500, default 250) }]` (max 10).
  Templates use `{{ai:name}}` (and the usual inline fallback `{{ai:name|...}}`). `engine/template.ts`: the variable
  regex accepts an optional `ai:` prefix; `unknownVariables` accepts a list of known AI names.
- `ai/personalize.ts`:
  - `aiNamesIn(templates)`; `prefetch(ctx, campaign, cl, node)` called from `moveTo` when the lead enters an action node
    whose chosen variant uses AI variables: inserts `pending` rows and enqueues `ai.personalize { campaignLeadId }`
    (dedupe `ai.personalize:cl:<id>`).
  - Job handler: loads campaign lead + lead + campaign (workspace check), generates each missing/stale name
    (`tier: 'writer'`), trims to `maxChars` at a word boundary and strips newlines/braces, stores `ready` with
    `simulated` flag. Retryable provider errors rethrow (job retries, max 3); final failure stores `failed` with the
    error, logs activity `ai_personalize` `failed`, sets `campaign_leads.last_error = 'AI: ...'`, and wakes the lead
    (`next_run_at = now`).
  - `resolveAiVars(ctx, campaign, cl, names, realChannel)`: all `ready` → values; any `pending` younger than
    `AI_WAIT_MAX_MIN` → `{ wait: until }` (engine sets `next_run_at = now + 2 min`, returns without acting and without
    delaying the account, and the account loop tries its next candidate in the same tick so a slow AI provider does not
    idle the sender); otherwise fallback values for missing/failed ones. If `realChannel` and the value is
    `simulated`, use the fallback and log activity `ai_personalize` `skipped` "Simulated AI text is not sent to real people".
    `prefetch` only runs from `moveTo`, which never fires for the **start node** (`addLeadsToCampaign` places leads
    there directly) or for leads already standing on a node when a variable is added. So `resolveAiVars` itself calls
    `prefetch` when rows are missing or stale, and re-enqueues when rows are `pending` with no live job (2.4 dedupe).
    `realChannel` = LinkedIn account with the `playwright` driver, or a legacy SMTP send; g3 extends it to `smtp`
    mailboxes and g3-tasks-sms to Twilio.
- Rendering: AI values are inserted as variable values (already brace-safe in `render()`); the final connect note is
  clamped by `clampNote` as today; message/inmail/email lengths validated after rendering (too long → trimmed with an
  activity note).

**Routes** (`routes/ai.ts`)

| Method | Path | Role | Shape |
|---|---|---|---|
| POST | `/api/ai/write` | writer | `{ nodeType: 'connect'\|'message'\|'inmail'\|'email'\|'sms', brief: { offer, audience?, tone: 'friendly'\|'professional'\|'direct'\|'casual', length: 'short'\|'medium'\|'long', language = 'English', cta? }, variants: 1–5, leadId?, campaignId? }` → `{ drafts: [{ text? , note?, subject?, body? }], simulated, warnings }` (30 calls/min/workspace) |
| POST | `/api/campaigns/:id/ai/preview` | writer | `{ leadId, names?: string[] }` → `{ values: { [name]: string }, simulated, errors }` (not cached) |
| POST | `/api/templates/preview` | any | adds optional `campaignId` and `aiValues` so `{{ai:x}}` renders and isn't flagged unknown |

**Web**: builder: "Write with AI" button on connect/message/inmail/email nodes → modal with brief fields, variant
count, "Insert" per draft (fills the field or creates variants), `ProviderBadge` when simulated. Campaign settings:
"AI variables" editor (name, instruction, fallback, max length) with "Preview on lead" (lead picker → values).
Variable chips in `TemplateField` include `ai:` names. Integrations tab shows the AI kind.

**Tests** (`test/ai-writer.test.ts`): simulated generation through the queue fills `{{ai:icebreaker}}` in a sent
message, including when the AI step is the sequence's first node; second step reuses the cache (one job only);
instruction change regenerates; provider failure → fallback
used, activity failed, `last_error` set, campaign continues; pending beyond `AI_WAIT_MAX_MIN` → fallback; simulated
value on a real (`playwright`) account → fallback (use a fake driver factory); note clamped to limit; write route
returns N drafts, validates input, members are allowed (client denial is tested in g5-agency); Anthropic and
OpenAI-compatible providers against `fakeFetch` (request shape, auth header, error mapping 401/429/500), keys masked.

### 4.6 g2-ai-replies: classification, suppression, suggested replies

**Migration M6**

```sql
ALTER TABLE messages ADD COLUMN category TEXT;
ALTER TABLE messages ADD COLUMN confidence REAL;
ALTER TABLE conversations ADD COLUMN category TEXT;
ALTER TABLE conversations ADD COLUMN category_confidence REAL;
ALTER TABLE conversations ADD COLUMN category_source TEXT;    -- ai | manual
ALTER TABLE conversations ADD COLUMN classified_at INTEGER;
CREATE INDEX conversations_category ON conversations(workspace_id, category);
ALTER TABLE leads ADD COLUMN reply_category TEXT;
ALTER TABLE leads ADD COLUMN reply_category_at INTEGER;
ALTER TABLE campaign_leads ADD COLUMN hold_reason TEXT;       -- reply | task | enrich (see 2.10)
```

**Categories** (`ai/categories.ts`): `interested, meeting_booked, question, not_now, not_interested, out_of_office,
wrong_person, unsubscribe, other`, with labels, pill tones and `SUGGESTED_STAGE` (`interested → interested`,
`meeting_booked → meeting`, `not_interested → lost`, others none). `SUPPRESS_CATEGORIES = ['unsubscribe', 'not_interested']`,
`SUPPRESS_MIN_CONFIDENCE = { unsubscribe: 0.5, not_interested: 0.7 }` (deviation: an explicit opt-out is final even when
polite, e.g. "stop messaging me, but thanks"; only "not interested" is often conditional and needs 0.7).

**Server**
- `services/replies.ts` (refactor of `storeThread`'s reply handling): `handleInboundReply()`, `stopCampaignLead()`,
  `stopLeadEverywhere()` as in 2.10. LinkedIn `storeThread` calls `handleInboundReply` for each conversation with new
  inbound messages (passing the newest inbound message id). Foundation's `suppressLead` switches to `stopLeadEverywhere`.
- This is the first step that suppresses people automatically, and a classifier can be wrong, so it adds the way to
  see and undo it: `GET /api/suppressions` (any; `?q&kind&page`), `POST /api/suppressions` (writer;
  `{ kind, value }`, reason `manual`), `DELETE /api/suppressions/:id` (admin; deleting a row does not restart stopped
  campaign leads). UI: a "Do not contact" section in Settings → Blacklist.
- Campaign setting `continueOnCategories: Category[]` (default `[]`). On an inbound reply for an active campaign lead:
  - `stopOnReply` on and `continueOnCategories` empty → stop as `replied` immediately (exactly today's behaviour).
  - `stopOnReply` on and `continueOnCategories` non-empty → hold: `hold_reason = 'reply'`, `next_run_at = now + REPLY_HOLD_MIN`.
    When classification lands: category in the list → clear hold, `next_run_at = now` (the sequence continues and can
    branch with `reply_sentiment`); otherwise stop as `replied`. If the hold deadline passes unclassified → stop as `replied`.
  - `stopOnReply` off → continue as today; conditions waiting are woken.
  - `runAction`'s `stopOnReply && lead.replied_at` check becomes `replyDecision(ctx, campaign, cl, lead)` (`none | continue | stop | pending`),
    using the latest classified reply after the lead was added to the campaign.
  Document these rules in the README.
- Job `ai.classify { messageId }` (dedupe `ai.classify:msg:<id>`): loads message + conversation (workspace check) and
  the last 10 messages, calls `tier: 'classifier'` with a JSON answer `{ category, confidence }` (zod; invalid → `other`, 0).
  Simulated provider = keyword heuristics (out-of-office/auto-reply, unsubscribe/remove me/stop, not interested/no
  thanks, booked/confirmed/see you on, calendar/call/let's talk/schedule, next quarter/not now/later, wrong
  person/no longer at, `?` → question, else other; confidence 0.9 for unambiguous phrases, 0.6 for `?`, 0.5 for
  `other`, and below 0.7 for unsubscribe/not-interested phrases that are negated or qualified, such as "not interested
  in X but..."). Stores on message, conversation (`category_source 'ai'`) and lead;
  logs activity `classified`; emits `lead.classified`; applies suppression when the category is in
  `SUPPRESS_CATEGORIES` and confidence ≥ its `SUPPRESS_MIN_CONFIDENCE` (`suppressLead`, reason = category), only for the
  lead's latest reply (or a category set by hand), so a late answer about an older message can't suppress; resolves `reply` holds.
- Condition kind `reply_sentiment { categories: Category[] (≥ 1) }`: yes when the lead's latest classified reply since
  joining the campaign is in the list; replied but unclassified → wait (`next_run_at = now + 2 min`) up to
  `REPLY_HOLD_MIN`, then treat as `other`; no reply → no. Validation warns when used with `stopOnReply` on and
  `continueOnCategories` empty (branch can never see a reply).
- Suggested replies: `ai/replies.ts → suggestReplies(ctx, ws, conversationId, { count: 1–3, instruction? })` using the
  thread, lead profile and campaign name; never sends.

**Routes**

| Method | Path | Role | Shape |
|---|---|---|---|
| GET | `/api/inbox` | any | adds `?category=` filter; items add `category, categoryConfidence, channel` |
| GET | `/api/inbox/:id` | any | adds `category`, `suggestedStage`, messages add `category` |
| POST | `/api/inbox/:id/suggest` | writer | `{ count?: 1–3, instruction?: string }` → `{ suggestions: string[], simulated }` |
| PATCH | `/api/inbox/:id/category` | writer | `{ category }` → manual override (confidence 1, `category_source 'manual'`; suppression rules apply) |

**Web**: inbox list category `Pill`s and a category filter select; thread header shows category with an override
select and "Suggested stage: …" hint (g5-pipeline turns it into the real stage control); "Suggest reply" button
fills the reply box with a chosen suggestion (editable; sent only on Send). Builder: condition "If reply is…" with
category checkboxes; campaign settings: "Keep going after these replies" multi-select with a short explanation.

**Tests** (`test/ai-replies.test.ts`): a simulated "Not interested, thanks." reply is classified `not_interested`,
the lead is suppressed and its leads in other campaigns stop; `lead.classified` emitted (register a hook with
`deliver = false`); default `stopOnReply` behaviour unchanged (existing tests); out-of-office flow: simulator
`replies` option (new `SimulatorOptions.replies?: string[]`, default = current list, so existing tests see the same
texts) returns an OOO text, `continueOnCategories: ['out_of_office']`, sequence `reply_sentiment(out_of_office) → wait 2 days → message`
sends the follow-up after the wait; unclassified hold times out → `replied`; low-confidence unsubscribe does not
suppress; suggest route returns 1–3 strings and never writes messages; category filter and manual override;
suppressions list/add/delete with roles; isolation.

### 4.7 g3-mailboxes: mailboxes, warm-up, deliverability, reply detection

**Migration M7**

```sql
CREATE TABLE mailboxes (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'smtp',           -- smtp | simulated
  preset TEXT NOT NULL DEFAULT 'custom',           -- gmail | outlook | custom (fills host/port in the UI)
  from_name TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL DEFAULT '',
  reply_to TEXT,
  signature TEXT NOT NULL DEFAULT '',
  smtp_enc TEXT,                                   -- sealed { host, port, secure, user, pass }
  imap_enc TEXT,                                   -- sealed { host, port, secure, user, pass }
  status TEXT NOT NULL DEFAULT 'active',           -- active | paused | needs_attention
  status_message TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  work_days TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
  work_start TEXT NOT NULL DEFAULT '08:00',
  work_end TEXT NOT NULL DEFAULT '18:00',
  daily_limit INTEGER NOT NULL DEFAULT 40,
  warmup INTEGER NOT NULL DEFAULT 1,
  warmup_days INTEGER NOT NULL DEFAULT 14,
  warmup_start INTEGER NOT NULL DEFAULT 5,
  gap_min_sec INTEGER NOT NULL DEFAULT 120,
  gap_max_sec INTEGER NOT NULL DEFAULT 420,
  next_send_at INTEGER NOT NULL DEFAULT 0,
  imap_uid_validity TEXT,
  imap_last_uid INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER NOT NULL DEFAULT 0,
  legacy_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX mailboxes_legacy ON mailboxes(legacy_account_id) WHERE legacy_account_id IS NOT NULL;

CREATE TABLE campaign_mailboxes (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, mailbox_id)
);
ALTER TABLE campaign_leads ADD COLUMN mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL;
CREATE INDEX campaign_leads_mailbox ON campaign_leads(mailbox_id, state, next_run_at);

CREATE TABLE email_messages (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  node_id TEXT,
  variant TEXT,
  direction TEXT NOT NULL,                         -- out | in
  message_id TEXT NOT NULL,
  in_reply_to TEXT,
  refs TEXT,                                       -- References header, space-separated
  subject TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL DEFAULT '',
  to_email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,                            -- sent | simulated | failed | bounced | received
  error TEXT,
  tracking_token TEXT,
  open_count INTEGER NOT NULL DEFAULT 0,
  opened_at INTEGER,
  click_count INTEGER NOT NULL DEFAULT 0,
  clicked_at INTEGER,
  sent_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX email_messages_message_id ON email_messages(mailbox_id, message_id);
CREATE UNIQUE INDEX email_messages_tracking ON email_messages(tracking_token) WHERE tracking_token IS NOT NULL;
CREATE INDEX email_messages_lead ON email_messages(lead_id, sent_at);
CREATE INDEX email_messages_day ON email_messages(mailbox_id, direction, sent_at);

ALTER TABLE conversations ADD COLUMN mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE CASCADE;
ALTER TABLE conversations ADD COLUMN participant_address TEXT;
ALTER TABLE conversations ADD COLUMN subject TEXT;
CREATE UNIQUE INDEX conversations_mailbox_thread ON conversations(mailbox_id, thread_id) WHERE mailbox_id IS NOT NULL;

ALTER TABLE leads ADD COLUMN email_status TEXT;          -- valid | risky | invalid | unknown (g4 reuses)
ALTER TABLE leads ADD COLUMN email_status_reason TEXT;
ALTER TABLE leads ADD COLUMN email_status_at INTEGER;
ALTER TABLE activity ADD COLUMN mailbox_id INTEGER;
CREATE INDEX activity_mailbox_day ON activity(mailbox_id, day, type);
```

**Server**
- `mail/mailboxes.ts`: CRUD helpers, `serializeMailbox` (masked passwords, `hasSmtp`, `hasImap`, effective limit,
  sent today, next send), presets: Gmail `smtp.gmail.com:465 secure` / `imap.gmail.com:993`; Outlook/Microsoft 365
  `smtp.office365.com:587 STARTTLS` / `outlook.office365.com:993`; both need app passwords (README: OAuth is not
  included; some Microsoft 365 tenants disable SMTP AUTH). `effectiveDailyLimit(mb, now)` =
  `warmup ? min(daily_limit, warmup_start + floor(days × (daily_limit − warmup_start) / warmup_days)) : daily_limit`.
  `ensureLegacyMailboxes(ctx)` (called in `buildContext`): for each account with `smtp_enc` and no mailbox with that
  `legacy_account_id`, decrypt, create a mailbox (`from_email` = `from || user`), and link it to campaigns using that
  account that have an email node. Idempotent (`ON CONFLICT DO NOTHING` on `mailboxes_legacy`). Linking moves those
  campaigns from the account loop to the mail runner, so the migrated mailbox must keep today's behaviour: `warmup = 0`,
  `daily_limit` = the account's configured `email` limit (default 60), timezone, work days and hours copied from the
  account, gaps = the account's action delays. Otherwise existing users would drop to a 5-a-day warm-up overnight.
- `services/email.ts`: `Mailer.send(transport: SmtpConfig | null, msg: OutgoingEmail) → { status: 'sent' | 'simulated', messageId }`
  with `OutgoingEmail { from, to, subject, text, html?, headers?, messageId, inReplyTo?, references? }`, plus
  `Mailer.verify(transport) → { ok, message }` for the test route (so tests never open SMTP connections). The legacy
  engine path adapts to it (existing dry-run text unchanged).
- Mailbox daily usage has one source: `ok` activity rows of type `email` with that `mailbox_id` and `day` = today in
  the mailbox's timezone (inbox replies sent through the mailbox log the same row with `campaign_id` NULL). This
  matches how LinkedIn limits are counted. The `email_messages_day` index is not needed for it.
- Real mailboxes never send to reserved test domains (`.example`, `.test`, `.invalid`, `.localhost`, RFC 2606). This is
  how "simulated addresses never reach a real mailbox" works in this step: the simulator already produces
  `@<company>.example` emails, and `leads.email_source` only arrives in g4-data, which adds its `simulated` check on top.
- `mail/compose.ts`: builds Message-ID `<random@from-domain>`, threading (`replyInThread` → `In-Reply-To` = previous
  outbound in this campaign/mailbox, `References` chain, subject `Re: <first subject>`), text + minimal escaped HTML,
  signature, unsubscribe footer, `List-Unsubscribe: <PUBLIC_URL/u/TOKEN>, <mailto:from?subject=unsubscribe>` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, optional open pixel and click-tracked links.
  Unsubscribe/tracking tokens are HMAC-signed payloads (`workspaceId, leadId, emailMessageId`) under a key derived from
  `APP_SECRET`; no lookup needed to verify. Real mailboxes without `PUBLIC_URL` go `needs_attention`
  ("Set PUBLIC_URL so emails can carry an unsubscribe link"), except mailboxes migrated from an account's SMTP
  settings (`legacy_account_id`): they sent without it before, so they keep doing so with a mailto-only
  `List-Unsubscribe` (otherwise an upgrade without `PUBLIC_URL` would silently stop those campaigns' email steps).
- `mail/runner.ts → MailRunner.tick()`: for each `active` mailbox in working hours, past `next_send_at` and under its
  effective limit: pick one due campaign lead at an `email` node in a campaign linked to the mailbox (pinned to it, or
  unpinned → choose the linked mailbox with most remaining capacity, pin it; a lead with an earlier email thread stays
  with that mailbox), check email presence, `email_status != 'invalid'`, blacklist, suppression, no reserved test
  domain on real mailboxes, render (variants, AI vars), send, record `email_messages` + conversation (channel
  `email`) + activity `email` (`mailbox_id`, `account_id` NULL), set `next_send_at = now + randomDelay(gap)`, advance.
  SMTP auth errors → mailbox `needs_attention` + `mailbox.needs_attention`; transient → lead retry like LinkedIn
  `retry()`. The account loop skips email nodes of campaigns that have mailboxes; campaigns without mailboxes keep the
  legacy behaviour (existing dry-run test unchanged).
- Email node gains `replyInThread: boolean` (default false). Campaign settings gain `trackOpens: false`, `trackClicks: false`.
  `start` requires at least one LinkedIn account or mailbox, and refuses a sequence with LinkedIn action nodes but no
  LinkedIn account (those leads would never move); a campaign with email nodes and no mailbox shows a warning (legacy
  path: the account's dry run).
- `mail/imap.ts`: `ImapClient` interface `{ fetchSince(lastUid, uidValidity) → { uidValidity, lastUid, messages: InboundEmail[] } }`;
  default adapter with `imapflow` (INBOX only, envelope + `references` header + first `text/plain` part ≤ 20 KB, read
  with peek so `\Seen` flags are not changed, max 200 per sync). `ctx.imap` factory lets tests inject data.
  Simulated mailboxes generate replies from their own sent mail (hash-chosen 25 %, ≥ 2 h after sending) and bounce
  addresses whose local part contains `bounce`.
- `mail/inbound.ts → processInbound(ctx, mailbox, emails)`: match by `In-Reply-To`/`References` against our outbound
  `message_id`s, else by `from` = the email of a lead this mailbox has already emailed (other mail from people who
  happen to be leads is private and never imported, classified or sent to webhooks); unmatched mail is ignored (we do
  not import the user's mailbox). Bounces (`multipart/report` delivery-status or MAILER-DAEMON/postmaster sender) → original message
  `bounced`, lead `email_status = 'invalid'` (reason), activity `email_bounce`, `lead.email_bounced`, the lead's email
  steps skip. Auto-replies (`Auto-Submitted`, OOO subjects) are stored and go through classification like any reply.
  Replies → conversation (`channel 'email'`, `mailbox_id`, `thread_id` = root Message-ID, `participant_address`,
  `subject`) + message + `handleInboundReply`.
- Job `email.sync { mailboxId }` (dedupe `email.sync:<id>`), scheduled by the runner every `MAIL_SYNC_INTERVAL_MIN`.
- `mail/deliverability.ts → checkDomain(resolver, domain, { dkimSelector?, preset? })` → `{ domain, checks: [{ id: 'mx'|'spf'|'dkim'|'dmarc', status: 'pass'|'warn'|'fail', record?, message, fix? }] }`:
  MX present; exactly one `v=spf1` TXT (warn on multiple, `+all`, or missing the preset's include
  `_spf.google.com` / `spf.protection.outlook.com`); DKIM TXT at `<selector>._domainkey` with `p=` (try the given
  selector, else `google, selector1, selector2, default, k1, s1, dkim, mail`; none found → warn, not fail);
  `_dmarc` `v=DMARC1` (`p=none` → warn, quarantine/reject → pass, missing → fail). Resolver injected (`ctx.dns`).
- `routes/public.ts`: `GET /u/:token` (confirmation page, plain HTML, no tracking, **does not unsubscribe** because
  mail scanners prefetch links; its button POSTs the same URL) and `POST /u/:token` (RFC 8058 one-click, form-encoded
  body via foundation's parser) → `suppressLead` reason `unsubscribe`; tokens never expire; `GET /t/o/:token` (1×1 gif, increments opens, activity
  `email_open`); `GET /t/c/:token?u=<url>&s=<sig>` (signed URL, no open redirect; increments clicks, activity
  `email_click`, 302). These paths are outside `/api` and registered before the SPA fallback. Tracking is off by
  default and the settings UI explains what it records (privacy note).
- Inbox route: `LEFT JOIN accounts`, `LEFT JOIN mailboxes`; replying to an email conversation sends through its
  mailbox (threaded, immediately, counted in the mailbox's daily usage).

**Routes** (`routes/mailboxes.ts`)

| Method | Path | Role | Shape |
|---|---|---|---|
| GET | `/api/mailboxes` | writer | → `[mailbox]` (masked) |
| GET | `/api/mailboxes/presets` | any | → `[{ id, label, smtp, imap, help }]` |
| POST | `/api/mailboxes` | admin | `{ name, provider, preset?, fromName, fromEmail, replyTo?, signature?, smtp?, imap?, timezone, workDays, workStart, workEnd, dailyLimit (1–500), warmup, warmupDays (1–60), warmupStart, gapMinSec, gapMaxSec }` → mailbox |
| PATCH | `/api/mailboxes/:id` | admin | partial; blank passwords keep |
| DELETE | `/api/mailboxes/:id` | admin | unpins leads; contacted leads pinned to it finish `skipped` |
| POST | `/api/mailboxes/:id/test` | admin | SMTP `verify()` + IMAP login → `{ smtp: {ok,message}, imap: {ok,message} }` |
| POST | `/api/mailboxes/:id/pause` \| `/resume` | admin | |
| POST | `/api/mailboxes/:id/sync` | writer | enqueue sync → `{ jobId }` |
| POST | `/api/deliverability/check` | writer | `{ domain, dkimSelector? }` → check result |
| PATCH/POST | `/api/campaigns/:id` | writer | adds `mailboxIds: number[]` (same rules as `accountIds`) |

**Web**: `Mailboxes` page + nav entry (after LinkedIn accounts): cards with status, sent today/limit `Meter`, warm-up
progress, Test/Sync/Pause, deliverability panel per sending domain. Mailbox modal with preset picker, SMTP/IMAP
sections (`SecretField`), schedule, limits, warm-up. Accounts page: SMTP section replaced by a link to Mailboxes
(existing SMTP data was migrated). Campaign settings: mailbox `CheckList`, tracking toggles with privacy note. Email
node editor: "Reply in the same thread". Inbox: channel icon, subject, email replies.

**Tests** (`test/mailboxes.test.ts`): warm-up limit math; runner respects daily limit, window and gaps; rotation
across two mailboxes and pinning; headers (Message-ID, threading, List-Unsubscribe) from `compose`; unsubscribe GET and
one-click POST suppress the lead and stop other campaigns; bad token → 404; tracking off by default and click
redirects only to signed URLs; reply matching from fake IMAP data (by In-Reply-To, by References, by from-address,
unmatched ignored), reply stops the sequence and appears in the inbox; bounce marks the email invalid; legacy SMTP
account becomes a mailbox once, with no warm-up and the account's email limit and schedule; a real mailbox refuses
an `.example` address; two overlapping runner ticks send one email, not two; DNS checks with an injected resolver
(pass/warn/fail cases); passwords masked;
member 403 on mailbox mutations; isolation.

### 4.8 g3-tasks-sms: manual/call tasks, SMS and WhatsApp

**Migration M8**

```sql
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  campaign_lead_id INTEGER REFERENCES campaign_leads(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  node_id TEXT,
  kind TEXT NOT NULL,                              -- call | manual_linkedin | manual_email | custom
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',             -- open | done | skipped
  due_at INTEGER NOT NULL,
  auto_skip_at INTEGER,
  outcome TEXT,                                    -- connected | voicemail | no_answer | wrong_number | meeting_booked | not_interested | other
  notes TEXT,
  completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX tasks_due ON tasks(workspace_id, status, due_at);
CREATE INDEX tasks_assignee ON tasks(assignee_id, status, due_at);
CREATE UNIQUE INDEX tasks_step ON tasks(campaign_lead_id, node_id) WHERE campaign_lead_id IS NOT NULL;
CREATE UNIQUE INDEX conversations_phone_thread ON conversations(workspace_id, channel, thread_id) WHERE account_id IS NULL AND mailbox_id IS NULL;
-- Depends on conversations.mailbox_id from M7. If g3-mailboxes was rolled back, use `WHERE account_id IS NULL`.
```

**Sequence**: free node `task { kind, title (≤ 200), instructions (≤ 4000, template variables), dueAfterHours (0–720), assigneeId: number | null, autoSkipAfterDays: number | null (1–60) }`;
channel nodes `sms { text (≤ 1600), variants? }` and `whatsapp { text (≤ 1600), contentSid?: string, contentVariables?: Record<string, string> }`
(WhatsApp business-initiated messages outside a 24 h session need an approved template: `contentSid`; README says so).
`assigneeId` is validated against the workspace's users on save.

**Engine**
- `walk()` handles `task`: on entry creates the task (rendered instructions, `due_at = now + dueAfterHours`,
  `auto_skip_at`), emits `task.created`, sets `hold_reason = 'task'`, `next_run_at = auto_skip_at ?? now + 365 days`.
  When woken: task `done`/`skipped` → move to `next`; still open past `auto_skip_at` → task `skipped` (notes
  "Skipped automatically after N days") → move on; still open before that (a spurious wake-up, 2.10) → re-hold with the
  same deadline (the `tasks_step` unique index guarantees one task per lead and node). Leaving the campaign
  (`stopCampaignLead`) skips open tasks with a note. An `assigneeId` from the sequence that is no longer a workspace
  member creates the task unassigned.
- `messaging/runner.ts → MessagingRunner.tick()`: per workspace with due `sms`/`whatsapp` leads: provider =
  `ctx.providers.get(ws, 'sms')`; checks sending window and per-channel daily limit from the integration settings
  (simulated defaults: 100/day, 09:00–19:00 UTC), spacing 20–60 s per workspace, lead phone in E.164 (or normalized
  with `defaultCountryCode`; otherwise skipped "No phone number in international format"), suppression (phone
  identity included); sends; stores the message in a conversation (`channel 'sms'|'whatsapp'`,
  `thread_id = '<channel>:<E.164>'`, `participant_address`); activity `sms`/`whatsapp` (`account_id` NULL).
  `CONTACT_ACTIVITY_TYPES` adds `sms, whatsapp`.

**Provider kind `sms`** (`providers/sms/`): `SmsProvider { send({ channel: 'sms'|'whatsapp', to, body, contentSid?, contentVariables? }) → { externalId }; verifySignature(url, params, signature): boolean }`.
- `twilio`: credentials `{ accountSid, authToken }`; settings `{ fromNumber, whatsappFrom?, messagingServiceSid?, defaultCountryCode?, smsDailyLimit = 100, whatsappDailyLimit = 100, timezone = 'UTC', sendStart = '09:00', sendEnd = '19:00' }`.
  Send: `POST https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json` form-encoded (`To`, `From` or
  `MessagingServiceSid`, `Body` or `ContentSid` + `ContentVariables`), Basic auth. Test: `GET /Accounts/{sid}.json`.
  Signature: base64 HMAC-SHA1 of `PUBLIC_URL + path` + sorted `key+value` pairs, compared with `timingSafeEqual`.
- `simulated`: records, never transmits; `verifySignature` always returns `false`. (A "test signature" accepted by the
  simulated provider would be a public backdoor, since it is the default provider for every workspace.)

**Inbound**: `POST /api/public/twilio/:integrationId/inbound` (form-encoded, foundation's parser; its prefix is already in `app.ts` `FORM_PREFIXES`). Only works for an
integration row with provider `twilio` (anything else → 404). Looks up the integration (its workspace), verifies
`X-Twilio-Signature` with that integration's auth token against `PUBLIC_URL` (missing `PUBLIC_URL` → 503 and an
integration warning), ignores duplicates by `MessageSid`. Tests create a `twilio` integration with a test auth token
and sign requests themselves. Leads are matched by phone: both sides normalized to E.164 in JS (`leads.phone` is free
text), scanning the workspace's leads that have a phone. `STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT` →
`suppressLead` reason `sms_stop` (the spec says "suppress the lead", so every channel stops), or `suppressIdentity(phone)`
when no lead matches; `START, UNSTOP` delete every `sms_stop` suppression row of that lead/phone (all kinds, so
nothing is left half-suppressed) but do not restart stopped campaign leads. Other messages → conversation +
`handleInboundReply`. Responds with empty TwiML.
The integration card shows the webhook URL to paste into Twilio.

**Routes** (`routes/tasks.ts`)

| Method | Path | Role | Shape |
|---|---|---|---|
| GET | `/api/tasks` | any | `?status=open\|overdue\|done\|skipped&assignee=me\|all\|<id>&campaignId&kind&page&pageSize` → `{ total, items: [{ id, kind, title, instructions, status, dueAt, autoSkipAt, outcome, notes, assignee, lead: { id, name, profileUrl, phone, email }, campaign: { id, name } }] }` |
| GET | `/api/tasks/counts` | any | → `{ open, dueToday, overdue, mine }` |
| POST | `/api/tasks` | writer | `{ leadId, kind, title, instructions?, dueAt, assigneeId? }` (manual task) |
| PATCH | `/api/tasks/:id` | writer | `{ title?, instructions?, dueAt?, assigneeId? }` |
| POST | `/api/tasks/:id/complete` | writer | `{ outcome?, notes? }` → wakes the lead; emits `task.completed` |
| POST | `/api/tasks/:id/skip` | writer | `{ notes? }` → wakes the lead |

**Web**: `Tasks` page + nav entry with a due-today badge: filters (status, assignee, campaign, kind), table/cards with
lead link, `tel:`/`mailto:`/profile links per kind, Complete (outcome select + notes for calls) and Skip buttons.
Dashboard card "Tasks due today". Builder palette: "Manual task", "Send SMS", "Send WhatsApp" with editors.

**Tests** (`test/tasks-sms.test.ts`): task node creates one task and holds the lead; completing moves the lead on;
auto-skip after N days; a sequence edit while the task is open does not create a second task; replied lead's task is
skipped; assignee from another workspace rejected; inbound to a non-Twilio integration id → 404; SMS through the
simulated provider respects daily limit and window; missing phone → skipped; Twilio provider request shape via
`fakeFetch`; signature verification (valid, tampered param, wrong URL); inbound STOP suppresses and stops all
campaigns, START re-allows SMS; inbound reply shows in inbox and stops the sequence; tasks API isolation and roles.

### 4.9 g4-data: email finding, verification, enrichment

**Migration M9**

```sql
ALTER TABLE leads ADD COLUMN email_source TEXT;          -- user | csv | linkedin | hunter | apollo | simulated (NULL = entered before this step: treated as user)
ALTER TABLE leads ADD COLUMN email_found_at INTEGER;
ALTER TABLE leads ADD COLUMN company_domain TEXT;
ALTER TABLE leads ADD COLUMN enrichment TEXT NOT NULL DEFAULT '{}';   -- JSON: companySize, industry, website, ...
ALTER TABLE leads ADD COLUMN enrichment_status TEXT;     -- queued | done | not_found | failed
ALTER TABLE leads ADD COLUMN enriched_at INTEGER;
CREATE INDEX leads_email_status ON leads(workspace_id, email_status);   -- needs leads.email_status from M7; if g3-mailboxes was rolled back, add the three email_status* columns here first
CREATE TABLE enrichment_runs (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  options TEXT NOT NULL DEFAULT '{}',
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  found INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',          -- running | done
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
```

**Provider kinds** (`providers/data/`), one module per vendor, endpoints from public docs (verify before release):

| Kind | Provider | Call | Test |
|---|---|---|---|
| `email_finder` | `hunter` | `GET https://api.hunter.io/v2/email-finder?domain|company&first_name&last_name&api_key` → `data.email, data.score, data.verification.status` | `GET /v2/account` |
| `email_finder`, `enrichment` | `apollo` | `POST https://api.apollo.io/api/v1/people/match` (header `x-api-key`; `first_name, last_name, organization_name, domain, linkedin_url`) → `person.email, person.email_status, person.title, person.organization{...}` | `GET /api/v1/auth/health` |
| `email_verifier` | `hunter` | `GET /v2/email-verifier?email&api_key` → `data.status` | `GET /v2/account` |
| `email_verifier` | `zerobounce` | `GET https://api.zerobounce.net/v2/validate?api_key&email` → `status` | `GET /v2/getcredits` |
| `email_verifier` | `neverbounce` | `GET https://api.neverbounce.com/v4.2/single/check?key&email` → `result` | `GET /v4.2/account/info` |
| all three | `simulated` | hash-based: finder finds 60 % (`first.last@<company>.example`), verifier valid 70 % / risky 20 % / invalid 10 % | always ok |

Interfaces: `EmailFinder { find({ firstName, lastName, company, domain?, profileUrl }) → { email, confidence?, status? } | null }`,
`EmailVerifier { verify(email) → { status: 'valid'|'risky'|'invalid'|'unknown', reason } }`,
`Enricher { enrich(leadData) → { fields: Partial<LeadFields>, companyDomain?, enrichment: Record<string, unknown> } | null }`.
Status mapping lives next to each vendor (`accept_all/catch-all/webmail? → risky`, `disposable/spamtrap/abuse/do_not_mail → invalid`).
Each call records `usage_events` with credits. Default rate limits: 2 req/s per integration; 429 → `RetryLater`.

**Server**
- `services/enrichment.ts`:
  - `findEmailWaterfall(ctx, ws, lead, opts)`: finders in priority order; each found address is verified (first
    enabled verifier, unless the finder already returned a verified status and `settings.trustFinderStatus`); stop at
    the first `valid` (or `risky` when `acceptRisky`). If none valid, keep the best candidate (`risky` > `unknown`) only when
    the lead has no email. `invalid` is never stored.
  - **No-overwrite rule**: a lead email with `email_source` NULL, `user`, `csv` or `linkedin` is never replaced unless the
    request says `overwrite: true`; verification of an existing email only updates `email_status`.
  - `enrichLeadData(ctx, ws, lead)`: fills blanks only (same rule as `enrichLead`), `company_domain`, `enrichment` JSON.
  - Workspace settings `enrichment`: `{ verifyFound: true, acceptRisky: false, trustFinderStatus: false, autoEnrichOnImport: false, enrichCompany: true }`.
- Job `enrich.lead { leadId, runId?, find, verify, company, overwrite, campaignLeadId? }` (dedupe
  `enrich.lead:<leadId>:<runId | 'cl' + campaignLeadId | 'single'>`; a plain per-lead key would let a second bulk run's
  enqueue be absorbed by the first run's job, so the second run's counters would never reach `total` and it would stay
  `running`). Work is idempotent: if the lead was enriched with the same options in the last 10 minutes, the handler
  reuses that result and only updates the counters. Updates run counters (run → `done` when `done = total`) and
  `enrichment_status`; emits `lead.enriched`; wakes a held campaign lead.
- CSV import and LinkedIn import set `email_source` (`csv`/`linkedin`); manual edits set `user`; `enrichLead` filling an
  email from a 1st-degree profile view sets `linkedin`; import options `autoEnrich` (or the workspace setting) enqueue
  a run for added leads. Real mailboxes now also refuse `email_source = 'simulated'` (on top of g3's reserved-domain rule).
- Engine: free node `find_email { verify: boolean (default true), maxWaitHours (1–48, default 6) }`: lead with a valid
  email → move on; else enqueue `enrich.lead` and hold (`hold_reason 'enrich'`) until the job wakes it or the wait
  ends. Condition kind `email_verified` (yes when email present and `email_status` is `valid`, or `risky` with `acceptRisky`).

**Routes**

| Method | Path | Role | Shape |
|---|---|---|---|
| POST | `/api/leads/enrich` | writer | `{ leadIds? , listId?, find = true, verify = true, company = false, overwrite = false }` → `{ runId, total }` (max 10 000) |
| GET | `/api/enrichment/runs/:id` | any | → run counters |
| POST | `/api/leads/:id/enrich` | writer | same options → `{ jobId }` |
| GET/PUT | `/api/settings/enrichment` | any / admin | settings JSON |
| GET | `/api/leads` | any | adds filters `emailStatus=valid\|risky\|invalid\|unknown\|missing`, `enrichment=done\|not_found\|failed\|none`; items add `emailStatus, emailSource, enrichmentStatus, companyDomain` |

**Web**: Leads table: email status `Pill` + source tooltip, filters, bulk "Find & verify emails" modal (options +
`ProgressBar` polling the run). Lead drawer: enrichment section with buttons and company facts. Integrations tab:
finder/verifier ordering (uses `PUT /api/integrations/order`) and a "Usage this month" table from `/api/usage`.
Builder: "Find email" node and "If email verified" condition.

**Tests** (`test/data.test.ts`): waterfall order with two fake finders (first misses, second finds) via `fakeFetch`;
verification status mapping per vendor; risky handling with/without `acceptRisky`; existing user email never
overwritten unless `overwrite`; `find_email` node holds then continues and `email_verified` branches; usage credits
recorded per provider/month; 429 → retry later; bulk run progress; two overlapping bulk runs over the same leads both
finish; simulated `.example` emails never sent by a real mailbox; isolation.

### 4.10 g5-pipeline: stages, tags, notes, lead detail, board

**Migration M10**

```sql
CREATE TABLE pipeline_stages (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,                              -- new | contacted | replied | interested | meeting | won | lost | custom-xxxx
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#64748b',
  position INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'open',               -- open | won | lost
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, slug)
);
INSERT INTO pipeline_stages (workspace_id, slug, name, color, position, kind, created_at) SELECT id, 'new', 'New', '#64748b', 0, 'open', created_at FROM workspaces;
INSERT INTO pipeline_stages (workspace_id, slug, name, color, position, kind, created_at) SELECT id, 'contacted', 'Contacted', '#3b82f6', 1, 'open', created_at FROM workspaces;
INSERT INTO pipeline_stages (workspace_id, slug, name, color, position, kind, created_at) SELECT id, 'replied', 'Replied', '#8b5cf6', 2, 'open', created_at FROM workspaces;
INSERT INTO pipeline_stages (workspace_id, slug, name, color, position, kind, created_at) SELECT id, 'interested', 'Interested', '#f59e0b', 3, 'open', created_at FROM workspaces;
INSERT INTO pipeline_stages (workspace_id, slug, name, color, position, kind, created_at) SELECT id, 'meeting', 'Meeting booked', '#10b981', 4, 'open', created_at FROM workspaces;
INSERT INTO pipeline_stages (workspace_id, slug, name, color, position, kind, created_at) SELECT id, 'won', 'Won', '#16a34a', 5, 'won', created_at FROM workspaces;
INSERT INTO pipeline_stages (workspace_id, slug, name, color, position, kind, created_at) SELECT id, 'lost', 'Lost', '#ef4444', 6, 'lost', created_at FROM workspaces;

ALTER TABLE leads ADD COLUMN stage_id INTEGER REFERENCES pipeline_stages(id) ON DELETE SET NULL;   -- NULL = first stage
ALTER TABLE leads ADD COLUMN stage_changed_at INTEGER;
ALTER TABLE leads ADD COLUMN stage_manual INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX leads_stage ON leads(workspace_id, stage_id);
UPDATE leads SET stage_id = (SELECT s.id FROM pipeline_stages s WHERE s.workspace_id = leads.workspace_id AND s.slug = 'replied') WHERE replied_at IS NOT NULL;
UPDATE leads SET stage_id = (SELECT s.id FROM pipeline_stages s WHERE s.workspace_id = leads.workspace_id AND s.slug = 'contacted')
  WHERE stage_id IS NULL AND EXISTS (SELECT 1 FROM activity a WHERE a.lead_id = leads.id AND a.status = 'ok' AND a.type IN ('connect', 'message', 'email', 'inmail', 'sms', 'whatsapp'));

CREATE TABLE lead_stage_history (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_stage_id INTEGER,
  to_stage_id INTEGER,
  source TEXT NOT NULL,                            -- manual | auto | api
  reason TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX lead_stage_history_lead ON lead_stage_history(lead_id, created_at);

-- Tag metadata. Lead membership stays in leads.tags (JSON array of names), which CSV import/export already use.
CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#64748b',
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE lead_notes (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX lead_notes_lead ON lead_notes(lead_id, created_at);
```

**Server**
- `services/pipeline.ts`: `ensureStages(ctx, ws)` (idempotent; called at registration and workspace creation **and**
  lazily by every pipeline read/write, because workspaces are also created by direct inserts in `seed.ts` and
  `makeWorld`, and without stages `autoAdvance` would silently do nothing),
  `setStage(ctx, lead, stageId, { source, userId, reason })` (history row, `stage_manual = source === 'manual'`,
  emits `lead.stage_changed` through `db.afterCommit`, so a rolled-back caller transaction never announces a move),
  `autoAdvance(ctx, lead, slug, reason)`: moves only **forward** by position, never out
  of a `won`/`lost` stage, no-op when the slug was deleted. The first stage must be `open` (reorder, kind change and
  delete refuse otherwise), and a reorder that changes the first stage first pins leads with `stage_id NULL` to the old
  first stage, so leads never change stage without a history row and webhook. Hooks: first `ok` contact activity → `contacted`
  (engine `advance`, mail runner, messaging runner); `handleInboundReply` → `replied`; `ai.classify` → `SUGGESTED_STAGE`
  (`interested`, `meeting`; `not_interested → lost` only if workspace setting `pipeline.autoLost` is on, default off);
  task outcome `meeting_booked` → `meeting`. `publicLead` adds `stage: { id, slug, name }`.
- `services/tags.ts`: tag names are trimmed, 1–50 chars, compared case-insensitively in JS; `listTags` = tags rows ∪ names
  found in leads (rows created on first use); rename/delete rewrite `leads.tags` JSON in a tx; filter
  `leads.tags LIKE '%' || <JSON-quoted name> || '%'` then confirm in JS.
- Lead timeline: `GET /api/leads/:id/timeline` merges activity, messages (all channels), notes, stage history and
  tasks, newest first, paged.

**Routes**

| Method | Path | Role | Shape |
|---|---|---|---|
| GET | `/api/pipeline/stages` | any | → `[{ id, slug, name, color, position, kind, leads }]` |
| POST | `/api/pipeline/stages` | admin | `{ name, color?, kind? }` |
| PATCH | `/api/pipeline/stages/:id` | admin | `{ name?, color?, kind? }` |
| DELETE | `/api/pipeline/stages/:id` | admin | `{ moveTo: stageId }` (last stage cannot be deleted) |
| PUT | `/api/pipeline/stages/order` | admin | `{ ids }` |
| GET | `/api/pipeline/board` | any | `?campaignId&ownerId&tag&q&perStage=50` → `{ stages: [{ ...stage, total, leads: [{ id, name, company, title, tags, ownerId, lastActivityAt, replyCategory }] }] }` |
| POST | `/api/leads/:id/stage` | writer | `{ stageId }` |
| POST | `/api/leads/bulk` | writer | `{ leadIds, stageId?, addTags?, removeTags?, ownerId? }` → `{ updated }` |
| GET/POST | `/api/tags` | any / writer | create `{ name, color? }` |
| PATCH/DELETE | `/api/tags/:id` | admin | rename/recolor/delete |
| GET/POST | `/api/leads/:id/notes` | any / writer | `{ body (1–10 000) }` |
| PATCH/DELETE | `/api/notes/:id` | author or admin | |
| GET | `/api/leads/:id/timeline` | any | `?before&limit` |
| PATCH | `/api/leads/:id` | writer | adds `ownerId` (must be a workspace member, else 404) |

**Web**: `Pipeline` page + nav entry: columns per stage with counts, cards, filters (campaign, owner, tag, search),
HTML5 drag-and-drop **and** a "Move to…" select on each card for keyboard users; "Load more" per column. Lead detail
drawer (extend `LeadDrawer`): header with stage select and owner, tags editor (create/apply/remove, colors), notes
(add/edit/delete own), campaigns, unified timeline. Leads page: stage/tag/owner columns and filters, bulk stage/tag
actions. Settings: "Pipeline" tab for stage editing (admins). Inbox thread: stage control replaces the g2 hint.

**Tests** (`test/pipeline.test.ts`): default stages per workspace (migration and new workspaces); first contact →
contacted, reply → replied, interested classification → interested; automation never moves backward, never leaves
won/lost; manual move logs history and emits `lead.stage_changed`; stage delete moves leads; tag rename/delete updates
leads JSON; bulk tag/untag; notes author/admin rules; board filters; isolation (other workspace's stage id → 404).

### 4.11 g5-agency: memberships, client workspaces, client role, white-label

**Migration M11**

```sql
CREATE TABLE memberships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',             -- owner | admin | member | client
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);
CREATE INDEX memberships_workspace ON memberships(workspace_id);
INSERT INTO memberships (user_id, workspace_id, role, created_at) SELECT id, workspace_id, role, created_at FROM users;
ALTER TABLE sessions ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE;   -- active workspace; NULL = home
ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard';                            -- standard | agency | client
ALTER TABLE workspaces ADD COLUMN parent_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL;
CREATE INDEX workspaces_parent ON workspaces(parent_id);
CREATE TABLE invites (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,                             -- lower-cased
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,                 -- sha256 of the token; the token itself is never stored
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE branding (
  workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  product_name TEXT,
  logo_url TEXT,
  primary_color TEXT,
  support_email TEXT,
  custom_domain TEXT,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX branding_domain ON branding(custom_domain) WHERE custom_domain IS NOT NULL;
```

**Server**
- `services/memberships.ts`. `sessionUser()` joins `sessions → users → memberships` on
  `COALESCE(s.workspace_id, u.workspace_id)`; role comes from the membership. If that membership is gone, fall back to
  the user's first membership; none → signed out. `SessionUser` keeps `workspace_id` (= active workspace), so every
  existing `user(req).workspace_id` keeps working. After this step, nothing reads `users.role`; `users.workspace_id`
  stays as the "home" workspace.
- **Every path that creates a user also inserts the membership** in the same transaction: `POST /api/auth/register`
  (role `owner`), `POST /api/team`, invite acceptance, and `seed.ts`. A user without a membership row is signed out
  by the new `sessionUser`, so missing one of these breaks sign-in.
- **Agency access is inherited, not copied.** Owners/admins of an agency get `owner`/`admin` rights in its client
  workspaces through `parent_id`, resolved in `sessionUser` (direct membership role first, else the inherited role).
  Copying memberships into every client at creation time would leave a removed agency admin with admin rights in
  every client, and would miss admins added later.
- `services/workspaces.ts → deleteWorkspace(ctx, id)`: moves members' home workspace to another membership (users with
  none are deleted with it, since `users.workspace_id` cascades), and explicitly deletes rows in tables that have
  `workspace_id` but **no foreign key** (`activity`, `conversations` (messages cascade), `imports`, and `sim_people` of
  the workspace's accounts), then deletes the workspace in one transaction.
- Team routes use memberships: list members of the active workspace; `POST /api/team` (existing: create user with
  password) also inserts the membership; `DELETE /api/team/:id` removes the membership (the user remains if other
  memberships exist, else is deleted); `PATCH /api/team/:id { role }` (admin; cannot demote the last owner).
- **Client role enforcement**: a `preHandler` hook after auth: if `role === 'client'`, the request must match
  `CLIENT_ALLOWED` (route patterns from `req.routeOptions.url`): GET `/api/auth/me`, `/api/workspaces`, `/api/branding`,
  `/api/analytics`, `/api/activity`, `/api/campaigns`, `/api/campaigns/:id`, `/api/campaigns/:id/leads`,
  `/api/campaigns/:id/variants`, `/api/inbox`, `/api/inbox/:id`, `/api/pipeline/stages`, `/api/pipeline/board`,
  `/api/health`; POST `/api/auth/logout`, `/api/auth/password`, `/api/workspaces/switch`. Everything else → 403.
  `GET /api/inbox/:id` must not mark threads read for clients. Serializers never include secrets anyway.
  The Dashboard page requests `/api/accounts`, which clients are denied: for clients it skips that request
  (`useApi(null)`) and hides the accounts card instead of showing an error.
- Agency: `POST /api/agency/enable` (owner of a standard workspace) → `kind = 'agency'`. Client workspaces:
  `kind = 'client'`, `parent_id = agency`; no memberships are copied (inherited access, above); `ensureStages`.
  Agency admins act inside a client by switching to it. `GET /api/workspaces` lists direct memberships plus the
  clients of agencies where the user is owner/admin.
- Overview: for each child workspace where the user is admin+: LinkedIn accounts (total, needing attention), mailboxes
  needing attention, active campaigns, contacted, replies, meetings (`reply_category = 'meeting_booked'` or stage
  `meeting`), reply rate, last activity, over `?days`.
- Invites: token = `token(32)`, stored hashed, 7-day expiry. Email via the installation mailer (`SMTP_URL`, `MAIL_FROM`;
  job `invite.email { inviteId }` with retries); response always includes `link` (`PUBLIC_URL/invite/<token>`, or a
  relative path when unset) so admins can share it when no mailer is configured. Accept: existing user must be signed
  in as that email or give their password (counted by the same failed-login throttle as `/api/auth/login`, keyed by
  email + IP); new user sets name + password for the invited email (bypasses `ALLOW_SIGNUP`, since an admin invited
  them). Accepting is single-use (`accepted_at` set in the same transaction) and adds the membership and switches the
  session to that workspace.
- White-label: `branding` row on the agency (clients inherit their parent's, overridable per client).
  `GET /api/branding` (public, in `PUBLIC`, so the auth hook does not run: it reads the session cookie itself and
  ignores an invalid one) resolves: `Host` (or `X-Forwarded-Host` when `TRUST_PROXY`) matching
  `custom_domain` → that branding; else the signed-in user's active workspace (own or parent); else defaults
  `{ productName: 'OpenReach', primaryColor: null, logoUrl: null, supportEmail: null }`. Validation: product name ≤ 40,
  `logo_url` https only, color `#rrggbb`, email, domain hostname. Custom domains need DNS + TLS at the operator's proxy (README).

**Routes**

| Method | Path | Role | Shape |
|---|---|---|---|
| GET | `/api/workspaces` | any | → `[{ id, name, kind, role, parentId, parentName }]` |
| POST | `/api/workspaces/switch` | any (incl. client) | `{ workspaceId }` (must be a member) → `me` |
| POST | `/api/agency/enable` | owner | → `{ ok }` |
| GET/POST | `/api/agency/clients` | admin of agency | create `{ name }` → `{ id }` |
| PATCH/DELETE | `/api/agency/clients/:id` | owner of agency | rename / delete (body `{ confirm: name }`; `deleteWorkspace`) |
| GET | `/api/agency/overview` | admin of agency | `?days=30` → `{ clients: [...] }` |
| GET/PUT | `/api/agency/branding` | admin of agency (or client workspace override) | branding fields |
| GET | `/api/branding` | public | → branding |
| GET/POST | `/api/invites` | admin | `{ email, role: 'admin'\|'member'\|'client' }` → `{ id, link, emailed }` |
| DELETE | `/api/invites/:id` | admin | revoke |
| GET | `/api/public/invites/:token` | public | → `{ workspaceName, email, role, existingUser, branding }` |
| POST | `/api/public/invites/:token/accept` | public | `{ name?, password }` → `me` (sets session cookie) |
| PATCH | `/api/team/:id` | admin | `{ role }` |

**Web**: workspace switcher in the sidebar footer (lists memberships, marks clients/agency); `Agency` page + nav entry
(feature `agency`, admins of an agency): overview table with per-client stats, "Open" (switch), create/rename/delete
clients, branding form with live preview. Settings → Team: roles editable, invites list with copyable link.
`Invite.tsx` route `/invite/:token` (works signed out). Branding loaded before sign-in: CSS variables (`--accent`
and derived shades), `document.title`, logo and product name in the sidebar and sign-in page. Client role: nav
limited to Dashboard, Campaigns, Pipeline, Inbox; mutating controls hidden (`canWrite(me)` helper).

**Tests** (`test/agency.test.ts`): existing users keep working after migration (login, roles, team list); register,
team-add and seed-style users get memberships; an agency admin removed from the agency loses access to its clients;
deleting a client workspace leaves no `activity`/`conversations`/`imports` rows behind; a user in
two workspaces switches and sees each one's data only; client role: iterate every registered non-GET `/api/` route
(collected with an `onRoute` hook in `buildApp`) and assert 403 except the allowlist, and assert denied GETs
(integrations, mailboxes, accounts, team, webhooks, leads export, billing); invite flow for new and existing users,
expired/used token rejected, invite to another workspace's id impossible; agency overview only covers own clients;
client A cannot read client B; branding by Host header and inheritance; last owner cannot be demoted.

### 4.12 g5-crm: HubSpot and Pipedrive sync

**Migration M12**

```sql
CREATE TABLE crm_links (
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,                       -- contact | deal
  external_id TEXT NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (lead_id, integration_id, object_type)
);
CREATE TABLE crm_items (
  integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,                          -- message:<id> | activity:<id> | stage:<historyId>
  external_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (integration_id, item_key)
);
CREATE TABLE crm_sync_log (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id INTEGER REFERENCES integrations(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  job_id INTEGER,
  event TEXT NOT NULL,
  operation TEXT NOT NULL,                         -- upsert_contact | add_note | create_deal
  status TEXT NOT NULL,                            -- ok | error | skipped
  external_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX crm_sync_log_ws ON crm_sync_log(workspace_id, created_at);
```

**Provider kind `crm`** (`providers/crm/`):
`CrmProvider { upsertContact(c: CrmContact, mapping, existingId?) → { id, created }; addNote(contactId, { body, timestamp }) → { id }; createDeal(contactId, { name, stage? }) → { id } }`.
- `hubspot`: credentials `{ accessToken }` (private app); `Authorization: Bearer`; search `POST /crm/v3/objects/contacts/search`
  (by email, else by the mapped LinkedIn URL property), create `POST /crm/v3/objects/contacts`, update `PATCH /crm/v3/objects/contacts/{id}`,
  notes `POST /crm/v3/objects/notes` (`hs_note_body`, `hs_timestamp`, association to the contact), deals
  `POST /crm/v3/objects/deals` with a contact association. Test `GET /crm/v3/objects/contacts?limit=1`. Rate limit ~8 req/s.
- `pipedrive`: credentials `{ apiToken }`, settings `{ companyDomain }` (validated per 2.3, so a value like
  `evil.com#` cannot send the token elsewhere); base `https://{companyDomain}.pipedrive.com/api/v1`;
  `GET /persons/search?term&fields=email&exact_match=true`, `POST /persons`, `PUT /persons/{id}`, `POST /notes { content, person_id }`,
  `POST /deals { title, person_id }`. Test `GET /users/me`.
- `simulated`: in-memory ids derived from hashes; writes only the sync log.
- Settings (all CRMs): `{ triggers: { onReply: true, onStageChange: string[] (stage slugs, default ['interested','meeting']), onCampaignFinished: false, onConnected: false, logMessages: false }, createDealOn: string[] (default []), dealNameTemplate: '{{company}} – {{fullName}}', fieldMapping: Record<ourField, crmProperty> }`
  with defaults per vendor (HubSpot `firstname, lastname, email, company, jobtitle`; Pipedrive `name, email, phone`;
  LinkedIn URL property empty until the user names one).

**Server**: `crm/triggers.ts` subscribes to `ctx.webhooks` events (only configured CRM integrations; no simulated fallback, 2.3) (`lead.replied`, `lead.stage_changed`,
`lead.finished`, `lead.connected`, `lead.classified`, `action.performed` for message-type actions when `logMessages`)
and enqueues `crm.sync { integrationId, leadId, event, ref }` for each enabled CRM integration whose triggers match
(dedupe `crm.sync:<integrationId>:<leadId>:<event>:<ref>`). `crm/sync.ts` handler: upsert contact (store `crm_links`),
add a note for the event (skip if `crm_items` has the key), create a deal when the event/stage/category is in
`createDealOn` and no deal link exists; log each operation; `RATE_LIMIT` → `RetryLater`, `AUTH` → permanent + integration
error. Delivery is at-least-once (a crash between the API call and our write can duplicate a note; documented).

**Routes**: `GET /api/crm/log` (admin) `?integrationId&status&page` → `{ total, items }`; `POST /api/crm/log/:id/retry`
(admin) → `{ jobId }`; `POST /api/crm/push` (writer) `{ integrationId, leadIds (≤ 1000) }` → `{ queued }`.

**Web**: Integrations tab, CRM section: trigger checkboxes, stage multi-select, deal options, field-mapping table
(our field → CRM property), "Sync log" table with status pills, errors and Retry. Lead drawer: "Push to CRM" and links
to CRM records when known.

**Tests** (`test/crm.test.ts`, `fakeFetch`): HubSpot upsert finds by email, then updates (no duplicate) on the next
event; creates when missing; note created once per message even if the job reruns; deal on `interested` only when
configured; Pipedrive person/note/deal shapes and `companyDomain` URL; trigger selection (reply on, connected off);
429 → retried later with `Retry-After`; 401 → permanent error and integration marked error; tokens masked; isolation
of the log.

### 4.13 g5-billing: plans and Stripe

**Migration M13**

```sql
CREATE TABLE subscriptions (
  workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,  -- the billing root (agency or standalone)
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  plan_id TEXT,
  status TEXT NOT NULL DEFAULT 'none',              -- none | trialing | active | past_due | unpaid | canceled | incomplete
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  last_event_at INTEGER NOT NULL DEFAULT 0,         -- Stripe event `created` (s), to ignore out-of-order events
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX subscriptions_customer ON subscriptions(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
```

**Server**
- `billing/plans.ts`: plans from `BILLING_PLANS` (JSON) or `BILLING_PLANS_FILE`, validated with zod at startup (bad
  config = clear startup error): `[{ id, name, priceId, default?: boolean, limits: { linkedinAccounts, mailboxes, seats, clientWorkspaces, aiCreditsMonthly, enrichmentCreditsMonthly } }]`
  (`null` = unlimited). Exactly one plan may be `default` (applies with no active subscription); without one, a workspace
  without an active subscription cannot create limited resources.
- Billing is enabled only when `STRIPE_SECRET_KEY` is set (`ctx.stripe`); otherwise every check passes (self-hosted
  stays unlimited) and `/api/auth/me.features.billing = false`.
- `billing/limits.ts → assertWithinPlan(ctx, ws, limit, adding = 1)`: billing root = `parent_id ?? id`; usage counted
  across the root and its client workspaces (accounts, mailboxes, distinct non-client members, client workspaces,
  monthly `usage_events.credits`/AI calls). Throws `HttpError(402, 'Your plan allows N … Upgrade to add more.', { code: 'plan_limit', limit, allowed, used })`.
  Called from `POST /api/accounts`, `POST /api/mailboxes`, `POST /api/team`, `POST /api/invites` (non-client roles),
  `POST /api/agency/clients`; AI routes/jobs and enrichment check credits before calling a provider (a job over quota
  fails permanently with a clear error; the engine then uses fallbacks).
  `past_due/unpaid/canceled` → default plan limits; nothing is deleted or paused automatically.
- `billing/stripe.ts`: Checkout session (`mode: 'subscription'`, `client_reference_id` = root workspace id,
  `metadata.workspace_id`, success/cancel URLs `PUBLIC_URL/billing?status=...`), Customer Portal session, webhook
  handling with `stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET)`. The webhook route is
  registered in an encapsulated Fastify plugin whose `application/json` parser keeps the raw string. Events:
  `checkout.session.completed` (link customer/subscription), `customer.subscription.created|updated` (status, plan by
  price id, period end, cancel flag), `customer.subscription.deleted` (canceled, plan null), `invoice.payment_failed`
  (past_due). Idempotent via `stripe_events`; older events than `last_event_at` are ignored. With the key set but no
  `STRIPE_WEBHOOK_SECRET`, the webhook answers 503 (never processes unsigned events) and the Billing page warns.
  Checkout/portal need `PUBLIC_URL` for return URLs (409 with a clear message otherwise).
- Billing routes act on the **billing root** (`parent_id ?? id` of the active workspace) and require `owner` of that
  root. Being owner of a client workspace is not enough to see or change the agency's subscription.

**Routes**

| Method | Path | Role | Shape |
|---|---|---|---|
| GET | `/api/billing` | owner | → `{ enabled, plan, status, currentPeriodEnd, cancelAtPeriodEnd, plans: [{ id, name, limits }], usage: { [limit]: { used, allowed } } }` |
| POST | `/api/billing/checkout` | owner | `{ planId }` → `{ url }` |
| POST | `/api/billing/portal` | owner | → `{ url }` |
| POST | `/api/public/stripe/webhook` | public (signature) | raw body → `{ received: true }`; bad signature → 400 |

**Web**: `Billing` page + nav entry (feature `billing`, owners): current plan and status, usage `Meter`s vs limits,
plan cards with "Choose", "Manage billing". `api.ts`: `ApiError` keeps `details`; `useAction` shows a toast with an
"Upgrade" link to `/billing` when `details.code === 'plan_limit'`.

**Tests** (`test/billing.test.ts`): billing off → creating accounts is unlimited (existing tests unaffected); on with
a default plan of 1 account → second account 402 with details; agency root counts client workspaces' accounts;
webhook with a valid signature built by `stripe.webhooks.generateTestHeaderString` (test secret, constructed event
JSON, no network) updates the subscription; bad signature 400; duplicate event ignored; out-of-order update ignored;
`deleted` → canceled → default limits; checkout/portal routes call a stubbed `ctx.stripe`; non-owner 403; owner of a
client workspace (not of the agency root) 403; missing webhook secret → 503.

### 4.14 postgres: optional Postgres backend

**Goal**: `DATABASE_URL=postgres://...` uses Postgres; without it SQLite behaves exactly as before.

**Recommended approach: keep the synchronous `DB` API and add a synchronous Postgres adapter.** Converting the whole
codebase (engine transactions, routes, every step's services) to async is a very large, risky diff, and the engine's
correctness relies on `tx(() => ...)` running without interleaving. Instead:

- `db/database.ts`: `interface Database { dialect; get; all; run; insert; update; tx; close }`. The SQLite class keeps
  the name `DB` (so `new DB(':memory:')` in tests and seed keeps working) and implements it. `Ctx.db: Database`.
  `openDatabase(config)` picks the adapter. **Both entry points must use it**: `buildContext` (today
  `new DB(config.dbPath)`, used by `seed.ts`) and `server/src/index.ts`, which opens `new DB(config.dbPath)` itself
  before `buildContext`; otherwise `DATABASE_URL` is silently ignored. `DriverPool`, `SimulatorDriver` and `Webhooks`
  take `Database` instead of `DB`.
- `db/postgres.ts → PgDatabase`: runs `pg` in a worker thread (created with `new Worker(source, { eval: true, workerData: { pgPath } })`,
  where `pgPath` is resolved with `createRequire(import.meta.url).resolve('pg')`, so no build step changes) holding
  **one** connection. Each call posts `{ sql, params }`, then the main thread blocks with `Atomics.wait` on a
  `SharedArrayBuffer` flag and reads the reply with `receiveMessageOnPort`. One connection plus a blocking call means
  statements and transactions never interleave inside a process, exactly like SQLite. `tx()` keeps the depth counter
  and sends `BEGIN`/`COMMIT`/`ROLLBACK`. Calls time out (30 s) with an error instead of hanging. This blocks the event
  loop for the duration of each query (≈1 ms on a nearby database); document it as the trade-off.
- `db/translate.ts` (runtime, cached per SQL string): `?` and `$name` → `$1..$n` (skipping string literals and
  comments; named params resolved from the object); `INSERT OR IGNORE INTO t (...)` → `... ON CONFLICT DO NOTHING`;
  `LIKE` → `ILIKE`; `BEGIN IMMEDIATE` → `BEGIN`. `insert()` appends `RETURNING id` **only for tables that have an `id`
  column** (column list read once from `information_schema` and cached); others (`sessions` is inserted through
  `insert()` today, plus `memberships`, `campaign_accounts`, ...) return 0, matching rule 8 in 2.2. Type parsers: int8 (20) and numeric
  (1700) → `Number`. Postgres cannot infer the type of a bare parameter in a `SELECT` list, `CASE` or `COALESCE(?, ?)`
  ("could not determine data type of parameter"); fix such statements at the source with `CAST(? AS BIGINT|TEXT)`,
  which SQLite accepts too, rather than guessing in the translator.
- Pre-existing non-portable SQL is fixed at the source (portable in both dialects): `SUM(ld.connection_status = 'connected')`
  in `routes/leads.ts`; `MAX(last_message_at, ?)` in `engine/sync.ts`; unquoted camelCase aliases (≈14 places);
  `users.email` comparisons become `lower(email) = lower(?)`; `INSERT OR IGNORE` in `services/leads.ts`,
  `routes/settings.ts`. SQLite results must stay identical (same keys, same rows).
- Migrations: `translateDdl(sql)` for Postgres: `INTEGER PRIMARY KEY` → `BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`
  (except the `migrations` table), other `INTEGER` → `BIGINT` (millisecond timestamps overflow 32-bit), `REAL` →
  `DOUBLE PRECISION`, `users.email ... UNIQUE COLLATE NOCASE` → `TEXT NOT NULL` + `CREATE UNIQUE INDEX users_email_lower ON users (lower(email))`,
  drop `PRAGMA`s. `MIGRATIONS` entries may become `string | { sqlite: string; postgres: string }` for anything the
  translator cannot handle (appending only; existing entries are untouched and translated). A fresh Postgres database
  runs all migrations from 0, so data-copy statements in old migrations are no-ops there. Copying an existing SQLite
  database into Postgres is out of scope (README says so; an export/import script is optional).
- Multi-instance safety: the engine and job worker run only in the instance that holds
  `pg_try_advisory_lock(<constant>)` on its connection (retry every 30 s; log "standby"). The lock is session-scoped:
  if the worker's connection drops and reconnects, the instance has lost leadership, so it stops the engine timer,
  goes back to standby and tries the lock again before running anything. The job claim adds
  `FOR UPDATE SKIP LOCKED`. API-only instances serve requests and enqueue jobs. SQLite is always the leader.
- Tests: `test/helpers.ts → testDb()` returns SQLite `:memory:` by default, or with `TEST_DATABASE_URL` a `PgDatabase`
  on a fresh schema (`CREATE SCHEMA t_<random>`; `SET search_path`; dropped afterwards). `npm run test:pg -w server`
  sets the variable. Try `embedded-postgres` (dev dependency) or a local install to actually run it, fix what breaks,
  and report honestly whether Postgres was exercised.
- Deploy: `docker-compose.yml` gets an optional `postgres` service under `profiles: ["postgres"]` with a volume and a
  commented `DATABASE_URL`; `render.yaml` notes how to attach a Render Postgres and set `DATABASE_URL`; README
  configuration table and the scaling limitation are updated.
- If the change cannot be finished green, stop and report (the workflow rolls it back and keeps the patch).

**Tests**: translator unit tests (placeholders with strings containing `?`, named params reused twice, `INSERT OR IGNORE`,
DDL mapping incl. partial indexes and the rebuild migration, `insert()` into a table without `id`); SQLite suite unchanged; whole suite on Postgres when
`TEST_DATABASE_URL` is set; leader lock (second `PgDatabase` cannot take the lock); job claim with two workers never
claims the same job (Postgres only).

---

## 5. Cross-step dependencies

| Shared piece | Owner | Used by |
|---|---|---|
| `jobs` + `JobQueue` (`ctx.jobs`), `RetryLater` | foundation | g1-sources (`leads.import`), g2 (`ai.personalize`, `ai.classify`), g3 (`email.sync`), g4 (`enrich.lead`), g5-agency (`invite.email`), g5-crm (`crm.sync`) |
| `integrations`, `ProviderDef`, `ctx.providers`, `httpJson`, `ProviderError`, `RateLimiter` | foundation | g2 (ai), g3-tasks-sms (sms), g4 (finder/verifier/enrichment), g5-crm (crm) |
| `usage_events` / `recordUsage` | foundation | g2 (tokens), g4 (credits), g5-billing (monthly credit limits) |
| `workspace_settings` | foundation | g4 (enrichment settings), g5-pipeline (`pipeline.autoLost`), others as needed |
| `suppressions` / `suppressLead` | foundation (list/undo routes + UI: g2-ai-replies) | g2-ai-replies (unsubscribe/not interested), g3-mailboxes (unsubscribe link, bounces don't suppress), g3-tasks-sms (STOP), g1-sources (skip on import) |
| form-urlencoded body parser | foundation | g3-mailboxes (one-click unsubscribe), g3-tasks-sms (Twilio) |
| per-kind provider interfaces + simulated providers | foundation | every provider step (adds real vendors, refines simulated behaviour) |
| channel-agnostic `conversations` | foundation (rebuild) | g3-mailboxes (`mailbox_id`), g3-tasks-sms (sms/whatsapp threads), g2-ai-replies (classification on all channels) |
| `requireWriter` / positive `requireAdmin` / `Role` incl. `client` | foundation | every step's routes; g5-agency enforces `client` |
| `NAV` array, `features` in `/api/auth/me` | foundation | g3-mailboxes, g3-tasks-sms, g5-pipeline, g5-agency, g5-billing |
| `webhooks.subscribe` | foundation | g5-crm |
| `campaign_accounts`, `campaign_leads.account_id/contacted_at`, `lead_connections`, global `advanceFreeSteps`, `chooseSender` pattern | g1-rotation | g1-abtest (stats by sending account), g3-mailboxes (same pinning pattern for mailboxes), g5-agency overview |
| `activity.node_id/variant`, `nodeVariants()`, `assignVariant()` | g1-abtest | g1-sources (inmail variants), g2-ai-writer (writer creates variants; AI vars read the chosen variant), g3 (email/sms variants) |
| `ACTION_TYPES += inmail`, `scrape` budget, `leads.import` job | g1-sources | g4 (`autoEnrich` after imports), g5-billing (none) |
| `ai` provider kind, prompts, simulated-output rule | g2-ai-writer | g2-ai-replies (classifier/suggest), g4 (none), g5-billing (AI credits) |
| `handleInboundReply`, `stopCampaignLead`, `stopLeadEverywhere`, `campaign_leads.hold_reason`, categories | g2-ai-replies | g3-mailboxes, g3-tasks-sms (holds for tasks, STOP), g4 (`enrich` hold), g5-pipeline (stage hooks, suggested stage), g5-crm (`lead.classified`) |
| `mailboxes`, `Mailer` v2, `PUBLIC_URL` token signing, `leads.email_status` | g3-mailboxes | g4 (email_status values, invalid on bounce), g5-agency (system mail is separate: `SMTP_URL`), g5-billing (mailbox limit) |
| `tasks`, Twilio provider | g3-tasks-sms | g5-pipeline (timeline, meeting outcome), g5-crm (none) |
| `email_source`, enrichment settings, `find_email` | g4-data | g5-crm (field mapping can include enrichment fields) |
| stages, `lead.stage_changed`, `setStage/autoAdvance`, lead timeline | g5-pipeline | g5-agency (overview "meetings", client board), g5-crm (triggers) |
| memberships, active workspace, `client` role allowlist, `parent_id` | g5-agency | g5-billing (billing root, seat counting), g5-crm (none) |

Rules so steps do not conflict:

- **Sequence schema**: each step adds node types/condition kinds to the zod union and the web `SeqNode` union; never
  change existing fields. Builder palette entries are appended in their group.
- **Engine**: only g1-rotation restructures `tick()`/`dueJobs`/`advanceFreeSteps`. Later steps add runners
  (`this.mail`, `this.messaging`), node handling in `walk()`/`perform()`, and node families in the constants; they do
  not change rotation logic. Any new "lead stops" path must call `stopCampaignLead`.
- **Campaign settings** (`CampaignSettingsSchema`) gain keys with defaults: `aiVariables` (g2w), `continueOnCategories`
  (g2r), `trackOpens`/`trackClicks` (g3m). Old settings JSON must parse unchanged.
- **Campaign create/patch** gains `accountIds` (g1r) and `mailboxIds` (g3m) using the same validation helper.
- **`publicLead()`/`serializeLead()`** only gain fields.
- **Seed** (`seed.ts`) stays working after each step: use `setCampaignAccounts`, create default stages, insert the
  owner's `memberships` row (g5-agency), and (optional) a simulated mailbox so the demo shows the new features.
- If a step that owns a shared primitive was rolled back, the next step that needs it adds the primitive in its own
  migration (same SQL as in this plan) and updates the ownership table above.
- **Migration column dependencies** (the cases where that matters): M8's `conversations_phone_thread` index uses
  `conversations.mailbox_id` (M7); M9's `leads_email_status` index uses `leads.email_status` (M7); g1-abtest's
  accepted-rate code reads `lead_connections` (M2; fall back to `leads.connected_at` without it); M10's backfill only
  reads core tables. Each such SQL entry carries a comment naming the dependency.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Rotation refactor breaks core scheduling | g1-rotation keeps every existing engine test green with only `makeCampaign` changed; new tests cover limits per account; `chooseSender` is pure-ish and unit-tested. |
| Conversations rebuild loses data | Done once, early (foundation), on a known schema; migration test at `migrateTo: 1` checks rows and FK cascades. |
| Migration index drift after a rollback | Labels, not indices, identify steps; append-only; tests use `:memory:`. |
| Simulated/fake data reaching real people | "Simulated output never reaches a real recipient" rule with tests (AI fallback on real accounts, `.example` emails refused by real mailboxes). |
| LinkedIn restrictions from new actions/scraping | Every action in `ACTION_TYPES` with conservative defaults and warm-up; scrape budget; working hours; cool-downs; honest README. |
| Email compliance (CAN-SPAM/GDPR) | Unsubscribe link + one-click header on every campaign email, suppression across channels, tracking off by default, `PUBLIC_URL` required for real mailboxes. |
| Prompt injection via lead profiles or replies | Delimited data blocks, structured outputs validated with zod, AI never triggers sending; suppression requires confidence ≥ 0.7. |
| Secrets leaking | Sealed columns, `mask()`, no secrets in errors/logs, tests assert absence in responses. |
| Client role bypass | Allowlist hook keyed on route patterns + generic test over all registered routes. |
| Duplicate sends when engine ticks overlap (`setInterval`) | Busy guards per account / mailbox / workspace runner; job in-flight count; tests with two concurrent ticks. |
| Stale agency access after an admin leaves | Client-workspace rights are inherited from the agency membership at request time, never copied. |
| SSRF / token leaks through user-supplied provider hosts | URL and hostname validation, `redirect: 'error'`, secret scrubbing, private-address block in hosted (billing) mode. |
| Public endpoints abuse | HMAC-signed tokens (unsubscribe, tracking, invites hashed), Twilio and Stripe signature verification, signed click URLs (no open redirect). |
| Webhooks/proxies change URLs (Twilio signature mismatch) | Signatures are computed against `PUBLIC_URL`, not the request host. |
| External API drift (Hunter, Apollo, HubSpot, Pipedrive, Twilio, Stripe) | One module per vendor with doc links and fakes in tests; errors mapped to clear messages; README marks them as "tested against fakes". |
| SQLite write contention as jobs grow | Jobs are short; claim is one statement; long provider calls run outside transactions; `busy_timeout` already set. |
| Sync Postgres facade blocks the event loop | Single small queries; documented; leader lock limits engine work to one instance; async conversion remains possible later because all SQL already goes through `Database`. |
| Postgres behaviour differences (NULL ordering, LIKE case, int8 strings, folded aliases, booleans) | Portable SQL subset from foundation on; translator + type parsers; full test suite runnable on Postgres. |

**Keeping SQLite identical until (and after) the postgres step**: nothing before the postgres step depends on a
second dialect; steps only follow the portable subset (2.2), which is plain SQLite. The postgres step changes no
SQLite behaviour: its source edits are dialect-neutral rewrites with identical results, and its translator and worker
run only when `DATABASE_URL` is set. The SQLite test suite must pass unchanged at every step.

---

## 7. Reference

**Job types**: `leads.import` (g1s), `ai.personalize` (g2w), `ai.classify` (g2r), `email.sync` (g3m), `enrich.lead` (g4),
`invite.email` (g5a), `crm.sync` (g5c).

**New activity types**: `inmail` (g1s), `ab_winner` (g1a), `ai_personalize` (g2w), `classified` (g2r), `email` with
`mailbox_id`, `email_open`, `email_click`, `email_bounce` (g3m), `sms`, `whatsapp`, `task_created`, `task_done`,
`task_skipped` (g3t), `enrich` (g4). Only `ACTION_TYPES` count against LinkedIn limits.

**Node types / conditions added**: `inmail`, `is_open_profile` (g1s); variants on `connect`/`message`/`email`/`inmail`/`sms` (g1a);
`reply_sentiment` (g2r); `task`, `sms`, `whatsapp` (g3t); `find_email`, `email_verified` (g4). Email node `replyInThread` (g3m).

**Limits keys** (`DEFAULT_LIMITS`): existing + `inmail: 10`, `scrape: 1000` (g1s). Mailbox and SMS limits live on the
mailbox / integration settings.

**Nav entries**: Pipeline (g5p), Tasks (g3t), Mailboxes (g3m), Agency (g5a), Billing (g5b); Settings tabs:
Integrations (foundation), Pipeline (g5p).

---

## 8. Review changes

Changes from the review of this plan against the codebase and the step specs (before any step was built):

1. **Foundation scope matches the spec**: foundation now writes every kind's interface plus a simulated provider
   (the spec asks for this; the old plan registered nothing, so the Integrations page had nothing to show). Shared UI
   components are added by the step that first uses them, so there are no unused components.
2. **`crm` has no simulated fallback** (2.3). Without this, every workspace would have queued CRM sync jobs against a fake CRM.
3. **Job queue under overlapping ticks** (2.4): concurrency is counted against in-flight jobs. `progress()` keeps long
   jobs' locks alive, and orphan recovery never re-queues a job still running in this process (a 1000-profile import
   used to be re-run after 10 minutes). Dedupe-while-running is documented, and retry with a live duplicate key gives 409.
4. **Double sends** (2.10): mail and messaging runners get busy guards like `Engine.busy`. Held leads re-hold on
   spurious wake-ups (`reconcile()` wakes everyone). `FREE_STEPS_PER_TICK` is raised now that free steps are global.
5. **Ordering fixes**: the form-urlencoded parser moved from g3-tasks-sms to foundation (g3-mailboxes needs it first).
   g3-mailboxes no longer reads `leads.email_source` (it arrives in g4) and blocks reserved test domains instead.
   Migration column dependencies are listed in section 5.
6. **g1-rotation correctness**:
   - Sync no longer skips leads already connected through another account.
   - `leads.connection_status` is an aggregate, so withdrawing A's invite can't hide B's connection.
   - Account deletion no longer pauses multi-sender campaigns.
   - Contacted leads of a removed sender stay with it.
7. **g1-abtest**: variants removed by an edit are reassigned.
8. **LinkedIn safety (g1-sources)**: an import waits for the account's `next_action_at`, so it never runs right after
   an action, and it keeps its lock alive while scraping.
9. **g2-ai-writer**:
   - AI variables are generated for the start node and for variables added later (prefetch only ran from `moveTo`).
   - Pending variables with no live job are re-enqueued.
   - Waiting on AI no longer idles the sender.
10. **g2-ai-replies**: the step adds suppression list/undo routes and UI, because automatic suppression can be wrong,
    and gives concrete confidence values for the keyword classifier.
11. **g3-mailboxes**:
    - Migrated legacy SMTP mailboxes keep today's sending behaviour: no surprise warm-up, same limit and schedule.
    - Daily usage has a single source.
    - `Mailer.verify` keeps tests off the network.
    - Unsubscribe GET never unsubscribes.
    - `start` refuses LinkedIn steps with no LinkedIn account.
12. **g3-tasks-sms security and consistency**:
    - The simulated SMS provider's "test signature" backdoor is gone; inbound Twilio requests need a real `twilio` integration.
    - STOP/START now act on the same suppression rows.
    - Phone matching is defined.
    - Open tasks are not duplicated on wake-up.
13. **g4-data**: enrichment job dedupe is per run, so overlapping bulk runs finish instead of hanging in `running`.
    Profile-view emails are tagged `linkedin`.
14. **g5-pipeline**: stages are ensured lazily (workspaces created by `seed.ts`/`makeWorld` had none), and `ownerId` is
    validated as a member.
15. **g5-agency security**:
    - Agency rights in client workspaces are inherited, not copied, so a removed agency admin loses access.
    - Every user-creation path (register, team, invite, seed) inserts a membership.
    - `deleteWorkspace` cleans the tables that have no foreign key.
    - Invite password acceptance is throttled and single-use.
    - The client dashboard no longer calls the denied `/api/accounts`.
    - `/api/branding` reads the session itself.
16. **g5-billing**: the routes act on the billing root and need its owner. The webhook refuses to run without a
    signing secret. Checkout needs `PUBLIC_URL`.
17. **Provider security** (2.3, 2.6):
    - `httpJson` scrubs secrets from error messages and refuses redirects.
    - `baseUrl`, `companyDomain` and mail hosts are validated, with private addresses blocked in hosted mode.
    - Absolute links never come from the `Host` header.
    - The jobs API never exposes system jobs or payloads.
18. **postgres**:
    - `insert()` only appends `RETURNING id` when the table has an `id` column (`sessions` would have broken).
    - `index.ts` and `buildContext` both go through `openDatabase`.
    - Losing the advisory lock on reconnect demotes the instance to standby.
    - Untyped parameters are cast at the source.
19. Smaller: `migrateTo` semantics defined, `makeApi` no longer requires editing `api.test.ts`, SQLite-only tests skip
    on Postgres, and seed inserts memberships.

# Changelog

All notable changes to OpenReach. Dates are when the work landed on its branch.

## Premium (unreleased, `premium` branch)

Every external service below is optional. Without keys, a built-in simulator stands in, so the app runs, builds and passes its tests offline. API keys are entered per workspace under **Settings → Integrations** and stored encrypted. Vendor integrations follow the vendors' public API docs and are tested against fakes, not the live services; see *Limitations* in the README.

### LinkedIn

- **Sender rotation:** one campaign can send from several LinkedIn accounts. New leads go to the account with the most room left today (or the one they're already connected to) and stay with it; each account keeps its own limits, hours, warm-up and delays. Leads an account hadn't contacted move to the others when it is paused, logged out or removed; leads already connected to it (or invited by it) wait for it instead. Results per sender.
- **A/B testing:** 2 to 5 variants for invitation notes, messages, InMails, emails and SMS, with stable per-lead assignment, per-variant stats, a *Leading* marker once the gap is statistically clear, and manual or automatic winners.
- **New lead sources:** import the people who reacted to or commented on a post, an event's attendees and a group's members, with live progress, cancelling, per-account daily import limits and deduplication.
- **InMail steps** (from the profile or from Sales Navigator) with a subject, their own daily limit and credit handling (open profiles are free); already-connected leads get a normal message instead.
- New branches: *has an open profile*, *email verified*, *reply is…*.

### AI

- Anthropic (Claude) and any OpenAI-compatible API (OpenAI, OpenRouter, Ollama, LM Studio, ...).
- **Local models (Ollama, llama.cpp, LM Studio):** the OpenAI-compatible provider has three optional settings: a request timeout (60 s by default, up to 600 s for slow laptop CPUs), *Turn off model thinking* (`reasoning_effort: "none"` plus `chat_template_kwargs.enable_thinking: false`, so thinking models such as Qwen3.5 don't spend the 200-token classification budget reasoning) and *JSON mode for classification* (`response_format: json_object`). A server that refuses these optional parameters (400/422) is asked again with each on its own, then with neither, and what it refused is remembered; the host check runs before every attempt. Hosted installs cap the timeout at 60 s. `<think>` blocks left in answers are removed, an empty answer from a model that ran out of tokens thinking says how to fix it, a timeout says to raise the timeout, and *Test connection* checks the classification model name too (treating `name` and `name:latest` as the same). AI jobs now allow 11 minutes without progress (was 2 for classification, 5 for personalization). The README has an Ollama recipe for an 8 GB Windows laptop. Loopback stays allowed on self-hosted installs and refused on hosted ones.
- *Write with AI* drafts 1 to 5 versions of a step's text from a short brief; insert one or use them as A/B variants.
- `{{ai:name}}` variables: per-lead lines written in the background, cached, previewed on a real lead, with a fallback when writing fails or is slow (`AI_WAIT_MAX_MIN`).
- Reply classification (interested, meeting booked, question, not now, not interested, out of office, wrong person, unsubscribe, other) with inbox filters, manual correction and *Suggest reply*. Clear opt-outs go on a workspace-wide do-not-contact list.
- Campaigns can keep going after chosen kinds of reply (`REPLY_HOLD_MIN`).

### Email

- **Mailboxes** (Gmail, Microsoft 365 or any SMTP/IMAP server with app passwords): daily limits with a warm-up ramp, sending windows, random gaps, signatures, rotation across mailboxes, replies in the same thread.
- Unsubscribe link and one-click `List-Unsubscribe` headers on every campaign email; reply and bounce detection over IMAP (out-of-office and other automatic answers show in the thread but don't count as replies); DNS deliverability check (MX, SPF, DKIM, DMARC); optional open and click tracking, off by default.
- Email finding (Hunter, Apollo) and verification (Hunter, ZeroBounce, NeverBounce) in an ordered waterfall, per-lead email status and source, *Find email* step, automatic lookup after imports, Apollo company enrichment, monthly usage per provider.
- A CSV import over 10,000 leads with *Find emails* on is looked up in several runs of up to 10,000, so no imported lead is left out.
- **Company website enricher (free, no key):** reads a company's homepage (and its About page when the homepage says little) for the name, description, logo, social profiles and, when published, founding year, size and address from meta tags, OpenGraph and schema.org JSON-LD, then Wikidata (by official website, P856) for industry, employees, founding year, headquarters and LinkedIn id. Honours `robots.txt`, identifies itself as `OpenReachBot`, keeps to about 1 request a second per site and to Wikidata, caches results, and guards every fetch (public hosts only, connections pinned to the checked addresses, default ports, no credentials, up to 4 checked redirects, 10 s per request and 30 s per site, 1 MB cap, linear-time parsing) on every installation. Ignores redirects to other sites, ISP and webmail domains, and email domains that plainly aren't the lead's company. Costs no credits, also on hosted plans, where each billing root gets 2,000 lookups a day and a share of the Wikidata rate. The lead drawer now also shows *Headquarters* and *About* company facts.

### Multichannel

- **Manual task** steps (call, LinkedIn by hand, email by hand, other) with due times, assignees, auto-skip, call outcomes and a **Tasks** page.
- **SMS and WhatsApp** steps through Twilio with daily limits and sending hours, replies through a signed webhook into the inbox, automatic STOP/START handling.

### CRM and pipeline

- Pipeline stages (editable), automatic forward-only stage moves, a drag-and-drop board with a keyboard-accessible *Move to* menu, owners, colored tags, notes and a lead timeline.
- One-way sync to **HubSpot** and **Pipedrive**: contacts with a field mapping, notes for replies and other events, optional deals at a chosen stage, a sync log with retries.
- New webhook events: `lead.classified`, `lead.stage_changed`, `lead.enriched`.
- Bulk stage moves (the bulk edit, deleting a stage) run as a few statements and send one `leads.stage_changed` webhook with the count and lead ids, instead of one `lead.stage_changed` per lead.
- Lead CSV export: custom fields come out as `custom_<name>` columns (importing the file restores their names), and cells starting with `=`, `+`, `-` or `@` get a leading `'` so spreadsheets show them as text instead of running them.

### Teams, agencies and hosting

- People can belong to several workspaces and switch between them; invites by link or email (`SMTP_URL`, `MAIL_FROM`).
- **Agency mode:** client workspaces with an overview page, a read-only *Client* role, and white-label branding (product name, logo, color, support email, custom domain via `PUBLIC_URL`, `CUSTOM_DOMAINS` and `TRUST_PROXY`).
- **Plans and Stripe billing** for hosted installs (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BILLING_PLANS` / `BILLING_PLANS_FILE`): Checkout, Customer Portal, signed webhooks and limits on accounts, mailboxes, seats, clients and monthly AI and enrichment credits. Off, and unlimited, without a key.
- Saved secrets stay with their server: changing an integration's base URL, or an SMTP host, port or user, needs the key or password again; only admins change SMTP settings and send test webhooks. On hosted installs, webhook URLs must be public hosts too (no redirects followed).
- After a downgrade or cancellation, only the oldest LinkedIn accounts and mailboxes the plan allows keep sending; the others still read replies, show why, and start again after an upgrade.
- **Postgres** as an optional database (`DATABASE_URL`), with leader election so several instances can share it while one runs the engine.
- A database-backed job queue for background work (`JOB_CONCURRENCY`).
- Changing your password signs you out everywhere else; a tab left on another workspace after a switch catches up instead of acting there.

### Docs

- README: new features, configuration variables, setup guides for every integration, and privacy, consent and anti-spam notes for email and SMS.

## 0.1.0 (2026-10-30)

First public version: visual sequence builder, personalization, simulator and Playwright drivers, per-account safety limits and warm-up, unified inbox, analytics, team workspaces, blacklist, webhooks, CSV import and export, Docker and Render deploys.

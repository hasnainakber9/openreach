# Changelog

All notable changes to OpenReach. Dates are when the work landed on its branch.

## Premium (unreleased, `premium` branch)

Every external service below is optional. Without keys, a built-in simulator stands in, so the app runs, builds and passes its tests offline. API keys are entered per workspace under **Settings → Integrations** and stored encrypted. Vendor integrations follow the vendors' public API docs and are tested against fakes, not the live services; see *Limitations* in the README.

### LinkedIn

- **Sender rotation:** one campaign can send from several LinkedIn accounts. New leads go to the account with the most room left today (or the one they're already connected to) and stay with it; each account keeps its own limits, hours, warm-up and delays. Leads an account hadn't contacted move to the others when it is paused, logged out or removed. Results per sender.
- **A/B testing:** 2 to 5 variants for invitation notes, messages, InMails, emails and SMS, with stable per-lead assignment, per-variant stats, a *Leading* marker once the gap is statistically clear, and manual or automatic winners.
- **New lead sources:** import the people who reacted to or commented on a post, an event's attendees and a group's members, with live progress, cancelling, per-account daily import limits and deduplication.
- **InMail steps** (from the profile or from Sales Navigator) with a subject, their own daily limit and credit handling (open profiles are free); already-connected leads get a normal message instead.
- New branches: *has an open profile*, *email verified*, *reply is…*.

### AI

- Anthropic (Claude) and any OpenAI-compatible API (OpenAI, OpenRouter, Ollama, LM Studio, ...).
- *Write with AI* drafts 1 to 5 versions of a step's text from a short brief; insert one or use them as A/B variants.
- `{{ai:name}}` variables: per-lead lines written in the background, cached, previewed on a real lead, with a fallback when writing fails or is slow (`AI_WAIT_MAX_MIN`).
- Reply classification (interested, meeting booked, question, not now, not interested, out of office, wrong person, unsubscribe, other) with inbox filters, manual correction and *Suggest reply*. Clear opt-outs go on a workspace-wide do-not-contact list.
- Campaigns can keep going after chosen kinds of reply (`REPLY_HOLD_MIN`).

### Email

- **Mailboxes** (Gmail, Microsoft 365 or any SMTP/IMAP server with app passwords): daily limits with a warm-up ramp, sending windows, random gaps, signatures, rotation across mailboxes, replies in the same thread.
- Unsubscribe link and one-click `List-Unsubscribe` headers on every campaign email; reply and bounce detection over IMAP; DNS deliverability check (MX, SPF, DKIM, DMARC); optional open and click tracking, off by default.
- Email finding (Hunter, Apollo) and verification (Hunter, ZeroBounce, NeverBounce) in an ordered waterfall, per-lead email status and source, *Find email* step, automatic lookup after imports, Apollo company enrichment, monthly usage per provider.

### Multichannel

- **Manual task** steps (call, LinkedIn by hand, email by hand, other) with due times, assignees, auto-skip, call outcomes and a **Tasks** page.
- **SMS and WhatsApp** steps through Twilio with daily limits and sending hours, replies through a signed webhook into the inbox, automatic STOP/START handling.

### CRM and pipeline

- Pipeline stages (editable), automatic forward-only stage moves, a drag-and-drop board with a keyboard-accessible *Move to* menu, owners, colored tags, notes and a lead timeline.
- One-way sync to **HubSpot** and **Pipedrive**: contacts with a field mapping, notes for replies and other events, optional deals at a chosen stage, a sync log with retries.
- New webhook events: `lead.classified`, `lead.stage_changed`, `lead.enriched`.

### Teams, agencies and hosting

- People can belong to several workspaces and switch between them; invites by link or email (`SMTP_URL`, `MAIL_FROM`).
- **Agency mode:** client workspaces with an overview page, a read-only *Client* role, and white-label branding (product name, logo, color, support email, custom domain via `PUBLIC_URL`, `CUSTOM_DOMAINS` and `TRUST_PROXY`).
- **Plans and Stripe billing** for hosted installs (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BILLING_PLANS` / `BILLING_PLANS_FILE`): Checkout, Customer Portal, signed webhooks and limits on accounts, mailboxes, seats, clients and monthly AI and enrichment credits. Off, and unlimited, without a key.
- **Postgres** as an optional database (`DATABASE_URL`), with leader election so several instances can share it while one runs the engine.
- A database-backed job queue for background work (`JOB_CONCURRENCY`).
- Changing your password signs you out everywhere else; a tab left on another workspace after a switch catches up instead of acting there.

### Docs

- README: new features, configuration variables, setup guides for every integration, and privacy, consent and anti-spam notes for email and SMS.

## 0.1.0 (2026-10-30)

First public version: visual sequence builder, personalization, simulator and Playwright drivers, per-account safety limits and warm-up, unified inbox, analytics, team workspaces, blacklist, webhooks, CSV import and export, Docker and Render deploys.

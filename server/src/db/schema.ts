// Each entry runs once, in order; the index is stored in the `migrations` table.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE workspaces (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  -- A LinkedIn seat that campaigns run from.
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    driver TEXT NOT NULL DEFAULT 'simulator',
    status TEXT NOT NULL DEFAULT 'active',
    status_message TEXT,
    session_enc TEXT,
    proxy_url TEXT,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    work_days TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
    work_start TEXT NOT NULL DEFAULT '09:00',
    work_end TEXT NOT NULL DEFAULT '18:00',
    limits TEXT NOT NULL DEFAULT '{}',
    delay_min_sec INTEGER NOT NULL DEFAULT 60,
    delay_max_sec INTEGER NOT NULL DEFAULT 240,
    warmup INTEGER NOT NULL DEFAULT 1,
    smtp_enc TEXT,
    cooldowns TEXT NOT NULL DEFAULT '{}',
    linkedin_name TEXT,
    linkedin_url TEXT,
    next_action_at INTEGER NOT NULL DEFAULT 0,
    last_sync_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE lead_lists (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE leads (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    list_id INTEGER REFERENCES lead_lists(id) ON DELETE SET NULL,
    public_id TEXT NOT NULL,
    profile_url TEXT NOT NULL,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    headline TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    email TEXT,
    phone TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    custom TEXT NOT NULL DEFAULT '{}',
    connection_status TEXT NOT NULL DEFAULT 'none',
    connected_at INTEGER,
    replied_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (workspace_id, public_id)
  );
  CREATE INDEX leads_list ON leads(list_id);

  CREATE TABLE blacklist (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (workspace_id, kind, value)
  );

  CREATE TABLE campaigns (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    sequence TEXT NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    started_at INTEGER
  );

  -- One lead's progress through one campaign's sequence.
  CREATE TABLE campaign_leads (
    id INTEGER PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'active',
    node_id TEXT,
    node_type TEXT,
    node_entered_at INTEGER NOT NULL,
    next_run_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    added_at INTEGER NOT NULL,
    finished_at INTEGER,
    UNIQUE (campaign_id, lead_id)
  );
  CREATE INDEX campaign_leads_due ON campaign_leads(state, next_run_at);
  CREATE INDEX campaign_leads_lead ON campaign_leads(lead_id);

  -- Everything that happened: actions taken (counted against limits) and events seen.
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL,
    account_id INTEGER,
    campaign_id INTEGER,
    lead_id INTEGER,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    detail TEXT,
    day TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX activity_account_day ON activity(account_id, day, type);
  CREATE INDEX activity_campaign ON activity(campaign_id, type);
  CREATE INDEX activity_lead ON activity(lead_id);

  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    thread_id TEXT NOT NULL,
    participant_name TEXT NOT NULL DEFAULT '',
    participant_url TEXT NOT NULL DEFAULT '',
    last_message_at INTEGER NOT NULL DEFAULT 0,
    unread INTEGER NOT NULL DEFAULT 0,
    UNIQUE (account_id, thread_id)
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    body TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    UNIQUE (conversation_id, external_id)
  );

  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    events TEXT NOT NULL,
    secret TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    last_status TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE imports (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL,
    list_id INTEGER NOT NULL,
    account_id INTEGER,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    found INTEGER NOT NULL DEFAULT 0,
    added INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL
  );

  -- State of the simulated LinkedIn network (driver = 'simulator' only).
  CREATE TABLE sim_people (
    account_id INTEGER NOT NULL,
    public_id TEXT NOT NULL,
    invite_sent_at INTEGER,
    accept_at INTEGER,
    connected INTEGER NOT NULL DEFAULT 0,
    reply_at INTEGER,
    replied INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, public_id)
  );
  `,
  // [M1] foundation: job queue, integrations, usage, workspace settings, suppressions, channel-agnostic conversations
  `
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    run_at INTEGER NOT NULL,
    dedupe_key TEXT,
    locked_until INTEGER,
    progress TEXT,
    result TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX jobs_due ON jobs(status, run_at);
  CREATE INDEX jobs_workspace ON jobs(workspace_id, type, status);
  -- One live job per dedupe key; finished jobs keep their key for history.
  CREATE UNIQUE INDEX jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

  -- Per-workspace external service configs. Secrets live sealed in credentials_enc.
  CREATE TABLE integrations (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    provider TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    credentials_enc TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    last_status TEXT,
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
    operation TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL DEFAULT 1,
    month TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX usage_events_month ON usage_events(workspace_id, month, kind);

  CREATE TABLE workspace_settings (
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, name)
  );

  -- Identities that must never be contacted again (unsubscribe, STOP, not interested, manual).
  CREATE TABLE suppressions (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    reason TEXT NOT NULL,
    source TEXT,
    lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (workspace_id, kind, value)
  );

  -- Conversations become channel-agnostic: email/SMS threads have no LinkedIn account.
  -- Rebuilt together with messages so foreign keys stay valid while foreign_keys = ON.
  CREATE TABLE conversations_new (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL,
    channel TEXT NOT NULL DEFAULT 'linkedin',
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
  -- Renaming also rewrites messages_new's REFERENCES clause.
  ALTER TABLE conversations_new RENAME TO conversations;
  ALTER TABLE messages_new RENAME TO messages;
  CREATE INDEX conversations_workspace ON conversations(workspace_id, last_message_at);
  CREATE INDEX conversations_lead ON conversations(lead_id);
  `,
  // [M2] g1-rotation: several sender accounts per campaign, per-lead sender pinning, per-account connections
  `
  CREATE TABLE campaign_accounts (
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, account_id)
  );
  CREATE INDEX campaign_accounts_account ON campaign_accounts(account_id);
  INSERT INTO campaign_accounts (campaign_id, account_id, created_at)
    SELECT id, account_id, created_at FROM campaigns WHERE account_id IN (SELECT id FROM accounts);

  -- The sender a lead is pinned to, and when it was first contacted (pinned + contacted = never moves).
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
    status TEXT NOT NULL,
    connected_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (lead_id, account_id)
  );
  CREATE INDEX lead_connections_account ON lead_connections(account_id, status);
  -- Credit the aggregate to the account that last invited/messaged the lead, else to the one whose
  -- profile view saw the 1st-degree badge (the old way a lead became connected).
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
  `,
  // [M3] g1-abtest: message variants, per-lead assignment, per-step winners
  `
  ALTER TABLE activity ADD COLUMN node_id TEXT;
  ALTER TABLE activity ADD COLUMN variant TEXT;
  CREATE INDEX activity_campaign_node ON activity(campaign_id, node_id, variant);
  -- The variant a lead got at a step; fixed once assigned so retries send the same text.
  CREATE TABLE campaign_lead_variants (
    campaign_lead_id INTEGER NOT NULL REFERENCES campaign_leads(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    variant TEXT NOT NULL,
    assigned_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_lead_id, node_id)
  );
  -- Kept outside the sequence JSON so saving the builder's draft never overwrites a winner.
  CREATE TABLE campaign_node_winners (
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    variant TEXT NOT NULL,
    decided_by TEXT NOT NULL,
    decided_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, node_id)
  );
  `,
  // [M3b] g1-abtest follow-up: a winner row with a NULL variant records "split again" (it stops auto-pick),
  // and a variant's results only count sends made since its text last changed.
  `
  CREATE TABLE campaign_node_winners_new (
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    variant TEXT,
    decided_by TEXT NOT NULL,
    decided_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, node_id)
  );
  INSERT INTO campaign_node_winners_new SELECT campaign_id, node_id, variant, decided_by, decided_at FROM campaign_node_winners;
  DROP TABLE campaign_node_winners;
  ALTER TABLE campaign_node_winners_new RENAME TO campaign_node_winners;
  -- When a variant letter was (re)introduced or its text edited; earlier sends under that letter are a different text.
  CREATE TABLE campaign_variant_starts (
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    variant TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, node_id, variant)
  );
  `,
  // [M4] g1-sources: post/event/group imports on the job queue, per-account scrape budget, open profiles
  `
  ALTER TABLE imports ADD COLUMN kind TEXT NOT NULL DEFAULT 'search';
  ALTER TABLE imports ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE imports ADD COLUMN job_id INTEGER;
  -- The account's local day the scrape ran on: today's rows make up its daily scrape budget.
  ALTER TABLE imports ADD COLUMN day TEXT;
  ALTER TABLE imports ADD COLUMN duplicates INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE imports ADD COLUMN blacklisted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE imports ADD COLUMN note TEXT;
  ALTER TABLE imports ADD COLUMN finished_at INTEGER;
  CREATE INDEX imports_account_day ON imports(account_id, day);
  -- NULL until a profile view tells; 1 when anyone may InMail the member without using a credit.
  ALTER TABLE leads ADD COLUMN open_profile INTEGER;
  `,
  // [M4b] g1-sources follow-up: profiles an import loaded on `day`, summed over all its attempts. `found` is
  // the current attempt's progress and restarts with a retry; the daily scrape budget must not.
  `
  ALTER TABLE imports ADD COLUMN scraped INTEGER NOT NULL DEFAULT 0;
  UPDATE imports SET scraped = found WHERE day IS NOT NULL;
  `,
  // [M5] g2-ai-writer: AI personalization values per campaign lead, generated by the ai.personalize job
  `
  CREATE TABLE campaign_lead_ai (
    campaign_lead_id INTEGER NOT NULL REFERENCES campaign_leads(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- Hash of the variable's instruction and length: a changed definition regenerates the value.
    instruction_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    value TEXT,
    error TEXT,
    simulated INTEGER NOT NULL DEFAULT 0,
    requested_at INTEGER NOT NULL,
    generated_at INTEGER,
    PRIMARY KEY (campaign_lead_id, name)
  );
  `,
  // [M6] g2-ai-replies: reply categories on messages, conversations and leads; campaign lead holds
  `
  ALTER TABLE messages ADD COLUMN category TEXT;
  ALTER TABLE messages ADD COLUMN confidence REAL;
  ALTER TABLE conversations ADD COLUMN category TEXT;
  ALTER TABLE conversations ADD COLUMN category_confidence REAL;
  -- ai | manual
  ALTER TABLE conversations ADD COLUMN category_source TEXT;
  ALTER TABLE conversations ADD COLUMN classified_at INTEGER;
  CREATE INDEX conversations_category ON conversations(workspace_id, category);
  ALTER TABLE leads ADD COLUMN reply_category TEXT;
  ALTER TABLE leads ADD COLUMN reply_category_at INTEGER;
  -- What an active lead is waiting on (reply | task | enrich); next_run_at is then the hold's deadline.
  ALTER TABLE campaign_leads ADD COLUMN hold_reason TEXT;
  `,
  // [M7] g3-mailboxes: mailboxes, campaign mailboxes, email messages, email conversations, email status
  `
  CREATE TABLE mailboxes (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- smtp | simulated
    provider TEXT NOT NULL DEFAULT 'smtp',
    -- gmail | outlook | custom (fills host/port in the UI)
    preset TEXT NOT NULL DEFAULT 'custom',
    from_name TEXT NOT NULL DEFAULT '',
    from_email TEXT NOT NULL DEFAULT '',
    reply_to TEXT,
    signature TEXT NOT NULL DEFAULT '',
    -- sealed { host, port, secure, user, pass }
    smtp_enc TEXT,
    imap_enc TEXT,
    -- active | paused | needs_attention
    status TEXT NOT NULL DEFAULT 'active',
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
    -- The LinkedIn account whose SMTP settings this mailbox was migrated from.
    legacy_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX mailboxes_workspace ON mailboxes(workspace_id);
  CREATE UNIQUE INDEX mailboxes_legacy ON mailboxes(legacy_account_id) WHERE legacy_account_id IS NOT NULL;

  CREATE TABLE campaign_mailboxes (
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, mailbox_id)
  );
  CREATE INDEX campaign_mailboxes_mailbox ON campaign_mailboxes(mailbox_id);
  -- The mailbox a lead's email steps go out from (pinned like the LinkedIn sender).
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
    -- out | in
    direction TEXT NOT NULL,
    message_id TEXT NOT NULL,
    in_reply_to TEXT,
    -- References header, space-separated
    refs TEXT,
    subject TEXT NOT NULL DEFAULT '',
    from_email TEXT NOT NULL DEFAULT '',
    to_email TEXT NOT NULL DEFAULT '',
    -- sending | sent | simulated | failed | bounced | received
    status TEXT NOT NULL,
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

  -- valid | risky | invalid | unknown (g4-data reuses these)
  ALTER TABLE leads ADD COLUMN email_status TEXT;
  ALTER TABLE leads ADD COLUMN email_status_reason TEXT;
  ALTER TABLE leads ADD COLUMN email_status_at INTEGER;
  ALTER TABLE activity ADD COLUMN mailbox_id INTEGER;
  CREATE INDEX activity_mailbox_day ON activity(mailbox_id, day, type);
  `,
  // [M8] g3-tasks-sms: manual/call tasks that hold a lead, SMS/WhatsApp conversations keyed by phone
  `
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
    campaign_lead_id INTEGER REFERENCES campaign_leads(id) ON DELETE CASCADE,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    node_id TEXT,
    -- call | manual_linkedin | manual_email | custom
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    -- open | done | skipped
    status TEXT NOT NULL DEFAULT 'open',
    due_at INTEGER NOT NULL,
    auto_skip_at INTEGER,
    -- connected | voicemail | no_answer | wrong_number | meeting_booked | not_interested | other
    outcome TEXT,
    notes TEXT,
    completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    completed_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX tasks_due ON tasks(workspace_id, status, due_at);
  CREATE INDEX tasks_assignee ON tasks(assignee_id, status, due_at);
  CREATE INDEX tasks_lead ON tasks(lead_id);
  -- One task per lead and sequence step, however often the lead is woken while it waits.
  CREATE UNIQUE INDEX tasks_step ON tasks(campaign_lead_id, node_id) WHERE campaign_lead_id IS NOT NULL;
  -- SMS/WhatsApp threads have neither a LinkedIn account nor a mailbox: one per workspace, channel and phone.
  -- Uses conversations.mailbox_id from M7.
  CREATE UNIQUE INDEX conversations_phone_thread ON conversations(workspace_id, channel, thread_id) WHERE account_id IS NULL AND mailbox_id IS NULL;
  -- SMS/WhatsApp daily limits count a workspace's sends per day.
  CREATE INDEX activity_workspace_day ON activity(workspace_id, day, type);
  `,
  // [M9] g4-data: email finding, verification and enrichment. The leads_email_status index uses
  // leads.email_status from M7.
  `
  -- user | csv | linkedin | hunter | apollo | simulated (NULL = entered before this step: treated as user)
  ALTER TABLE leads ADD COLUMN email_source TEXT;
  ALTER TABLE leads ADD COLUMN email_found_at INTEGER;
  ALTER TABLE leads ADD COLUMN company_domain TEXT;
  -- JSON: companySize, industry, website, ...
  ALTER TABLE leads ADD COLUMN enrichment TEXT NOT NULL DEFAULT '{}';
  -- queued | done | not_found | failed
  ALTER TABLE leads ADD COLUMN enrichment_status TEXT;
  ALTER TABLE leads ADD COLUMN enriched_at INTEGER;
  -- What the last finished attempt did ("find,verify,company"), so a repeat within minutes reuses it.
  ALTER TABLE leads ADD COLUMN enrichment_options TEXT;
  CREATE INDEX leads_email_status ON leads(workspace_id, email_status);
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
    -- running | done
    status TEXT NOT NULL DEFAULT 'running',
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX enrichment_runs_workspace ON enrichment_runs(workspace_id, id);
  `,
  // [M10] g5-pipeline: pipeline stages with history, lead owners, tag metadata, lead notes. Backfills use
  // leads.reply_category from M6.
  `
  CREATE TABLE pipeline_stages (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    -- new | contacted | replied | interested | meeting | won | lost | custom-xxxx (automation finds stages by slug)
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#64748b',
    position INTEGER NOT NULL,
    -- open | won | lost (automation never moves a lead out of won/lost)
    kind TEXT NOT NULL DEFAULT 'open',
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

  -- NULL = the workspace's first stage
  ALTER TABLE leads ADD COLUMN stage_id INTEGER REFERENCES pipeline_stages(id) ON DELETE SET NULL;
  ALTER TABLE leads ADD COLUMN stage_changed_at INTEGER;
  ALTER TABLE leads ADD COLUMN stage_manual INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE leads ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  CREATE INDEX leads_stage ON leads(workspace_id, stage_id);
  UPDATE leads SET stage_id = (SELECT s.id FROM pipeline_stages s WHERE s.workspace_id = leads.workspace_id AND s.slug = 'meeting') WHERE reply_category = 'meeting_booked';
  UPDATE leads SET stage_id = (SELECT s.id FROM pipeline_stages s WHERE s.workspace_id = leads.workspace_id AND s.slug = 'interested') WHERE stage_id IS NULL AND reply_category = 'interested';
  UPDATE leads SET stage_id = (SELECT s.id FROM pipeline_stages s WHERE s.workspace_id = leads.workspace_id AND s.slug = 'replied') WHERE stage_id IS NULL AND replied_at IS NOT NULL;
  UPDATE leads SET stage_id = (SELECT s.id FROM pipeline_stages s WHERE s.workspace_id = leads.workspace_id AND s.slug = 'contacted')
    WHERE stage_id IS NULL AND EXISTS (SELECT 1 FROM activity a WHERE a.lead_id = leads.id AND a.status = 'ok' AND a.type IN ('connect', 'message', 'email', 'inmail', 'sms', 'whatsapp'));

  CREATE TABLE lead_stage_history (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    -- No foreign keys: history outlives deleted stages.
    from_stage_id INTEGER,
    to_stage_id INTEGER,
    -- manual | auto | api
    source TEXT NOT NULL,
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
  `,
  // [M11] g5-agency: memberships (a user in several workspaces), active workspace per session, agency and
  // client workspaces, email invites, white-label branding. users.workspace_id stays as the "home" workspace.
  `
  CREATE TABLE memberships (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    -- owner | admin | member | client
    role TEXT NOT NULL DEFAULT 'member',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, workspace_id)
  );
  CREATE INDEX memberships_workspace ON memberships(workspace_id);
  INSERT INTO memberships (user_id, workspace_id, role, created_at) SELECT id, workspace_id, role, created_at FROM users WHERE workspace_id IN (SELECT id FROM workspaces);
  -- The session's active workspace; NULL = the user's home workspace.
  ALTER TABLE sessions ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE;
  -- standard | agency | client
  ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard';
  ALTER TABLE workspaces ADD COLUMN parent_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL;
  CREATE INDEX workspaces_parent ON workspaces(parent_id);

  CREATE TABLE invites (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    -- lower-cased
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    -- sha256 of the token; the token itself is never stored
    token_hash TEXT NOT NULL UNIQUE,
    invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    expires_at INTEGER NOT NULL,
    accepted_at INTEGER,
    accepted_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX invites_workspace ON invites(workspace_id, email);

  -- White-label settings of an agency (clients inherit them field by field and may override).
  CREATE TABLE branding (
    workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    product_name TEXT,
    logo_url TEXT,
    primary_color TEXT,
    support_email TEXT,
    -- lower-cased hostname, matched against the request's Host header
    custom_domain TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX branding_domain ON branding(custom_domain) WHERE custom_domain IS NOT NULL;
  `,
  // [M12] g5-crm: CRM records per lead (idempotent upserts), synced notes/deals, and the sync log. The log
  // keeps the job's ref so a failed sync can be retried with the same dedupe key.
  `
  CREATE TABLE crm_links (
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
    -- contact | deal
    object_type TEXT NOT NULL,
    external_id TEXT NOT NULL,
    synced_at INTEGER NOT NULL,
    PRIMARY KEY (lead_id, integration_id, object_type)
  );
  CREATE TABLE crm_items (
    integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
    -- message:<id> | activity:<id> | stage:<historyId> | finished:<campaignLeadId> | connected:<leadId>:<accountId>
    item_key TEXT NOT NULL,
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
    ref TEXT NOT NULL DEFAULT '',
    -- upsert_contact | add_note | create_deal
    operation TEXT NOT NULL,
    -- ok | error | skipped
    status TEXT NOT NULL,
    external_id TEXT,
    -- the error, or why an operation was skipped
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX crm_sync_log_ws ON crm_sync_log(workspace_id, created_at);
  -- Foreign-key children: without these, deleting leads or an integration scans the whole log per row.
  -- The lead index also serves the log's leadId filter and the "resolved" check.
  CREATE INDEX crm_sync_log_lead ON crm_sync_log(lead_id);
  CREATE INDEX crm_sync_log_integration ON crm_sync_log(integration_id, created_at);
  CREATE INDEX crm_links_integration ON crm_links(integration_id);
  `,
  // [M13] g5-billing: one subscription per billing root (a standalone or agency workspace; client workspaces
  // bill through their agency), and the Stripe events already handled, so redelivered events are ignored.
  `
  CREATE TABLE subscriptions (
    workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    plan_id TEXT,
    -- none | trialing | active | past_due | unpaid | canceled | incomplete | incomplete_expired | paused
    status TEXT NOT NULL DEFAULT 'none',
    current_period_end INTEGER,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    -- Stripe's event time (seconds) of the last status change, so events that arrive late are ignored
    last_event_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX subscriptions_customer ON subscriptions(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
  CREATE TABLE stripe_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );
  `,
  // [M13] g5-billing (review): the open Checkout session, expired before another one starts so two can't both
  // be paid, and a second live subscription seen for the workspace, so the owner is told to cancel one.
  `
  ALTER TABLE subscriptions ADD COLUMN checkout_session_id TEXT;
  ALTER TABLE subscriptions ADD COLUMN extra_subscription_id TEXT;
  `,
  // postgres (review): state that lived in one process's memory moves to the database, so several instances
  // sharing Postgres see it: failed sign-ins per email+IP, the workspace's checkout being started, and which
  // LinkedIn account is busy with an engine run (an instance taking over from a lost leader must wait for it).
  `
  CREATE TABLE login_failures (
    throttle_key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  ALTER TABLE subscriptions ADD COLUMN checkout_starting_until INTEGER;
  ALTER TABLE accounts ADD COLUMN busy_until INTEGER;
  `,
  // browser-login: where the account's LinkedIn session came from. 'pasted' (an li_at copied from another
  // browser) is put into the profile on every start; 'browser' (signed in inside the account's own browser
  // window) lives in the profile, which keeps it current, so it is never overwritten with the stored copy.
  `
  ALTER TABLE accounts ADD COLUMN session_origin TEXT;
  UPDATE accounts SET session_origin = 'pasted' WHERE session_enc IS NOT NULL;
  `,
];

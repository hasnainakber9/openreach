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
];

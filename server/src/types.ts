// Row shapes as stored in SQLite (JSON columns are still strings here).

export interface AccountRow {
  id: number;
  workspace_id: number;
  name: string;
  driver: 'simulator' | 'playwright';
  status: 'active' | 'paused' | 'needs_login' | 'error';
  status_message: string | null;
  session_enc: string | null;
  proxy_url: string | null;
  timezone: string;
  work_days: string;
  work_start: string;
  work_end: string;
  limits: string;
  delay_min_sec: number;
  delay_max_sec: number;
  warmup: number;
  smtp_enc: string | null;
  cooldowns: string;
  linkedin_name: string | null;
  linkedin_url: string | null;
  next_action_at: number;
  last_sync_at: number;
  created_at: number;
}

export interface LeadRow {
  id: number;
  workspace_id: number;
  list_id: number | null;
  public_id: string;
  profile_url: string;
  first_name: string;
  last_name: string;
  headline: string;
  title: string;
  company: string;
  location: string;
  email: string | null;
  phone: string | null;
  tags: string;
  custom: string;
  connection_status: 'none' | 'pending' | 'connected';
  connected_at: number | null;
  replied_at: number | null;
  created_at: number;
  // 1 when the member accepts free InMail from anyone, 0 when not, null until a profile view tells.
  open_profile: number | null;
}

export interface CampaignRow {
  id: number;
  workspace_id: number;
  account_id: number | null;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'completed';
  sequence: string;
  settings: string;
  created_at: number;
  started_at: number | null;
}

export type CampaignLeadState = 'active' | 'done' | 'replied' | 'failed' | 'skipped';

export interface CampaignLeadRow {
  id: number;
  campaign_id: number;
  lead_id: number;
  state: CampaignLeadState;
  node_id: string | null;
  node_type: string | null;
  node_entered_at: number;
  next_run_at: number;
  attempts: number;
  last_error: string | null;
  added_at: number;
  finished_at: number | null;
  // Sender this lead is pinned to (null until its first LinkedIn action is scheduled).
  account_id: number | null;
  contacted_at: number | null;
}

export type ConnectionStatus = LeadRow['connection_status'];

export type ImportKind = 'search' | 'post' | 'event' | 'group';

export interface ImportRow {
  id: number;
  workspace_id: number;
  list_id: number;
  account_id: number | null;
  kind: ImportKind;
  source: string; // the LinkedIn URL
  options: string; // JSON { limit, likers?, commenters? }
  status: 'running' | 'done' | 'failed';
  found: number;
  added: number;
  duplicates: number;
  blacklisted: number; // blacklisted or suppressed people that were left out
  error: string | null;
  note: string | null;
  job_id: number | null;
  day: string | null;
  scraped: number; // profiles loaded on `day` across all attempts (what the scrape budget counts)
  created_at: number;
  finished_at: number | null;
}

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
  // Category of the latest classified reply (ai/categories.ts), and when it was set.
  reply_category: string | null;
  reply_category_at: number | null;
  // valid | risky | invalid | unknown; 'invalid' (a bounce) makes email steps skip the lead.
  email_status: string | null;
  email_status_reason: string | null;
  email_status_at: number | null;
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
  // What the lead is waiting on ('reply': its reply to be classified); next_run_at is the deadline.
  hold_reason: string | null;
  // Mailbox the lead's email steps go out from (campaigns with mailboxes; null until its first email is scheduled).
  mailbox_id: number | null;
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

export interface MailboxRow {
  id: number;
  workspace_id: number;
  name: string;
  provider: 'smtp' | 'simulated';
  preset: 'gmail' | 'outlook' | 'custom';
  from_name: string;
  from_email: string;
  reply_to: string | null;
  signature: string;
  smtp_enc: string | null; // sealed { host, port, secure, user, pass }
  imap_enc: string | null;
  status: 'active' | 'paused' | 'needs_attention';
  status_message: string | null;
  timezone: string;
  work_days: string;
  work_start: string;
  work_end: string;
  daily_limit: number;
  warmup: number;
  warmup_days: number;
  warmup_start: number;
  gap_min_sec: number;
  gap_max_sec: number;
  next_send_at: number;
  imap_uid_validity: string | null;
  imap_last_uid: number;
  last_sync_at: number;
  legacy_account_id: number | null;
  created_at: number;
}

export type TaskStatus = 'open' | 'done' | 'skipped';

export interface TaskRow {
  id: number;
  workspace_id: number;
  campaign_id: number | null;
  campaign_lead_id: number | null;
  lead_id: number | null;
  node_id: string | null;
  kind: 'call' | 'manual_linkedin' | 'manual_email' | 'custom';
  title: string;
  instructions: string;
  assignee_id: number | null;
  status: TaskStatus;
  due_at: number;
  auto_skip_at: number | null;
  outcome: string | null;
  notes: string | null;
  completed_by: number | null;
  completed_at: number | null;
  created_at: number;
}

export interface EmailMessageRow {
  id: number;
  workspace_id: number;
  mailbox_id: number;
  campaign_id: number | null;
  lead_id: number | null;
  conversation_id: number | null;
  node_id: string | null;
  variant: string | null;
  direction: 'out' | 'in';
  message_id: string;
  in_reply_to: string | null;
  refs: string | null; // space-separated
  subject: string;
  from_email: string;
  to_email: string;
  status: 'sending' | 'sent' | 'simulated' | 'failed' | 'bounced' | 'received';
  error: string | null;
  tracking_token: string | null;
  open_count: number;
  opened_at: number | null;
  click_count: number;
  clicked_at: number | null;
  sent_at: number;
}

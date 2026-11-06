import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

// A hosted plan's limit (HTTP 402). The app shell turns these into an upgrade prompt wherever they happen.
export interface PlanLimitDetails {
  code: 'plan_limit';
  limit: LimitKey;
  allowed: number;
  used: number;
}
export const PLAN_LIMIT_EVENT = 'openreach:plan-limit';
export const isPlanLimit = (e: unknown): e is ApiError & { details: PlanLimitDetails } =>
  e instanceof ApiError && e.status === 402 && (e.details as PlanLimitDetails | undefined)?.code === 'plan_limit';

// The workspace this tab shows. The server keeps the active workspace per session, so every call says which
// one the page is about; after a switch in another tab the server answers 409 instead of acting in the other one.
let shownWorkspace: number | null = null;
export const setShownWorkspace = (id: number | null) => {
  shownWorkspace = id;
};
export const WORKSPACE_CHANGED_EVENT = 'openreach:workspace-changed';

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = opts.body !== undefined ? { 'content-type': 'application/json' } : {};
  if (shownWorkspace != null) headers['x-workspace-id'] = String(shownWorkspace);
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('openreach:signed-out'));
    const err = new ApiError(res.status, (data && data.error) || res.statusText, data?.details);
    if (isPlanLimit(err)) window.dispatchEvent(new CustomEvent(PLAN_LIMIT_EVENT, { detail: err.message }));
    if (res.status === 409 && data?.details?.code === 'workspace_changed') window.dispatchEvent(new Event(WORKSPACE_CHANGED_EVENT));
    throw err;
  }
  return data as T;
}

// The scheduler's clock can run faster than real time (DEMO_SPEED), so relative times are
// computed against the server's clock rather than the browser's.
let clock = { server: Date.now(), local: Date.now(), speed: 1 };
export const serverNow = () => clock.server + (Date.now() - clock.local) * clock.speed;
export async function syncClock() {
  const h = await api<{ time: number; demoSpeed: number }>('/api/health');
  clock = { server: h.time, local: Date.now(), speed: h.demoSpeed || 1 };
}

// Fetches `path` and keeps it fresh. Pass `poll` (ms) to refresh in the background.
export function useApi<T = any>(path: string | null, poll?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const current = useRef(path);
  current.current = path;

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const d = await api<T>(path);
      if (current.current === path) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (current.current === path) setError((e as Error).message);
    } finally {
      if (current.current === path) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    void reload();
    if (!poll) return;
    const t = setInterval(() => document.visibilityState === 'visible' && void reload(), poll);
    return () => clearInterval(t);
  }, [reload, poll]);

  return { data, error, loading, reload, setData };
}

// ---- Shared types (mirror the server's JSON) -------------------------------------

export type ActionType = 'view_profile' | 'follow' | 'endorse' | 'like_post' | 'connect' | 'message' | 'email' | 'withdraw_invite' | 'inmail';
export type ConditionKind = 'is_connected' | 'accepted_within' | 'has_email' | 'replied' | 'is_open_profile' | 'reply_sentiment' | 'email_verified';
// What a reply means, as classified by the AI (or set by hand in the inbox). Order is the display order.
export const REPLY_CATEGORIES = ['interested', 'meeting_booked', 'question', 'not_now', 'not_interested', 'out_of_office', 'wrong_person', 'unsubscribe', 'other'] as const;
export type ReplyCategory = (typeof REPLY_CATEGORIES)[number];
export type InMailVia = 'profile' | 'sales_navigator';

// A/B testing: connect, message, email and InMail steps may hold 2–5 variants (A–E). The single-text fields
// always mirror variant A so older readers keep working.
export type VariantId = 'A' | 'B' | 'C' | 'D' | 'E';
export type AbMetric = 'accepted' | 'replied';
export interface AbTest {
  autoPickAfter: number | null;
  metric?: AbMetric;
}
type AbFields<V> = { variants?: ({ id: VariantId } & V)[]; abtest?: AbTest };

export type SeqNode =
  | { id: string; type: 'view_profile' | 'follow' | 'like_post' | 'withdraw_invite'; next: string | null }
  | { id: string; type: 'endorse'; count: number; next: string | null }
  | ({ id: string; type: 'connect'; note: string; next: string | null } & AbFields<{ note: string }>)
  | ({ id: string; type: 'message'; text: string; next: string | null } & AbFields<{ text: string }>)
  // replyInThread: sent as "Re: <first subject>" in the same thread (campaigns with mailboxes).
  | ({ id: string; type: 'email'; subject: string; body: string; replyInThread?: boolean; next: string | null } & AbFields<{ subject: string; body: string }>)
  | ({ id: string; type: 'inmail'; subject: string; body: string; via: InMailVia; next: string | null } & AbFields<{ subject: string; body: string }>)
  // A to-do for a person; the lead waits here until it is completed or skipped (or auto-skipped N days after it is due).
  | {
      id: string;
      type: 'task';
      kind: TaskKind;
      title: string;
      instructions: string;
      dueAfterHours: number;
      assigneeId: number | null;
      autoSkipAfterDays: number | null;
      next: string | null;
    }
  | ({ id: string; type: 'sms'; text: string; next: string | null } & AbFields<{ text: string }>)
  // contentSid: an approved WhatsApp template (needed outside 24 hours after the person last wrote).
  | { id: string; type: 'whatsapp'; text: string; contentSid?: string; contentVariables?: Record<string, string>; next: string | null }
  // Looks up (and verifies) the lead's work email; the lead goes on when it's done or after maxWaitHours.
  | { id: string; type: 'find_email'; verify: boolean; maxWaitHours: number; next: string | null }
  | { id: string; type: 'wait'; days: number; hours: number; next: string | null }
  // `categories`: reply_sentiment only, the reply categories that go down Yes.
  | { id: string; type: 'condition'; kind: ConditionKind; withinDays: number; categories?: ReplyCategory[]; yes: string | null; no: string | null };

export type VariantNode = Extract<SeqNode, { type: 'connect' | 'message' | 'email' | 'inmail' | 'sms' }>;

export type TaskKind = 'call' | 'manual_linkedin' | 'manual_email' | 'custom';
export const CALL_OUTCOMES = ['connected', 'voicemail', 'no_answer', 'wrong_number', 'meeting_booked', 'not_interested', 'other'] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

// GET /api/tasks items.
export interface Task {
  id: number;
  kind: TaskKind;
  title: string;
  instructions: string;
  status: 'open' | 'done' | 'skipped';
  overdue: boolean;
  dueAt: number;
  autoSkipAt: number | null;
  outcome: CallOutcome | null;
  notes: string | null;
  completedAt: number | null;
  createdAt: number;
  nodeId: string | null;
  assignee: { id: number; name: string } | null;
  lead: { id: number; name: string; profileUrl: string; phone: string | null; email: string | null; company: string; title: string } | null;
  campaign: { id: number; name: string } | null;
}
export interface TaskCounts {
  open: number;
  dueToday: number;
  overdue: number;
  mine: number;
}
export interface TeamMember {
  id: number;
  name: string;
  email: string;
  role: Role;
  // An agency owner/admin who runs this client workspace through the agency (managed there).
  inherited?: boolean;
}
// People who can own leads and take tasks: everyone but read-only clients.
export const assignable = (team: TeamMember[] | null | undefined) => (team ?? []).filter((u) => u.role !== 'client');

// Results of one A/B tested step (GET /api/campaigns/:id/variants).
export interface VariantStat {
  id: VariantId;
  sent: number;
  accepted: number;
  replied: number;
  rate: number;
  leader: boolean;
  significant: boolean;
}
export interface AbTestReport {
  nodeId: string;
  nodeType: VariantNode['type'];
  metric: AbMetric;
  autoPickAfter: number | null;
  winner: VariantId | null;
  decidedBy: 'auto' | 'user' | null;
  decidedAt: number | null;
  variants: VariantStat[];
}

export interface Sequence {
  start: string | null;
  nodes: Record<string, SeqNode>;
}

export interface CampaignStats {
  total: number;
  active: number;
  done: number;
  replied: number;
  failed: number;
  skipped: number;
  funnel: { viewed: number; invited: number; accepted: number; messaged: number; emailed: number; replied: number; contacted: number };
  acceptanceRate: number;
  replyRate: number;
  atNode: Record<string, number>;
  bySender: SenderStats[];
  // Leads reached by email; opens and clicks only with tracking on.
  email: { sent: number; opened: number; clicked: number; bounced: number };
  byMailbox: MailboxStats[];
}

// Results for one mailbox in a campaign (leads, not emails).
export interface MailboxStats {
  mailboxId: number;
  name: string;
  status: string;
  leads: number;
  sent: number;
  replied: number;
  bounced: number;
  replyRate: number;
}

// Results for one sending account in a campaign.
export interface SenderStats {
  accountId: number;
  name: string;
  status: string;
  leads: number;
  active: number;
  invited: number;
  accepted: number;
  messaged: number;
  replied: number;
  acceptanceRate: number;
  replyRate: number;
}

// An {{ai:name}} variable: written per lead by the AI provider before the step that uses it runs.
export interface AiVariable {
  name: string;
  instruction: string;
  fallback: string;
  maxChars: number;
}

export interface CampaignSettings {
  stopOnReply: boolean;
  skipIfInOtherCampaign: boolean;
  skipAlreadyConnected: boolean;
  noteLimit: number;
  aiVariables: AiVariable[];
  // With stopOnReply: replies in these categories let the sequence go on once classified.
  continueOnCategories: ReplyCategory[];
  // Email open (pixel) and click (redirect) tracking; off by default.
  trackOpens: boolean;
  trackClicks: boolean;
}

export type AiTone = 'friendly' | 'professional' | 'direct' | 'casual';
export type AiLength = 'short' | 'medium' | 'long';
export interface AiBrief {
  offer: string;
  audience?: string;
  tone: AiTone;
  length: AiLength;
  language: string;
  cta?: string;
}
export interface AiDraft {
  note?: string;
  text?: string;
  subject?: string;
  body?: string;
}
export interface AiWriteResult {
  drafts: AiDraft[];
  simulated: boolean;
  warnings: string[];
}
export interface AiPreview {
  values: Record<string, string>;
  errors: Record<string, string>;
  simulated: boolean;
}
// Per AI variable, across a campaign's leads.
export interface AiValueCount {
  name: string;
  ready: number;
  pending: number;
  failed: number;
  lastError: string | null;
}

export interface Campaign {
  id: number;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'completed';
  // The first sender; kept for older code paths.
  account: { id: number; name: string; status: string } | null;
  accountId: number | null;
  accounts: { id: number; name: string; status: string }[];
  accountIds: number[];
  mailboxes: { id: number; name: string; status: string; fromEmail: string; provider: string }[];
  mailboxIds: number[];
  settings: CampaignSettings;
  createdAt: number;
  startedAt: number | null;
  stats: CampaignStats;
  steps: number;
  sequence?: Sequence;
  problems?: string[];
  warnings?: string[];
}

export interface CampaignLead {
  lead: Lead;
  state: string;
  nodeId: string | null;
  nodeType: string | null;
  nextRunAt: number;
  lastError: string | null;
  addedAt: number;
  sender: { id: number; name: string } | null;
  mailbox: { id: number; name: string } | null;
}

export interface Account {
  id: number;
  name: string;
  driver: 'simulator' | 'playwright';
  status: 'active' | 'paused' | 'needs_login' | 'error';
  statusMessage: string | null;
  hasSession: boolean;
  proxyUrl: string | null;
  timezone: string;
  workDays: number[];
  workStart: string;
  workEnd: string;
  limits: Record<string, number>;
  effectiveLimits: Record<string, number>;
  usedToday: Record<string, number>;
  delayMinSec: number;
  delayMaxSec: number;
  warmup: boolean;
  smtp: { host: string; port: number; secure: boolean; user: string; from: string } | null;
  cooldowns: Record<string, number>;
  linkedinName: string | null;
  linkedinUrl: string | null;
  working: boolean;
  nextWorkingAt: number;
  nextActionAt: number;
  lastSyncAt: number;
  createdAt: number;
}

export interface Lead {
  id: number;
  listId: number | null;
  publicId: string;
  profileUrl: string;
  firstName: string;
  lastName: string;
  headline: string;
  title: string;
  company: string;
  location: string;
  email: string | null;
  phone: string | null;
  tags: string[];
  custom: Record<string, string>;
  connectionStatus: 'none' | 'pending' | 'connected';
  connectedAt: number | null;
  repliedAt: number | null;
  replyCategory: ReplyCategory | null;
  // 'invalid' after a bounce: email steps skip the lead.
  emailStatus: EmailStatus | null;
  emailStatusReason: string | null;
  // When the status was last set (verification, bounce).
  emailStatusAt: number | null;
  // user | csv | linkedin | a finder's provider id (hunter, apollo, simulated).
  emailSource: string | null;
  emailFoundAt: number | null;
  companyDomain: string | null;
  // Company facts from enrichment: companySize, industry, website, ... (`simulated: true` when made up).
  enrichment: Record<string, unknown>;
  enrichmentStatus: EnrichmentStatus | null;
  enrichedAt: number | null;
  // Open Profile members take InMail without a credit; null until a profile view tells.
  openProfile: boolean | null;
  // Pipeline: the lead's stage (the first stage when it has none), whether a person set it, and its owner.
  stageId: number | null;
  stage: Pick<Stage, 'id' | 'slug' | 'name' | 'color' | 'kind'> | null;
  stageChangedAt: number | null;
  stageManual: boolean;
  ownerId: number | null;
  createdAt: number;
  campaigns?: { id: number; name: string; state: string }[];
}

export type StageKind = 'open' | 'won' | 'lost';

// A pipeline stage (GET /api/pipeline/stages adds `leads`). Automation finds the defaults by slug.
export interface Stage {
  id: number;
  slug: string;
  name: string;
  color: string;
  position: number;
  kind: StageKind;
  leads?: number;
}

export interface PipelineSettings {
  autoLost: boolean;
}

export interface BoardCard {
  id: number;
  name: string;
  company: string;
  title: string;
  headline: string;
  tags: string[];
  ownerId: number | null;
  ownerName: string | null;
  lastActivityAt: number | null;
  stageChangedAt: number | null;
  replyCategory: ReplyCategory | null;
}

export interface BoardColumn extends Omit<Stage, 'leads'> {
  total: number;
  leads: BoardCard[];
}

export interface Tag {
  id: number;
  name: string;
  color: string;
  leads: number;
  createdAt: number;
}

export interface Note {
  id: number;
  leadId: number;
  body: string;
  userId: number | null;
  authorName: string | null;
  createdAt: number;
  updatedAt: number;
  canEdit: boolean;
}

export interface TeamMember {
  id: number;
  name: string;
  email: string;
  role: Role;
}

// GET /api/leads/:id/timeline: newest first; pass `nextBefore` back as `before` for the next page.
export type TimelineItem = { id: number; at: number } & (
  | { kind: 'activity'; type: string; status: string; detail: string | null; variant: string | null; campaignId: number | null; campaignName: string | null }
  | { kind: 'message'; body: string; category: ReplyCategory | null; channel: string; conversationId: number }
  | { kind: 'note'; body: string; userId: number | null; authorName: string | null; updatedAt: number }
  | { kind: 'stage'; source: 'manual' | 'auto' | 'api'; reason: string | null; fromName: string | null; toName: string | null; toColor: string | null; userName: string | null }
  | { kind: 'task'; taskKind: TaskKind; title: string; status: 'open' | 'done' | 'skipped'; outcome: CallOutcome | null; dueAt: number; completedAt: number | null; assigneeName: string | null }
);

export type EmailStatus = 'valid' | 'risky' | 'invalid' | 'unknown';
export type EnrichmentStatus = 'queued' | 'done' | 'not_found' | 'failed';

export interface EnrichOptions {
  find: boolean;
  verify: boolean;
  company: boolean;
  overwrite: boolean;
}

// A bulk "Find & verify emails" run (GET /api/enrichment/runs/:id). `found`: leads with an address afterwards.
export interface EnrichmentRun {
  id: number;
  status: 'running' | 'done';
  options: EnrichOptions;
  total: number;
  done: number;
  found: number;
  verified: number;
  failed: number;
  createdAt: number;
  finishedAt: number | null;
}

export interface EnrichmentSettings {
  verifyFound: boolean;
  acceptRisky: boolean;
  trustFinderStatus: boolean;
  autoEnrichOnImport: boolean;
  enrichCompany: boolean;
}

export interface UsageRow {
  kind: ProviderKind;
  provider: string;
  operation: string;
  calls: number;
  credits: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LeadList {
  id: number;
  name: string;
  leads: number;
  connected: number | null;
  createdAt: number;
}

export type ImportKind = 'search' | 'post' | 'event' | 'group';

// A background LinkedIn import (GET /api/imports).
export interface LeadImport {
  id: number;
  listId: number;
  listName: string | null;
  accountId: number | null;
  accountName: string | null;
  kind: ImportKind;
  source: string;
  options: { limit: number; likers: boolean | null; commenters: boolean | null };
  status: 'running' | 'done' | 'failed';
  found: number;
  added: number;
  duplicates: number;
  blacklisted: number;
  error: string | null;
  note: string | null;
  progress: { done: number; total: number | null };
  jobId: number | null;
  createdAt: number;
  finishedAt: number | null;
}

export type Role = 'owner' | 'admin' | 'member' | 'client';

// GET /api/inbox items and GET /api/inbox/:id.
export interface Conversation {
  id: number;
  channel: string;
  accountId: number | null;
  accountName: string | null;
  // Email threads: the mailbox, subject and the other person's address.
  mailboxId: number | null;
  mailboxName: string | null;
  subject: string | null;
  participantAddress: string | null;
  leadId: number | null;
  name: string;
  profileUrl: string;
  lastMessageAt: number;
  unread: number;
  category: ReplyCategory | null;
  categoryConfidence: number | null;
  headline: string | null;
  company: string | null;
  lastMessage: string | null;
  lastDirection: 'in' | 'out' | null;
  campaignName: string | null;
}

export interface Thread {
  id: number;
  channel: string;
  accountId: number | null;
  mailboxId: number | null;
  mailboxName: string | null;
  subject: string | null;
  participantAddress: string | null;
  leadId: number | null;
  name: string;
  profileUrl: string;
  category: ReplyCategory | null;
  categoryConfidence: number | null;
  categorySource: 'ai' | 'manual' | null;
  // The stage slug the reply's category points to.
  suggestedStage: 'interested' | 'meeting' | 'lost' | null;
  // The lead's pipeline stage (null for threads without a lead).
  stage: Pick<Stage, 'id' | 'slug' | 'name' | 'color'> | null;
  messages: { id: number; direction: 'in' | 'out'; body: string; sentAt: number; category: ReplyCategory | null; confidence: number | null }[];
}

export interface ServerSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string; // masked
}

// An email sending address (GET /api/mailboxes).
export interface Mailbox {
  id: number;
  name: string;
  provider: 'smtp' | 'simulated';
  simulated: boolean;
  preset: 'gmail' | 'outlook' | 'custom';
  fromName: string;
  fromEmail: string;
  domain: string;
  replyTo: string | null;
  signature: string;
  smtp: ServerSettings | null;
  imap: ServerSettings | null;
  hasSmtp: boolean;
  hasImap: boolean;
  status: 'active' | 'paused' | 'needs_attention';
  statusMessage: string | null;
  timezone: string;
  workDays: number[];
  workStart: string;
  workEnd: string;
  dailyLimit: number;
  effectiveLimit: number;
  sentToday: number;
  warmup: boolean;
  warmupDays: number;
  warmupStart: number;
  warmupDay: number;
  gapMinSec: number;
  gapMaxSec: number;
  working: boolean;
  nextWorkingAt: number;
  nextSendAt: number;
  lastSyncAt: number;
  campaigns: number;
  legacyAccountId: number | null;
  createdAt: number;
}

export interface MailboxPreset {
  id: Mailbox['preset'];
  label: string;
  smtp: { host: string; port: number; secure: boolean } | null;
  imap: { host: string; port: number; secure: boolean } | null;
  help: string;
}

export interface DnsCheck {
  id: 'mx' | 'spf' | 'dkim' | 'dmarc';
  status: 'pass' | 'warn' | 'fail';
  record?: string;
  message: string;
  fix?: string;
}
export interface DomainReport {
  domain: string;
  checks: DnsCheck[];
}

export type SuppressionKind = 'linkedin' | 'email' | 'phone';
export interface Suppression {
  id: number;
  kind: SuppressionKind;
  value: string;
  reason: string;
  source: string | null;
  leadId: number | null;
  leadName: string | null;
  createdAt: number;
}

export type ProviderKind = 'ai' | 'email_finder' | 'email_verifier' | 'enrichment' | 'crm' | 'sms';

export interface FieldSpec {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'number' | 'select' | 'textarea' | 'toggle';
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

export interface ProviderDef {
  id: string;
  kind: ProviderKind;
  label: string;
  description: string;
  docsUrl: string | null;
  simulated: boolean;
  fields: FieldSpec[];
}

export interface KindStatus {
  provider: string | null;
  label: string;
  simulated: boolean;
  integrationId: number | null;
}

export interface Integration {
  id: number;
  kind: ProviderKind;
  provider: string;
  providerLabel: string;
  simulated: boolean;
  label: string;
  enabled: boolean;
  priority: number;
  settings: Record<string, unknown>;
  credentials: Record<string, string>; // masked
  hasCredentials: boolean;
  // Twilio: the inbound webhook URL to paste into Twilio (null until PUBLIC_URL is set on the server).
  webhookUrl?: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastMessage: string | null;
  lastCheckedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// ---- CRM sync (HubSpot, Pipedrive, simulated) ----

// Saved in the CRM integration's settings (next to the vendor's own fields).
export interface CrmSettings {
  triggers: { onReply: boolean; onStageChange: string[]; onCampaignFinished: boolean; onConnected: boolean; logMessages: boolean };
  createDealOn: string[];
  dealNameTemplate: string;
  fieldMapping: Record<string, string>;
}

export interface CrmLogItem {
  id: number;
  integrationId: number | null;
  integration: string | null;
  provider: string | null;
  leadId: number | null;
  leadName: string | null;
  event: string;
  operation: 'upsert_contact' | 'add_note' | 'create_deal';
  status: 'ok' | 'error' | 'skipped';
  externalId: string | null;
  message: string | null;
  jobId: number | null;
  jobStatus: Job['status'] | null;
  // An error that a later attempt got past.
  resolved: boolean;
  createdAt: number;
}

export interface CrmLeadInfo {
  crms: { id: number; label: string; provider: string; simulated: boolean }[];
  links: { integrationId: number; integration: string; provider: string; objectType: 'contact' | 'deal'; externalId: string; url: string | null; syncedAt: number }[];
}

export interface Job {
  id: number;
  type: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  attempts: number;
  maxAttempts: number;
  progress: { done: number; total: number | null } | null;
  lastError: string | null;
  runAt: number;
  createdAt: number;
  finishedAt: number | null;
  result?: unknown;
}

// ---- Agency mode, workspaces, invites, white-label ----

export type WorkspaceKind = 'standard' | 'agency' | 'client';

// GET /api/workspaces items: direct memberships plus the clients of agencies the user runs.
export interface WorkspaceItem {
  id: number;
  name: string;
  kind: WorkspaceKind;
  role: Role;
  parentId: number | null;
  parentName: string | null;
  inherited: boolean;
  active: boolean;
}

export interface Branding {
  productName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  supportEmail: string | null;
}

// GET/PUT /api/agency/branding: the workspace's own values (null = inherited) and the agency's.
export interface BrandingSettings {
  productName: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  supportEmail: string | null;
  customDomain: string | null;
  // Only the agency owner picks custom domains.
  canEditDomain: boolean;
  inherited: Omit<Branding, 'productName'> & { productName: string | null } | null;
  effective: Branding;
}

export interface ClientOverview {
  id: number;
  name: string;
  createdAt: number;
  accounts: number;
  accountsNeedingAttention: number;
  mailboxesNeedingAttention: number;
  activeCampaigns: number;
  contacted: number;
  replies: number;
  meetings: number;
  replyRate: number;
  lastActivityAt: number | null;
}

export type InviteRole = 'admin' | 'member' | 'client';
export interface Invite {
  id: number;
  email: string;
  role: InviteRole;
  invitedBy: string | null;
  createdAt: number;
  expiresAt: number;
  expired: boolean;
}

// GET /api/public/invites/:token
export interface InviteInfo {
  workspaceName: string;
  email: string;
  role: InviteRole;
  existingUser: boolean;
  signedIn: boolean;
  expiresAt: number;
  branding: Branding;
}

// ---- Billing (hosted installs) ----

export type LimitKey = 'linkedinAccounts' | 'mailboxes' | 'seats' | 'clientWorkspaces' | 'aiCreditsMonthly' | 'enrichmentCreditsMonthly';
// null = unlimited.
export type PlanLimits = Record<LimitKey, number | null>;

export interface BillingPlan {
  id: string;
  name: string;
  // Applies without an active subscription.
  default: boolean;
  // Has a Stripe price (the free default plan has none).
  purchasable: boolean;
  limits: PlanLimits;
}

// GET /api/billing
export interface BillingInfo {
  enabled: boolean;
  workspaceName: string;
  plan: { id: string; name: string } | null;
  subscribedPlanId: string | null;
  status: 'none' | 'trialing' | 'active' | 'past_due' | 'unpaid' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'paused';
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  hasCustomer: boolean;
  canCheckout: boolean;
  // Stripe reported a second live subscription for this workspace (both are billed).
  duplicateSubscription: boolean;
  webhookConfigured: boolean;
  publicUrlConfigured: boolean;
  plans: BillingPlan[];
  usage: Record<LimitKey, { used: number; allowed: number | null }>;
}

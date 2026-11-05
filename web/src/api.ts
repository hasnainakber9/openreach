import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('openreach:signed-out'));
    throw new ApiError(res.status, (data && data.error) || res.statusText);
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
export type ConditionKind = 'is_connected' | 'accepted_within' | 'has_email' | 'replied' | 'is_open_profile' | 'reply_sentiment';
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
  | ({ id: string; type: 'email'; subject: string; body: string; next: string | null } & AbFields<{ subject: string; body: string }>)
  | ({ id: string; type: 'inmail'; subject: string; body: string; via: InMailVia; next: string | null } & AbFields<{ subject: string; body: string }>)
  | { id: string; type: 'wait'; days: number; hours: number; next: string | null }
  // `categories`: reply_sentiment only, the reply categories that go down Yes.
  | { id: string; type: 'condition'; kind: ConditionKind; withinDays: number; categories?: ReplyCategory[]; yes: string | null; no: string | null };

export type VariantNode = Extract<SeqNode, { type: 'connect' | 'message' | 'email' | 'inmail' }>;

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

export interface Campaign {
  id: number;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'completed';
  // The first sender; kept for older code paths.
  account: { id: number; name: string; status: string } | null;
  accountId: number | null;
  accounts: { id: number; name: string; status: string }[];
  accountIds: number[];
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
  // Open Profile members take InMail without a credit; null until a profile view tells.
  openProfile: boolean | null;
  createdAt: number;
  campaigns?: { id: number; name: string; state: string }[];
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
  leadId: number | null;
  name: string;
  profileUrl: string;
  category: ReplyCategory | null;
  categoryConfidence: number | null;
  categorySource: 'ai' | 'manual' | null;
  // A hint until pipeline stages exist.
  suggestedStage: 'interested' | 'meeting' | 'lost' | null;
  messages: { id: number; direction: 'in' | 'out'; body: string; sentAt: number; category: ReplyCategory | null; confidence: number | null }[];
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
  lastStatus: 'ok' | 'error' | null;
  lastMessage: string | null;
  lastCheckedAt: number | null;
  createdAt: number;
  updatedAt: number;
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

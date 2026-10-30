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

export type ActionType = 'view_profile' | 'follow' | 'endorse' | 'like_post' | 'connect' | 'message' | 'email' | 'withdraw_invite';
export type ConditionKind = 'is_connected' | 'accepted_within' | 'has_email' | 'replied';

export type SeqNode =
  | { id: string; type: 'view_profile' | 'follow' | 'like_post' | 'withdraw_invite'; next: string | null }
  | { id: string; type: 'endorse'; count: number; next: string | null }
  | { id: string; type: 'connect'; note: string; next: string | null }
  | { id: string; type: 'message'; text: string; next: string | null }
  | { id: string; type: 'email'; subject: string; body: string; next: string | null }
  | { id: string; type: 'wait'; days: number; hours: number; next: string | null }
  | { id: string; type: 'condition'; kind: ConditionKind; withinDays: number; yes: string | null; no: string | null };

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
}

export interface CampaignSettings {
  stopOnReply: boolean;
  skipIfInOtherCampaign: boolean;
  skipAlreadyConnected: boolean;
  noteLimit: number;
}

export interface Campaign {
  id: number;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'completed';
  account: { id: number; name: string; status: string } | null;
  accountId: number | null;
  settings: CampaignSettings;
  createdAt: number;
  startedAt: number | null;
  stats: CampaignStats;
  steps: number;
  sequence?: Sequence;
  problems?: string[];
  warnings?: string[];
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

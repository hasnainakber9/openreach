import { serverNow, type ActionType, type ConditionKind, type ImportKind, type ProviderKind, type ReplyCategory } from './api';

export const ACTION_LABELS: Record<ActionType | 'wait' | 'condition' | 'accepted' | 'replied' | 'ab_winner' | 'ai_personalize' | 'classified' | 'email_open' | 'email_click' | 'email_bounce', string> = {
  view_profile: 'View profile',
  follow: 'Follow',
  endorse: 'Endorse skills',
  like_post: 'Like a post',
  connect: 'Invite to connect',
  message: 'Send message',
  email: 'Send email',
  withdraw_invite: 'Withdraw invite',
  inmail: 'Send InMail',
  wait: 'Wait',
  condition: 'Condition',
  accepted: 'Accepted invite',
  replied: 'Replied',
  ab_winner: 'A/B winner set',
  ai_personalize: 'AI personalization',
  classified: 'Reply classified',
  email_open: 'Email opened',
  email_click: 'Email link clicked',
  email_bounce: 'Email bounced',
};

export const CONDITION_LABELS: Record<ConditionKind, string> = {
  accepted_within: 'Accepted the invite',
  is_connected: 'Already connected',
  has_email: 'Has an email address',
  replied: 'Has replied',
  is_open_profile: 'Has an open profile',
  reply_sentiment: 'Reply category matches',
};

export const CATEGORY_LABELS: Record<ReplyCategory, string> = {
  interested: 'Interested',
  meeting_booked: 'Meeting booked',
  question: 'Question',
  not_now: 'Not now',
  not_interested: 'Not interested',
  out_of_office: 'Out of office',
  wrong_person: 'Wrong person',
  unsubscribe: 'Unsubscribe',
  other: 'Other',
};

export const STAGE_LABELS = { interested: 'Interested', meeting: 'Meeting', lost: 'Lost' } as const;

export const IMPORT_KIND_LABELS: Record<ImportKind, string> = {
  search: 'Search',
  post: 'Post',
  event: 'Event',
  group: 'Group',
};

export function timeAgo(ms: number | null | undefined, now = serverNow()): string {
  if (!ms) return '—';
  const s = Math.round((now - ms) / 1000);
  const abs = Math.abs(s);
  const fmt = (n: number, u: string) => `${n}${u}`;
  const v = abs < 60 ? fmt(abs, 's') : abs < 3600 ? fmt(Math.round(abs / 60), 'm') : abs < 86400 ? fmt(Math.round(abs / 3600), 'h') : fmt(Math.round(abs / 86400), 'd');
  return s >= 0 ? `${v} ago` : `in ${v}`;
}

export function dateTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const fullName = (l: { firstName: string; lastName: string }) => `${l.firstName} ${l.lastName}`.trim() || 'Unnamed';

// A campaign's senders in a few words: "Seat A, Seat B +1".
export function senderSummary(accounts: { name: string }[], max = 2): string {
  const shown = accounts.slice(0, max).map((a) => a.name).join(', ');
  return accounts.length > max ? `${shown} +${accounts.length - max}` : shown;
}

export const pct = (n: number) => `${Number.isFinite(n) ? Math.round(n * 10) / 10 : 0}%`;

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const KIND_ORDER: ProviderKind[] = ['ai', 'email_finder', 'email_verifier', 'enrichment', 'crm', 'sms'];

export const KIND_LABELS: Record<ProviderKind, string> = {
  ai: 'AI writing',
  email_finder: 'Email finder',
  email_verifier: 'Email verification',
  enrichment: 'Data enrichment',
  crm: 'CRM',
  sms: 'SMS and WhatsApp',
};

export const KIND_HELP: Record<ProviderKind, string> = {
  ai: 'Drafts messages and personalizes them per lead.',
  email_finder: 'Looks up work email addresses for leads without one.',
  email_verifier: 'Checks addresses before email steps send to them.',
  enrichment: 'Adds company and contact details to leads.',
  crm: 'Pushes contacts, replies and deals to your CRM.',
  sms: 'Sends text and WhatsApp steps.',
};

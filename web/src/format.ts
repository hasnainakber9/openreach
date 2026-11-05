import { serverNow, type ActionType, type CallOutcome, type ConditionKind, type EmailStatus, type EnrichmentStatus, type ImportKind, type ProviderKind, type ReplyCategory, type TaskKind } from './api';

export const ACTION_LABELS: Record<
  ActionType | 'wait' | 'condition' | 'task' | 'find_email' | 'enrich' | 'sms' | 'whatsapp' | 'accepted' | 'replied' | 'ab_winner' | 'ai_personalize' | 'classified' | 'email_open' | 'email_click' | 'email_bounce' | 'task_created' | 'task_done' | 'task_skipped',
  string
> = {
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
  task: 'Manual task',
  find_email: 'Find email',
  enrich: 'Email lookup / enrichment',
  sms: 'Send SMS',
  whatsapp: 'Send WhatsApp',
  accepted: 'Accepted invite',
  replied: 'Replied',
  ab_winner: 'A/B winner set',
  ai_personalize: 'AI personalization',
  classified: 'Reply classified',
  email_open: 'Email opened',
  email_click: 'Email link clicked',
  email_bounce: 'Email bounced',
  task_created: 'Task created',
  task_done: 'Task done',
  task_skipped: 'Task skipped',
};

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  call: 'Call',
  manual_linkedin: 'LinkedIn by hand',
  manual_email: 'Email by hand',
  custom: 'Other to-do',
};

export const OUTCOME_LABELS: Record<CallOutcome, string> = {
  connected: 'Talked to them',
  voicemail: 'Left a voicemail',
  no_answer: 'No answer',
  wrong_number: 'Wrong number',
  meeting_booked: 'Meeting booked',
  not_interested: 'Not interested',
  other: 'Other',
};

export const CHANNEL_LABELS: Record<string, string> = { linkedin: 'LinkedIn', email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };

export const CONDITION_LABELS: Record<ConditionKind, string> = {
  accepted_within: 'Accepted the invite',
  is_connected: 'Already connected',
  has_email: 'Has an email address',
  replied: 'Has replied',
  is_open_profile: 'Has an open profile',
  reply_sentiment: 'Reply category matches',
  email_verified: 'Email is verified',
};

export const EMAIL_STATUS_LABELS: Record<EmailStatus, string> = { valid: 'Valid', risky: 'Risky', invalid: 'Invalid', unknown: 'Unverified' };

export const ENRICHMENT_STATUS_LABELS: Record<EnrichmentStatus, string> = { queued: 'Looking up…', done: 'Enriched', not_found: 'Nothing found', failed: 'Lookup failed' };

// Where a lead's email came from.
export function emailSourceLabel(source: string | null): string {
  if (!source) return '';
  const known: Record<string, string> = { user: 'Entered by hand', csv: 'From the CSV import', linkedin: 'From LinkedIn contact info', hunter: 'Found by Hunter', apollo: 'Found by Apollo', simulated: 'Made up by the simulator (never emailed from a real mailbox)' };
  return known[source] ?? `Found by ${source}`;
}

export const USAGE_OPERATION_LABELS: Record<string, string> = {
  'finder.find': 'Email lookups',
  'verifier.verify': 'Verifications',
  'enrich.person': 'Enrichments',
  'ai.write': 'AI drafts',
  'ai.personalize': 'AI personalization',
  'ai.classify': 'Reply classification',
  'ai.reply': 'Suggested replies',
  'sms.send': 'SMS sent',
  'whatsapp.send': 'WhatsApp sent',
  'crm.upsert': 'CRM contact updates',
  'crm.note': 'CRM notes',
  'crm.deal': 'CRM deals',
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

// Our lead fields that can be copied into CRM properties, in display order.
export const CRM_FIELD_LABELS: Record<string, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  fullName: 'Full name',
  email: 'Email',
  phone: 'Phone',
  company: 'Company',
  title: 'Job title',
  headline: 'Headline',
  location: 'Location',
  profileUrl: 'LinkedIn URL',
  companyDomain: 'Company domain',
  stage: 'Pipeline stage',
};

export const CRM_EVENT_LABELS: Record<string, string> = {
  reply: 'Reply',
  stage: 'Stage change',
  finished: 'Campaign finished',
  connected: 'Invitation accepted',
  message: 'Message sent',
  manual: 'Pushed by hand',
};

export const CRM_OPERATION_LABELS: Record<string, string> = {
  upsert_contact: 'Contact',
  add_note: 'Note',
  create_deal: 'Deal',
};

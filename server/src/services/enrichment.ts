import { z } from 'zod';
import { assertCredits } from '../billing/limits.js';
import { HOUR, MINUTE } from '../clock.js';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { isReservedAddress } from '../mail/mailboxes.js';
import type { SeqNode } from '../engine/sequence.js';
import type { JobHelpers, JobInfo } from '../jobs/queue.js';
import type { EmailFinder, EmailStatus, EmailVerifier, LeadFields } from '../providers/data/types.js';
import { ProviderError } from '../providers/http.js';
import { providerDef, type ProviderKind } from '../providers/registry.js';
import type { CampaignLeadRow, CampaignRow, EnrichmentRunRow, LeadRow } from '../types.js';
import { logActivity } from './activity.js';
import { publicLead } from './leads.js';
import { getSetting } from './settings.js';
import { recordUsage } from './usage.js';

// Email finding, verification and company enrichment. Finders run as a waterfall in the order set under
// Settings → Integrations until one returns an address the verifier accepts. Work runs as `enrich.lead`
// jobs (bulk runs, single leads, imports and the find_email sequence step all go through them).

export const EnrichmentSettingsSchema = z
  .object({
    // Check addresses a finder returns with the first enabled verifier.
    verifyFound: z.boolean().default(true),
    // Accept risky addresses (accept-all domains, webmail) as good enough: the waterfall stops there and
    // the "email verified" condition says yes.
    acceptRisky: z.boolean().default(false),
    // Skip our own check when the finder already verified the address (saves verifier credits).
    trustFinderStatus: z.boolean().default(false),
    // Find and verify emails for leads added by CSV or LinkedIn imports.
    autoEnrichOnImport: z.boolean().default(false),
    // Bulk runs started from imports also add company data.
    enrichCompany: z.boolean().default(true),
  })
  .default({});
export type EnrichmentSettings = z.infer<typeof EnrichmentSettingsSchema>;

export const enrichmentSettings = (ctx: Ctx, workspaceId: number) => getSetting(ctx, workspaceId, 'enrichment', EnrichmentSettingsSchema);

export interface EnrichOptions {
  find: boolean;
  verify: boolean;
  company: boolean;
  overwrite: boolean;
}

export interface EnrichJobPayload extends EnrichOptions {
  leadId: number;
  runId?: number;
  campaignLeadId?: number;
}

// Addresses people gave us (typed in, CSV, LinkedIn contact info). Finders never replace them unless asked.
// NULL is an address saved before sources were recorded.
export const USER_EMAIL_SOURCES = ['user', 'csv', 'linkedin'];
export const isUserEmail = (l: Pick<LeadRow, 'email' | 'email_source'>) => !!l.email && (l.email_source == null || USER_EMAIL_SOURCES.includes(l.email_source));

export const emailAccepted = (status: string | null | undefined, s: Pick<EnrichmentSettings, 'acceptRisky'>) => status === 'valid' || (status === 'risky' && s.acceptRisky);

// The "If email verified" condition.
export const emailVerified = (l: Pick<LeadRow, 'email' | 'email_status'>, s: Pick<EnrichmentSettings, 'acceptRisky'>) => !!l.email && emailAccepted(l.email_status, s);

// A lead enriched with the same options this recently is not looked up again (double clicks, overlapping runs).
export const REUSE_MS = 10 * MINUTE;
const MAX_ATTEMPTS = 3;
export const ENRICH_JOB_OPTIONS = { concurrency: 2, maxAttempts: MAX_ATTEMPTS, timeoutMs: 5 * MINUTE };

export const optionsKey = (o: EnrichOptions) => (['find', 'verify', 'company', 'overwrite'] as const).filter((k) => o[k]).join(',');

const providerLabel = (kind: ProviderKind, id: string) => providerDef(kind, id)?.label ?? id;
const RANK: Record<EmailStatus, number> = { valid: 3, risky: 2, unknown: 1, invalid: 0 };

// Usage log: one row per call. Simulated calls show up as calls but never cost credits.
function usage(ctx: Ctx, workspaceId: number, kind: ProviderKind, p: { providerId: string; simulated: boolean }, operation: string, credits: number, ok = true) {
  recordUsage(ctx, { workspaceId, kind, provider: p.providerId, operation, credits: p.simulated ? 0 : credits, ok });
}

type Attempt = { provider: string; result: 'found' | 'not_found' | 'invalid' | 'error'; detail?: string };

export interface WaterfallResult {
  email: string | null;
  status: EmailStatus | null;
  reason: string | null;
  source: string | null;
  // Found by the simulated finder: made up, so it never replaces a real address.
  simulated: boolean;
  accepted: boolean;
  tried: Attempt[];
  // Errors worth retrying (timeouts, outages): with nothing found, the job tries again later.
  transient: Error | null;
}

// Hosted plans include a number of enrichment credits a month; simulated providers are free. Over quota, the
// call is an error like a vendor's empty balance (the lookup carries on with what it has).
function chargeable(ctx: Ctx, workspaceId: number, p: { simulated: boolean }) {
  if (!p.simulated) assertCredits(ctx, workspaceId, 'enrichmentCreditsMonthly');
}

// Rate limits end the whole lookup: the job retries it later (no attempt used up), from the first finder again.
function rethrowIfRateLimited(e: unknown) {
  if (e instanceof ProviderError && e.code === 'RATE_LIMIT') throw e;
}

// A bad key or an empty balance shows on the integration's card; the waterfall carries on with the next one.
function flagIntegration(ctx: Ctx, e: unknown) {
  if (e instanceof ProviderError && (e.code === 'AUTH' || e.code === 'QUOTA') && e.integrationId) ctx.providers.markStatus(e.integrationId, 'error', e.message);
}
const isTransient = (e: unknown) => !(e instanceof ProviderError) || e.code === 'UNAVAILABLE' || e.code === 'TIMEOUT';
const errorText = (e: unknown) => (e instanceof ProviderError ? e.message : 'unexpected error');

async function verifyWith(ctx: Ctx, workspaceId: number, verifier: EmailVerifier, email: string) {
  try {
    chargeable(ctx, workspaceId, verifier);
    const r = await verifier.verify(email);
    usage(ctx, workspaceId, 'email_verifier', verifier, 'verifier.verify', r.credits ?? 1);
    return { status: r.status, reason: r.reason, error: null as unknown };
  } catch (e) {
    usage(ctx, workspaceId, 'email_verifier', verifier, 'verifier.verify', 0, false);
    rethrowIfRateLimited(e);
    flagIntegration(ctx, e);
    return { status: 'unknown' as EmailStatus, reason: `Not verified: ${errorText(e)}`, error: e };
  }
}

// Made-up addresses (the simulated finder's, or any reserved domain like .example) never go to a paid
// verifier: it would spend credits to learn they don't exist. The simulator judges them instead.
function verifierFor(ctx: Ctx, workspaceId: number, verifier: EmailVerifier, email: string, madeUp: boolean): EmailVerifier {
  if (verifier.simulated || !(madeUp || isReservedAddress(email))) return verifier;
  return ctx.providers.simulated(workspaceId, 'email_verifier')!;
}

// Tries each finder in priority order. Every address found is verified (unless the finder's own check is
// trusted); the first accepted one wins. Otherwise the best unconfirmed candidate (risky over unknown) is
// returned with accepted = false, and invalid ones are dropped, as is the lead's own address if it bounced.
export async function findEmailWaterfall(ctx: Ctx, workspaceId: number, lead: LeadRow, opts: { verify: boolean; settings: EnrichmentSettings }): Promise<WaterfallResult> {
  const finders: EmailFinder[] = ctx.providers.list(workspaceId, 'email_finder');
  const verifier = opts.verify && opts.settings.verifyFound ? ctx.providers.get(workspaceId, 'email_verifier') : null;
  const input = { firstName: lead.first_name, lastName: lead.last_name, company: lead.company, domain: lead.company_domain ?? undefined, profileUrl: lead.profile_url };
  const tried: Attempt[] = [];
  let transient: Error | null = null;
  let best: Omit<WaterfallResult, 'tried' | 'transient' | 'accepted'> | null = null;
  // A bounce stands until the address changes: finders often return the very address that bounced.
  const bounced = lead.email_status === 'invalid' ? lead.email?.trim().toLowerCase() : null;

  for (const finder of finders) {
    const label = providerLabel('email_finder', finder.providerId);
    let found: Awaited<ReturnType<EmailFinder['find']>>;
    try {
      chargeable(ctx, workspaceId, finder);
      found = await finder.find(input);
      usage(ctx, workspaceId, 'email_finder', finder, 'finder.find', found?.credits ?? 0);
    } catch (e) {
      usage(ctx, workspaceId, 'email_finder', finder, 'finder.find', 0, false);
      rethrowIfRateLimited(e);
      flagIntegration(ctx, e);
      if (isTransient(e)) transient ??= e as Error;
      tried.push({ provider: label, result: 'error', detail: errorText(e) });
      continue;
    }
    if (!found?.email) {
      tried.push({ provider: label, result: 'not_found' });
      continue;
    }
    const email = found.email.trim().toLowerCase();
    if (email === bounced) {
      tried.push({ provider: label, result: 'invalid', detail: `${email} (bounced)` });
      continue;
    }
    let status: EmailStatus = found.status ?? 'unknown';
    let reason = found.reason ?? `${label}: not verified`;
    if (verifier && !(found.status && opts.settings.trustFinderStatus)) {
      const v = await verifyWith(ctx, workspaceId, verifierFor(ctx, workspaceId, verifier, email, finder.simulated), email);
      // A verifier that couldn't tell (or the simulator on a real address) doesn't erase the finder's own check.
      if (v.status !== 'unknown' || !found.status) ({ status, reason } = v);
    }
    if (status === 'invalid') {
      tried.push({ provider: label, result: 'invalid', detail: email });
      continue;
    }
    tried.push({ provider: label, result: 'found', detail: `${email} (${status})` });
    const candidate = { email, status, reason, source: finder.providerId, simulated: finder.simulated };
    if (emailAccepted(status, opts.settings)) return { ...candidate, accepted: true, tried, transient };
    if (!best || RANK[status] > RANK[best.status!]) best = candidate;
  }
  return { ...(best ?? { email: null, status: null, reason: null, source: null, simulated: false }), accepted: false, tried, transient };
}

interface Outcome {
  patch: Record<string, string | number | null>;
  notes: string[];
  status: 'done' | 'not_found' | 'failed';
  transient: Error | null;
  source: string | null;
}

const FIELD_COLUMNS: Partial<Record<keyof LeadFields, keyof LeadRow>> = {
  firstName: 'first_name',
  lastName: 'last_name',
  headline: 'headline',
  title: 'title',
  company: 'company',
  location: 'location',
  phone: 'phone',
};

// Works out what to change on the lead without writing anything, so a retry starts from a clean slate.
async function computeEnrichment(ctx: Ctx, lead: LeadRow, o: EnrichOptions): Promise<Outcome> {
  const ws = lead.workspace_id;
  const settings = enrichmentSettings(ctx, ws);
  const now = ctx.clock.now();
  const patch: Outcome['patch'] = {};
  const notes: string[] = [];
  let transient: Error | null = null;
  let useful = false;
  let errored = false;
  let source: string | null = null;

  // Finder addresses that later bounced may be looked up again; people's own addresses only with overwrite.
  const needsFind = o.find && (!lead.email || o.overwrite || (!isUserEmail(lead) && lead.email_status === 'invalid'));
  if (needsFind) {
    const r = await findEmailWaterfall(ctx, ws, lead, { verify: o.verify, settings });
    transient = r.transient;
    errored = r.tried.some((t) => t.result === 'error');
    const label = r.source ? providerLabel('email_finder', r.source) : '';
    // A made-up address never replaces a real one, even with overwrite: the real one would be lost.
    const keepReal = r.simulated && !!lead.email && lead.email_source !== 'simulated' && !isReservedAddress(lead.email);
    // An unconfirmed address is better than none, but never replaces one the lead already has.
    if (r.email && keepReal) {
      useful = true;
      notes.push(`Kept ${lead.email}: the simulated finder's ${r.email} is made up`);
    } else if (r.email && (r.accepted || !lead.email || (!isUserEmail(lead) && lead.email_status === 'invalid'))) {
      if (r.email !== lead.email?.toLowerCase() || r.status !== lead.email_status) {
        Object.assign(patch, { email: r.email, email_source: r.source, email_found_at: now, email_status: r.status, email_status_reason: r.reason, email_status_at: now });
      }
      source = r.source;
      useful = true;
      notes.push(`Found ${r.email} via ${label} (${r.status})`);
    } else if (r.email) {
      useful = true;
      notes.push(`Kept ${lead.email}: ${r.email} from ${label} is only ${r.status}`);
    } else {
      const why = r.tried.map((t) => `${t.provider}: ${t.result === 'error' ? t.detail : t.result.replace('_', ' ')}`).join('; ');
      notes.push(`No email found${why ? ` (${why})` : ''}`);
    }
  } else if (o.find && lead.email) {
    useful = true;
  }

  // Re-checks only unchecked addresses (or every one with overwrite). A bounce ("invalid") stands until the
  // address changes: a later verification can't make it deliverable again.
  if (o.verify && !needsFind && lead.email && lead.email_status !== 'invalid' && (o.overwrite || lead.email_status == null || lead.email_status === 'unknown')) {
    const verifier = verifierFor(ctx, ws, ctx.providers.get(ws, 'email_verifier')!, lead.email, lead.email_source === 'simulated');
    const v = await verifyWith(ctx, ws, verifier, lead.email);
    if (v.error) {
      errored = true;
      if (isTransient(v.error)) transient ??= v.error as Error;
      notes.push(v.reason);
    } else {
      Object.assign(patch, { email_status: v.status, email_status_reason: v.reason, email_status_at: now });
      useful = true;
      notes.push(`${lead.email} is ${v.status}`);
    }
  } else if (o.verify && !needsFind && lead.email) useful = true;

  if (o.company) {
    const enricher = ctx.providers.get(ws, 'enrichment')!;
    const label = providerLabel('enrichment', enricher.providerId);
    try {
      chargeable(ctx, ws, enricher);
      const email = (patch.email as string | undefined) ?? lead.email;
      const r = await enricher.enrich({ firstName: lead.first_name, lastName: lead.last_name, company: lead.company, title: lead.title, email, profileUrl: lead.profile_url, domain: lead.company_domain ?? undefined });
      usage(ctx, ws, 'enrichment', enricher, 'enrich.person', r?.credits ?? (r ? 1 : 0));
      if (r) {
        useful = true;
        const merged = { ...json<Record<string, unknown>>(lead.enrichment, {}), ...r.enrichment, source: enricher.providerId, ...(enricher.simulated ? { simulated: true } : {}) };
        if (!enricher.simulated) delete merged.simulated;
        patch.enrichment = JSON.stringify(merged);
        // Made-up values never land in real lead fields (they could end up in a message); only the facts panel shows them.
        if (!enricher.simulated) {
          for (const [k, col] of Object.entries(FIELD_COLUMNS) as [keyof LeadFields, keyof LeadRow][]) {
            const v = r.fields[k];
            if (v && !lead[col]) patch[col] = v;
          }
          if (r.companyDomain && !lead.company_domain) patch.company_domain = r.companyDomain.toLowerCase();
          if (r.fields.email && !lead.email && !patch.email) {
            Object.assign(patch, { email: r.fields.email.toLowerCase(), email_source: enricher.providerId, email_found_at: now, email_status: 'unknown', email_status_reason: `${label}: not verified`, email_status_at: now });
          }
        }
        notes.push(`Company data from ${label}`);
      } else notes.push(`${label} has no company data for this lead`);
    } catch (e) {
      usage(ctx, ws, 'enrichment', enricher, 'enrich.person', 0, false);
      rethrowIfRateLimited(e);
      flagIntegration(ctx, e);
      errored = true;
      if (isTransient(e)) transient ??= e as Error;
      notes.push(`${label}: ${errorText(e)}`);
    }
  }

  return { patch, notes, status: useful ? 'done' : errored ? 'failed' : 'not_found', transient: useful ? null : transient, source };
}

const EMAIL_COLUMNS = ['email', 'email_source', 'email_found_at', 'email_status', 'email_status_reason', 'email_status_at'];
const FILL_COLUMNS: (keyof LeadRow)[] = [...Object.values(FIELD_COLUMNS), 'company_domain'];

// The patch was worked out from the lead as it was when the lookup started, which can be minutes ago.
// Whatever changed meanwhile wins: an address typed in or a bounce keeps the email as it is now, and fields
// filled in meanwhile aren't overwritten. Returns null when the lead was deleted.
function applyEnrichment(ctx: Ctx, lead: LeadRow, o: EnrichOptions, out: Outcome, campaignId: number | null): LeadRow | null {
  const now = ctx.clock.now();
  const updated = ctx.db.tx(() => {
    const fresh = ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [lead.id]);
    if (!fresh) return null;
    const patch = { ...out.patch };
    const emailChanged = fresh.email !== lead.email || fresh.email_source !== lead.email_source || fresh.email_status !== lead.email_status;
    if (emailChanged && EMAIL_COLUMNS.some((k) => k in patch)) {
      for (const k of EMAIL_COLUMNS) delete patch[k];
      out.notes.push('Email changed during the lookup; kept the new one');
    }
    for (const col of FILL_COLUMNS) if (col in patch && fresh[col]) delete patch[col];
    ctx.db.update('leads', lead.id, { ...patch, enrichment_status: out.status, enriched_at: now, enrichment_options: optionsKey(o) });
    return ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [lead.id])!;
  });
  if (!updated) return null;
  logActivity(ctx, {
    workspaceId: lead.workspace_id,
    campaignId,
    leadId: lead.id,
    type: 'enrich',
    status: out.status === 'done' ? 'ok' : out.status === 'failed' ? 'failed' : 'skipped',
    detail: out.notes.join(' · ').slice(0, 500) || null,
  });
  ctx.webhooks.emit(lead.workspace_id, 'lead.enriched', { lead: publicLead(updated, ctx), emailStatus: updated.email_status, source: updated.email_source });
  return updated;
}

// Leads waiting at a find_email step go on as soon as their lookup is over (whatever it found).
function wakeHeld(ctx: Ctx, leadId: number) {
  ctx.db.run("UPDATE campaign_leads SET hold_reason = NULL, next_run_at = ? WHERE lead_id = ? AND state = 'active' AND hold_reason = 'enrich'", [ctx.clock.now(), leadId]);
}

function bumpRun(ctx: Ctx, runId: number, workspaceId: number, lead: LeadRow | null) {
  const found = lead?.email ? 1 : 0;
  const verified = lead?.email && lead.email_status === 'valid' ? 1 : 0;
  const failed = !lead || lead.enrichment_status === 'failed' ? 1 : 0;
  // A job re-run after a crash must not push `done` past `total`.
  ctx.db.run(
    `UPDATE enrichment_runs SET done = done + 1, found = found + ?, verified = verified + ?, failed = failed + ?
     WHERE id = ? AND workspace_id = ? AND done < total`,
    [found, verified, failed, runId, workspaceId],
  );
  ctx.db.run("UPDATE enrichment_runs SET status = 'done', finished_at = ? WHERE id = ? AND status = 'running' AND done >= total", [ctx.clock.now(), runId]);
}

export async function enrichLeadJob(job: JobInfo<EnrichJobPayload>, h: JobHelpers) {
  const { ctx } = h;
  const p = job.payload;
  const ws = job.workspaceId!;
  const lead = ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [p.leadId, ws]);
  if (!lead) {
    if (p.runId) bumpRun(ctx, p.runId, ws, null);
    return { status: 'gone' };
  }
  const o: EnrichOptions = { find: !!p.find, verify: !!p.verify, company: !!p.company, overwrite: !!p.overwrite };
  const campaignId = p.campaignLeadId ? (ctx.db.get<{ campaign_id: number }>('SELECT campaign_id FROM campaign_leads WHERE id = ?', [p.campaignLeadId])?.campaign_id ?? null) : null;
  const now = ctx.clock.now();
  let updated = lead;
  const recent = lead.enrichment_options === optionsKey(o) && (lead.enriched_at ?? 0) >= now - REUSE_MS && lead.enrichment_status !== 'queued';
  if (!recent) {
    let out: Outcome;
    try {
      out = await computeEnrichment(ctx, lead, o);
    } catch (e) {
      // Rate limits come back later without using an attempt; anything else is retried, then recorded as failed.
      if ((e instanceof ProviderError && e.code === 'RATE_LIMIT') || job.attempts < MAX_ATTEMPTS) throw e;
      out = { patch: {}, notes: [`Failed: ${errorText(e)}`], status: 'failed', transient: null, source: null };
    }
    if (out.transient && job.attempts < MAX_ATTEMPTS) throw out.transient;
    const applied = applyEnrichment(ctx, lead, o, out, campaignId);
    if (!applied) {
      if (p.runId) bumpRun(ctx, p.runId, ws, null);
      return { status: 'gone' };
    }
    updated = applied;
  }
  wakeHeld(ctx, lead.id);
  if (p.runId) bumpRun(ctx, p.runId, ws, updated);
  return { status: updated.enrichment_status, email: !!updated.email, emailStatus: updated.email_status };
}

// Shows "queued" on leads about to be looked up, except those a repeat would just reuse.
function markQueued(ctx: Ctx, leadIds: number[], o: EnrichOptions) {
  const key = optionsKey(o);
  const since = ctx.clock.now() - REUSE_MS;
  for (let i = 0; i < leadIds.length; i += 500) {
    const chunk = leadIds.slice(i, i + 500);
    ctx.db.run(
      `UPDATE leads SET enrichment_status = 'queued' WHERE id IN (${chunk.map(() => '?').join(',')})
       AND NOT (COALESCE(enrichment_options, '') = ? AND COALESCE(enriched_at, 0) >= ? AND COALESCE(enrichment_status, '') <> 'queued')`,
      [...chunk, key, since],
    );
  }
}

export const MAX_RUN_LEADS = 10_000;

// A bulk run: one job per lead, with counters for the progress bar. The caller has checked the leads belong
// to the workspace. Each run has its own dedupe keys, so two overlapping runs over the same leads both finish.
export function startEnrichmentRun(ctx: Ctx, workspaceId: number, createdBy: number | null, leadIds: number[], o: EnrichOptions): { runId: number; total: number } {
  const ids = [...new Set(leadIds)].slice(0, MAX_RUN_LEADS);
  const now = ctx.clock.now();
  return ctx.db.tx(() => {
    const runId = ctx.db.insert('enrichment_runs', {
      workspace_id: workspaceId,
      created_by: createdBy,
      options: JSON.stringify(o),
      total: ids.length,
      status: ids.length ? 'running' : 'done',
      created_at: now,
      finished_at: ids.length ? null : now,
    });
    markQueued(ctx, ids, o);
    for (const leadId of ids) ctx.jobs.enqueue('enrich.lead', { leadId, runId, ...o }, { workspaceId, dedupeKey: `enrich.lead:${leadId}:run${runId}` });
    return { runId, total: ids.length };
  });
}

export function enrichSingleLead(ctx: Ctx, workspaceId: number, leadId: number, o: EnrichOptions): number {
  return ctx.db.tx(() => {
    markQueued(ctx, [leadId], o);
    return ctx.jobs.enqueue('enrich.lead', { leadId, ...o }, { workspaceId, dedupeKey: `enrich.lead:${leadId}:single` });
  });
}

// Imports: with the workspace's auto-enrich setting (or the import's own choice), added leads get a run.
export function autoEnrichImported(ctx: Ctx, workspaceId: number, leadIds: number[], createdBy: number | null, choice?: boolean): { runId: number; total: number } | null {
  const s = enrichmentSettings(ctx, workspaceId);
  if (!(choice ?? s.autoEnrichOnImport) || !leadIds.length) return null;
  return startEnrichmentRun(ctx, workspaceId, createdBy, leadIds, { find: true, verify: true, company: s.enrichCompany, overwrite: false });
}

export function serializeRun(r: EnrichmentRunRow) {
  return {
    id: r.id,
    status: r.status,
    options: json<EnrichOptions>(r.options, { find: true, verify: true, company: false, overwrite: false }),
    total: r.total,
    done: r.done,
    found: r.found,
    verified: r.verified,
    failed: r.failed,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

type FindEmailNode = Extract<SeqNode, { type: 'find_email' }>;

// The find_email step. A lead with a usable address goes on at once; otherwise its lookup is queued and the
// lead is held (hold_reason 'enrich') until the job wakes it or `maxWaitHours` pass. Spurious wake-ups
// re-hold without a second lookup (the job's dedupe key is per campaign lead) and keep the deadline.
export function findEmailGate(ctx: Ctx, campaign: CampaignRow, job: CampaignLeadRow, node: FindEmailNode): 'next' | 'hold' {
  const lead = ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [job.lead_id])!;
  const now = ctx.clock.now();
  const settings = enrichmentSettings(ctx, campaign.workspace_id);
  const release = () => {
    if (job.hold_reason === 'enrich') ctx.db.update('campaign_leads', job.id, { hold_reason: null });
    return 'next' as const;
  };
  // Nothing to look up: an address that needn't be checked or already was (a finder's address that
  // bounced is looked up again; people's own addresses never are).
  const bounced = lead.email_status === 'invalid' && !isUserEmail(lead);
  if (lead.email && !bounced && (!node.verify || emailAccepted(lead.email_status, settings) || ['valid', 'risky', 'invalid'].includes(lead.email_status ?? ''))) return release();
  // The lookup for this step has finished (or a recent one with the same reach did).
  const attempted = lead.enrichment_status !== 'queued' && (lead.enriched_at ?? 0) >= job.node_entered_at - REUSE_MS && (lead.enrichment_options ?? '').split(',').includes('find');
  if (attempted) return release();
  const deadline = job.node_entered_at + node.maxWaitHours * HOUR;
  if (now >= deadline) {
    logActivity(ctx, { workspaceId: campaign.workspace_id, campaignId: campaign.id, leadId: lead.id, type: 'enrich', status: 'skipped', detail: `No email lookup result within ${node.maxWaitHours} hours; going on`, nodeId: node.id });
    return release();
  }
  const o: EnrichOptions = { find: true, verify: node.verify, company: false, overwrite: false };
  const live = ctx.db.get("SELECT 1 FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running')", [`enrich.lead:${lead.id}:cl${job.id}`]);
  if (!live) {
    markQueued(ctx, [lead.id], o);
    ctx.jobs.enqueue('enrich.lead', { leadId: lead.id, campaignLeadId: job.id, ...o }, { workspaceId: campaign.workspace_id, dedupeKey: `enrich.lead:${lead.id}:cl${job.id}` });
  }
  ctx.db.update('campaign_leads', job.id, { hold_reason: 'enrich', next_run_at: deadline });
  return 'hold';
}

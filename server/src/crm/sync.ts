import { DAY } from '../clock.js';
import type { Ctx } from '../context.js';
import { leadVars, render } from '../engine/template.js';
import { PermanentError, type HandlerOptions, type JobHelpers, type JobInfo } from '../jobs/queue.js';
import type { CrmContact, CrmSettings } from '../providers/crm/types.js';
import { ProviderError } from '../providers/http.js';
import { loadIntegration } from '../providers/store.js';
import { stageOf } from '../services/pipeline.js';
import { recordUsage } from '../services/usage.js';
import { json } from '../db/db.js';
import type { LeadRow } from '../types.js';
import { crmSettingsOf, type CrmSyncPayload } from './triggers.js';

// Several at once, so one workspace's slow or unreachable CRM can't hold up everyone else's syncs. Syncs of
// the same lead to the same CRM still run one after another (see `oneAtATime`); vendor limiters are per integration.
export const CRM_JOB_OPTIONS: HandlerOptions = { concurrency: 4, maxAttempts: 6 };
// The sync log keeps three months.
const LOG_KEEP = 90 * DAY;

const CHANNEL_NAMES: Record<string, string> = { linkedin: 'LinkedIn', email: 'email', sms: 'SMS', whatsapp: 'WhatsApp' };
const SENT_NAMES: Record<string, string> = { message: 'LinkedIn message', inmail: 'InMail', email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp message' };

export function crmContact(ctx: Ctx, lead: LeadRow): CrmContact {
  return {
    email: lead.email,
    firstName: lead.first_name,
    lastName: lead.last_name,
    fullName: `${lead.first_name} ${lead.last_name}`.trim(),
    company: lead.company,
    title: lead.title,
    headline: lead.headline,
    location: lead.location,
    phone: lead.phone,
    profileUrl: lead.profile_url,
    companyDomain: lead.company_domain,
    stage: stageOf(ctx, lead)?.name ?? null,
  };
}

interface Note {
  key: string;
  body: string;
  timestamp: number;
}

// The note an event adds, read from the row its ref points at (scoped to the workspace). Null = no note.
export function noteFor(ctx: Ctx, lead: LeadRow, p: CrmSyncPayload, s: CrmSettings): Note | null {
  const ws = lead.workspace_id;
  const [kind, rawId] = p.ref.split(':');
  const id = Number(rawId);
  switch (p.event) {
    case 'reply': {
      if (kind === 'message') {
        const m = ctx.db.get<{ body: string; sent_at: number; channel: string }>(
          'SELECT m.body, m.sent_at, c.channel FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND c.workspace_id = ? AND c.lead_id = ?',
          [id, ws, lead.id],
        );
        if (m) return { key: p.ref, body: `Replied on ${CHANNEL_NAMES[m.channel] ?? m.channel}:\n\n${m.body}`, timestamp: m.sent_at };
      }
      return { key: p.ref, body: 'Replied to outreach from OpenReach.', timestamp: lead.replied_at ?? ctx.clock.now() };
    }
    case 'stage': {
      const h = ctx.db.get<{ to_slug: string | null; to_name: string | null; from_name: string | null; reason: string | null; created_at: number }>(
        `SELECT t.slug AS to_slug, t.name AS to_name, f.name AS from_name, h.reason, h.created_at FROM lead_stage_history h
         LEFT JOIN pipeline_stages t ON t.id = h.to_stage_id LEFT JOIN pipeline_stages f ON f.id = h.from_stage_id
         WHERE h.id = ? AND h.workspace_id = ? AND h.lead_id = ?`,
        [id, ws, lead.id],
      );
      // Stages that only create a deal add no note.
      if (!h?.to_slug || !s.triggers.onStageChange.includes(h.to_slug)) return null;
      const reason = h.reason ? ` (${h.reason})` : '';
      return { key: p.ref, body: `Pipeline stage: ${h.from_name ?? 'none'} → ${h.to_name}${reason}`, timestamp: h.created_at };
    }
    case 'finished': {
      const c = ctx.db.get<{ name: string; finished_at: number | null }>('SELECT c.name, cl.finished_at FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.id = ? AND c.workspace_id = ? AND cl.lead_id = ?', [
        id,
        ws,
        lead.id,
      ]);
      return c ? { key: p.ref, body: `Finished the campaign “${c.name}” in OpenReach.`, timestamp: c.finished_at ?? ctx.clock.now() } : null;
    }
    case 'connected': {
      const accountId = Number(p.ref.split(':')[2]);
      const a = ctx.db.get<{ name: string }>('SELECT name FROM accounts WHERE id = ? AND workspace_id = ?', [accountId, ws]);
      return { key: p.ref, body: `Accepted the LinkedIn connection request${a ? ` from ${a.name}` : ''}.`, timestamp: lead.connected_at ?? ctx.clock.now() };
    }
    case 'message': {
      const a = ctx.db.get<{ type: string; detail: string | null; created_at: number; campaign: string | null }>(
        'SELECT a.type, a.detail, a.created_at, c.name AS campaign FROM activity a LEFT JOIN campaigns c ON c.id = a.campaign_id WHERE a.id = ? AND a.workspace_id = ? AND a.lead_id = ?',
        [id, ws, lead.id],
      );
      if (!a) return null;
      const where = a.campaign ? ` (campaign “${a.campaign}”)` : '';
      return { key: p.ref, body: `${SENT_NAMES[a.type] ?? a.type} sent${where}${a.detail ? `:\n\n${a.detail}` : ''}`, timestamp: a.created_at };
    }
    case 'manual':
      return null;
  }
}

type Op = 'upsert_contact' | 'add_note' | 'create_deal';

// Upserts the contact, adds the event's note once and opens a deal once, logging each step. Safe to rerun:
// the contact id is kept on the lead (crm_links) and every note's key in crm_items. Delivery is at least once:
// a crash between the CRM call and our write can repeat that one note.
export function crmSyncJob(job: JobInfo<CrmSyncPayload>, h: JobHelpers) {
  return oneAtATime(`${job.payload.integrationId}:${job.payload.leadId}`, () => syncLead(job, h));
}

// Two syncs of one lead running together would both miss the search and create the contact twice, so
// they queue up behind each other in this process (collisions are rare: two events for one lead at once).
const syncing = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (syncing.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  syncing.set(key, run);
  try {
    return await run;
  } finally {
    if (syncing.get(key) === run) syncing.delete(key);
  }
}

async function syncLead(job: JobInfo<CrmSyncPayload>, { ctx }: JobHelpers) {
  const p = job.payload;
  const ws = job.workspaceId;
  if (ws == null) throw new PermanentError('crm.sync needs a workspace');
  const row = loadIntegration(ctx, ws, p.integrationId);
  if (!row || row.kind !== 'crm') return { skipped: 'integration removed' };
  const lead = ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [p.leadId, ws]);
  if (!lead) return { skipped: 'lead removed' };
  const log = (operation: Op, status: 'ok' | 'error' | 'skipped', o: { externalId?: string | null; error?: string } = {}) =>
    ctx.db.insert('crm_sync_log', {
      workspace_id: ws,
      integration_id: row.id,
      lead_id: lead.id,
      job_id: job.id,
      event: p.event,
      ref: p.ref,
      operation,
      status,
      external_id: o.externalId ?? null,
      error: o.error?.slice(0, 500) ?? null,
      created_at: ctx.clock.now(),
    });
  if (!row.enabled) {
    log('upsert_contact', 'skipped', { error: 'The CRM integration is turned off' });
    return { skipped: 'integration off' };
  }
  const crm = ctx.providers.instance<'crm'>(row);
  if (!crm) throw new PermanentError(`Provider "${row.provider}" is no longer available`);
  const s = crmSettingsOf(row);

  // Each CRM call is logged and counted; failures are rethrown so the queue retries (or stops on AUTH).
  const step = async <T extends { id: string }>(operation: Op, usage: string, fn: () => Promise<T>): Promise<T> => {
    try {
      const out = await fn();
      recordUsage(ctx, { workspaceId: ws, kind: 'crm', provider: row.provider, operation: usage });
      return out;
    } catch (e) {
      recordUsage(ctx, { workspaceId: ws, kind: 'crm', provider: row.provider, operation: usage, ok: false });
      log(operation, 'error', { error: errorText(e) });
      throw e;
    }
  };

  const existing = link(ctx, lead.id, row.id, 'contact');
  const contactId = (await step('upsert_contact', 'crm.upsert', () => crm.upsertContact(crmContact(ctx, lead), s.fieldMapping, existing))).id;
  saveLink(ctx, lead.id, row.id, 'contact', contactId);
  log('upsert_contact', 'ok', { externalId: contactId });

  const note = noteFor(ctx, lead, p, s);
  if (note) {
    const done = ctx.db.get<{ external_id: string }>('SELECT external_id FROM crm_items WHERE integration_id = ? AND item_key = ?', [row.id, note.key]);
    if (done) log('add_note', 'skipped', { externalId: done.external_id, error: 'Already in the CRM' });
    else {
      const r = await step('add_note', 'crm.note', () => crm.addNote(contactId, { body: note.body, timestamp: note.timestamp }));
      ctx.db.run('INSERT INTO crm_items (integration_id, item_key, external_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (integration_id, item_key) DO NOTHING', [row.id, note.key, r.id, ctx.clock.now()]);
      log('add_note', 'ok', { externalId: r.id });
    }
  }

  // A deal once per lead, when its current stage is one of the deal stages.
  const stage = stageOf(ctx, lead);
  let dealId: string | null = null;
  if (stage && s.createDealOn.includes(stage.slug) && !link(ctx, lead.id, row.id, 'deal')) {
    const vars = leadVars({ ...lead, custom: json<Record<string, unknown>>(lead.custom, {}) });
    const name = render(s.dealNameTemplate, vars, () => 0).replace(/^[\s–-]+|[\s–-]+$/g, '') || vars.fullName || 'LinkedIn lead';
    const r = await step('create_deal', 'crm.deal', () => crm.createDeal(contactId, { name: name.slice(0, 200) }));
    saveLink(ctx, lead.id, row.id, 'deal', r.id);
    dealId = r.id;
    log('create_deal', 'ok', { externalId: r.id });
  }

  // A sync that works again clears an error left by an earlier one.
  if (row.last_status === 'error') ctx.providers.markStatus(row.id, 'ok', 'Syncing again');
  ctx.db.run('DELETE FROM crm_sync_log WHERE workspace_id = ? AND created_at < ?', [ws, ctx.clock.now() - LOG_KEEP]);
  return { contactId, dealId };
}

function link(ctx: Ctx, leadId: number, integrationId: number, objectType: 'contact' | 'deal'): string | null {
  return ctx.db.get<{ external_id: string }>('SELECT external_id FROM crm_links WHERE lead_id = ? AND integration_id = ? AND object_type = ?', [leadId, integrationId, objectType])?.external_id ?? null;
}

function saveLink(ctx: Ctx, leadId: number, integrationId: number, objectType: 'contact' | 'deal', externalId: string) {
  ctx.db.run(
    `INSERT INTO crm_links (lead_id, integration_id, object_type, external_id, synced_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (lead_id, integration_id, object_type) DO UPDATE SET external_id = excluded.external_id, synced_at = excluded.synced_at`,
    [leadId, integrationId, objectType, externalId, ctx.clock.now()],
  );
}

// Provider errors are already scrubbed of secrets; anything else gets a generic text.
function errorText(e: unknown): string {
  if (e instanceof ProviderError) {
    if (e.code === 'RATE_LIMIT') return `${e.message}; will retry${e.retryAfterMs ? ` in ${Math.ceil(e.retryAfterMs / 1000)} s` : ''}`;
    return e.message;
  }
  console.error('[crm] sync failed', e);
  return 'Unexpected error while syncing; it will be retried';
}

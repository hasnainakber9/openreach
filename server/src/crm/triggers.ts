import type { Ctx } from '../context.js';
import { providerDef } from '../providers/registry.js';
import type { IntegrationRow } from '../providers/store.js';
import { json } from '../db/db.js';
import { crmSettingsSchema, type CrmEvent, type CrmSettings } from '../providers/crm/types.js';
import type { WebhookEvent } from '../services/webhooks.js';

export interface CrmSyncPayload {
  integrationId: number;
  leadId: number;
  event: CrmEvent;
  // What the note is about: message:<id> | activity:<id> | stage:<historyId> | finished:<campaignLeadId> |
  // connected:<leadId>:<accountId> | replied:<leadId>:<time>; '' for a manual push (contact only).
  ref: string;
}

// Message-type actions that `logMessages` copies into the CRM.
export const LOGGED_ACTION_TYPES = ['message', 'inmail', 'email', 'sms', 'whatsapp'];

export const crmSyncKey = (p: Pick<CrmSyncPayload, 'integrationId' | 'leadId' | 'event' | 'ref'>) => `crm.sync:${p.integrationId}:${p.leadId}:${p.event}:${p.ref}`;

export function enqueueCrmSync(ctx: Ctx, workspaceId: number, p: CrmSyncPayload, runAt?: number): number {
  return ctx.jobs.enqueue('crm.sync', p, { workspaceId, dedupeKey: crmSyncKey(p), runAt });
}

// Saved settings that no longer parse fall back to the defaults, like the provider resolver does.
export function crmSettingsOf(row: Pick<IntegrationRow, 'kind' | 'provider' | 'settings'>): CrmSettings {
  const def = providerDef('crm', row.provider);
  const schema = def?.settings ?? crmSettingsSchema({});
  const r = schema.safeParse(json(row.settings, {}));
  return (r.success ? r.data : schema.safeParse({}).data) as CrmSettings;
}

// Only CRMs someone added (there is no simulated fallback for crm), enabled, with a known provider.
export function activeCrms(ctx: Ctx, workspaceId: number): IntegrationRow[] {
  return ctx.db
    .all<IntegrationRow>("SELECT * FROM integrations WHERE workspace_id = ? AND kind = 'crm' AND enabled = 1 ORDER BY priority, id", [workspaceId])
    .filter((r) => providerDef('crm', r.provider));
}

export interface CrmTrigger {
  event: CrmEvent;
  ref: string;
  stage?: string; // stage slug the lead moved to (stage events)
}

// Whether one CRM's settings want this event: a note trigger, or (for stage moves) a deal stage.
export function wantsEvent(s: CrmSettings, t: CrmTrigger): boolean {
  switch (t.event) {
    case 'reply':
      return s.triggers.onReply;
    case 'stage':
      return !!t.stage && (s.triggers.onStageChange.includes(t.stage) || s.createDealOn.includes(t.stage));
    case 'finished':
      return s.triggers.onCampaignFinished;
    case 'connected':
      return s.triggers.onConnected;
    case 'message':
      return s.triggers.logMessages;
    case 'manual':
      return true;
  }
}

const idOf = (v: unknown) => (typeof v === 'object' && v && typeof (v as { id?: unknown }).id === 'number' ? (v as { id: number }).id : null);

// Turns an outgoing event into a CRM trigger. The ref points at the row the note is about, read now
// (events are emitted after their rows are written) so a rerun or a duplicate event maps to the same note.
export function triggerFor(ctx: Ctx, workspaceId: number, event: WebhookEvent, data: Record<string, unknown>): (CrmTrigger & { leadId: number }) | null {
  const leadId = idOf(data.lead);
  if (!leadId) return null;
  switch (event) {
    case 'lead.replied': {
      const m = ctx.db.get<{ id: number }>(
        "SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.lead_id = ? AND c.workspace_id = ? AND m.direction = 'in' ORDER BY m.sent_at DESC, m.id DESC LIMIT 1",
        [leadId, workspaceId],
      );
      const at = ctx.db.get<{ replied_at: number | null }>('SELECT replied_at FROM leads WHERE id = ? AND workspace_id = ?', [leadId, workspaceId])?.replied_at;
      return { leadId, event: 'reply', ref: m ? `message:${m.id}` : `replied:${leadId}:${at ?? 0}` };
    }
    case 'lead.stage_changed': {
      const h = ctx.db.get<{ id: number }>('SELECT id FROM lead_stage_history WHERE lead_id = ? AND workspace_id = ? ORDER BY id DESC LIMIT 1', [leadId, workspaceId]);
      const to = data.to as { slug?: string } | null;
      return h && to?.slug ? { leadId, event: 'stage', ref: `stage:${h.id}`, stage: to.slug } : null;
    }
    case 'lead.finished': {
      const campaignId = idOf(data.campaign);
      const cl = campaignId ? ctx.db.get<{ id: number }>('SELECT cl.id FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.campaign_id = ? AND cl.lead_id = ? AND c.workspace_id = ?', [campaignId, leadId, workspaceId]) : undefined;
      return cl ? { leadId, event: 'finished', ref: `finished:${cl.id}` } : null;
    }
    case 'lead.connected':
      return { leadId, event: 'connected', ref: `connected:${leadId}:${idOf(data.account) ?? 0}` };
    case 'action.performed': {
      if (!LOGGED_ACTION_TYPES.includes(String(data.type))) return null;
      const a = ctx.db.get<{ id: number }>("SELECT id FROM activity WHERE lead_id = ? AND workspace_id = ? AND type = ? AND status = 'ok' ORDER BY id DESC LIMIT 1", [leadId, workspaceId, String(data.type)]);
      return a ? { leadId, event: 'message', ref: `activity:${a.id}` } : null;
    }
    default:
      return null;
  }
}

const WATCHED = new Set<WebhookEvent>(['lead.replied', 'lead.stage_changed', 'lead.finished', 'lead.connected', 'action.performed']);

// Listens to outgoing events and queues a crm.sync job per CRM that wants them. Called once from buildContext.
export function registerCrmTriggers(ctx: Ctx) {
  return ctx.webhooks.subscribe((workspaceId, event, data) => {
    if (!WATCHED.has(event)) return;
    const crms = activeCrms(ctx, workspaceId);
    if (!crms.length) return;
    const t = triggerFor(ctx, workspaceId, event, data);
    if (!t) return;
    for (const row of crms) {
      if (wantsEvent(crmSettingsOf(row), t)) enqueueCrmSync(ctx, workspaceId, { integrationId: row.id, leadId: t.leadId, event: t.event, ref: t.ref });
    }
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { activeCrms, enqueueCrmSync } from '../crm/triggers.js';
import { HttpError, idParam, notFound, parse, requireAdmin, requireWriter } from '../http.js';
import { providerDef } from '../providers/registry.js';
import { loadIntegration, type IntegrationRow } from '../providers/store.js';

const PAGE_SIZE = 50;
const MAX_PUSH = 1000;
// A bulk push is spread out at about the pace a CRM's rate limit allows, so other workspaces' syncs
// (due now) are claimed ahead of most of it instead of waiting behind the whole batch.
const PUSH_SPACING_MS = 500;

interface LogRow {
  id: number;
  integration_id: number | null;
  lead_id: number | null;
  job_id: number | null;
  event: string;
  ref: string;
  operation: string;
  status: string;
  external_id: string | null;
  error: string | null;
  created_at: number;
  label: string | null;
  provider: string | null;
  first_name: string | null;
  last_name: string | null;
  job_status: string | null;
  resolved?: number;
}

function serializeLog(r: LogRow) {
  return {
    id: r.id,
    integrationId: r.integration_id,
    integration: r.label,
    provider: r.provider,
    leadId: r.lead_id,
    leadName: r.lead_id ? `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() : null,
    event: r.event,
    operation: r.operation,
    status: r.status,
    externalId: r.external_id,
    // The error, or why the step was skipped.
    message: r.error,
    jobId: r.job_id,
    // queued/running while the job is still trying (Retry is pointless then).
    jobStatus: r.job_status,
    // An error a later attempt (the queue's or a manual retry) got past: nothing left to retry.
    resolved: !!r.resolved,
    createdAt: r.created_at,
  };
}

export function crmRoutes(app: FastifyInstance, ctx: Ctx) {
  const crmIntegration = (workspaceId: number, id: number): IntegrationRow => {
    const row = loadIntegration(ctx, workspaceId, id);
    if (!row || row.kind !== 'crm') notFound('CRM integration');
    return row;
  };

  // Every CRM call with its outcome, newest first.
  app.get('/api/crm/log', async (req) => {
    const admin = requireAdmin(req);
    const q = parse(
      z.object({
        integrationId: z.coerce.number().int().positive().optional(),
        leadId: z.coerce.number().int().positive().optional(),
        status: z.enum(['ok', 'error', 'skipped']).optional(),
        page: z.coerce.number().int().min(1).max(10_000).default(1),
      }),
      req.query,
    );
    const where = ['l.workspace_id = ?'];
    const params: (string | number)[] = [admin.workspace_id];
    if (q.integrationId) where.push('l.integration_id = ?'), params.push(q.integrationId);
    if (q.leadId) where.push('l.lead_id = ?'), params.push(q.leadId);
    if (q.status) where.push('l.status = ?'), params.push(q.status);
    const total = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM crm_sync_log l WHERE ${where.join(' AND ')}`, params)!.n;
    const rows = ctx.db.all<LogRow>(
      // Resolved: the job finished, or a later sync of the same event got the same step done.
      `SELECT l.*, i.label, i.provider, ld.first_name, ld.last_name, j.status AS job_status,
         (l.status = 'error' AND (j.status = 'done' OR EXISTS (
           SELECT 1 FROM crm_sync_log o WHERE o.lead_id = l.lead_id AND o.integration_id = l.integration_id AND o.event = l.event AND o.ref = l.ref
             AND o.operation = l.operation AND o.status = 'ok' AND o.id > l.id))) AS resolved
       FROM crm_sync_log l
       LEFT JOIN integrations i ON i.id = l.integration_id
       LEFT JOIN leads ld ON ld.id = l.lead_id
       LEFT JOIN jobs j ON j.id = l.job_id AND j.workspace_id = l.workspace_id
       WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC, l.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(q.page - 1) * PAGE_SIZE}`,
      params,
    );
    return { total, pageSize: PAGE_SIZE, items: rows.map(serializeLog) };
  });

  // Runs the logged sync again (same dedupe key, so a sync still queued is reused).
  app.post('/api/crm/log/:id/retry', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const row = ctx.db.get<LogRow>('SELECT * FROM crm_sync_log WHERE id = ? AND workspace_id = ?', [id, admin.workspace_id]) ?? notFound('Log entry');
    if (row.integration_id == null || row.lead_id == null) throw new HttpError(409, 'The integration or lead of this entry was removed');
    const integration = crmIntegration(admin.workspace_id, row.integration_id);
    if (!integration.enabled) throw new HttpError(409, `${integration.label} is turned off`);
    if (!ctx.db.get('SELECT 1 FROM leads WHERE id = ? AND workspace_id = ?', [row.lead_id, admin.workspace_id])) throw new HttpError(409, 'The lead of this entry was removed');
    const jobId = enqueueCrmSync(ctx, admin.workspace_id, { integrationId: integration.id, leadId: row.lead_id, event: row.event as never, ref: row.ref });
    return { jobId };
  });

  // Sends leads to a CRM now (contact upsert, and a deal if their stage asks for one).
  app.post('/api/crm/push', async (req) => {
    const me = requireWriter(req);
    const body = parse(z.object({ integrationId: z.number().int().positive(), leadIds: z.array(z.number().int().positive()).min(1).max(MAX_PUSH) }), req.body);
    const integration = crmIntegration(me.workspace_id, body.integrationId);
    if (!integration.enabled) throw new HttpError(409, `${integration.label} is turned off`);
    const asked = [...new Set(body.leadIds)];
    let queued = 0;
    for (let i = 0; i < asked.length; i += 500) {
      const chunk = asked.slice(i, i + 500);
      // Ids from another workspace are silently left out, like every bulk action.
      const ids = ctx.db.all<{ id: number }>(`SELECT id FROM leads WHERE workspace_id = ? AND id IN (${chunk.map(() => '?').join(',')})`, [me.workspace_id, ...chunk]);
      const now = ctx.clock.now();
      ctx.db.tx(() =>
        ids.forEach((l, j) => enqueueCrmSync(ctx, me.workspace_id, { integrationId: integration.id, leadId: l.id, event: 'manual', ref: '' }, now + (queued + j) * PUSH_SPACING_MS)),
      );
      queued += ids.length;
    }
    return { queued };
  });

  // The lead's records in each CRM, and the CRMs it can be pushed to (for the lead drawer).
  app.get('/api/crm/leads/:id', async (req) => {
    const me = requireWriter(req);
    const { id } = parse(idParam, req.params);
    ctx.db.get('SELECT 1 FROM leads WHERE id = ? AND workspace_id = ?', [id, me.workspace_id]) ?? notFound('Lead');
    const links = ctx.db.all<{ integration_id: number; object_type: 'contact' | 'deal'; external_id: string; synced_at: number }>(
      'SELECT k.* FROM crm_links k JOIN integrations i ON i.id = k.integration_id WHERE k.lead_id = ? AND i.workspace_id = ? ORDER BY k.integration_id, k.object_type',
      [id, me.workspace_id],
    );
    const crms = activeCrms(ctx, me.workspace_id);
    const all = ctx.db.all<IntegrationRow>("SELECT * FROM integrations WHERE workspace_id = ? AND kind = 'crm'", [me.workspace_id]);
    return {
      crms: crms.map((r) => ({ id: r.id, label: r.label, provider: r.provider, simulated: !!providerDef('crm', r.provider)?.simulated })),
      links: links.map((k) => {
        const row = all.find((r) => r.id === k.integration_id)!;
        const inst = ctx.providers.instance<'crm'>(row);
        return { integrationId: k.integration_id, integration: row.label, provider: row.provider, objectType: k.object_type, externalId: k.external_id, url: inst?.recordUrl?.(k.object_type, k.external_id) ?? null, syncedAt: k.synced_at };
      }),
    };
  });
}

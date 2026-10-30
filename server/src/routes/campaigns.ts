import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { CampaignSettingsSchema, defaultSequence, SequenceSchema, validateSequence, type Sequence } from '../engine/sequence.js';
import { leadVars, render, unknownVariables, VARIABLE_NAMES } from '../engine/template.js';
import { HttpError, idParam, notFound, parse, user } from '../http.js';
import { addLeadsToCampaign, campaignSequence } from '../services/leads.js';
import type { CampaignRow, LeadRow } from '../types.js';
import { serializeLead } from './leads.js';

export function campaignStats(ctx: Ctx, campaignId: number) {
  const states = Object.fromEntries(
    ctx.db.all<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ? GROUP BY state', [campaignId]).map((r) => [r.state, r.n]),
  );
  const acts = Object.fromEntries(
    ctx.db
      .all<{ type: string; n: number }>("SELECT type, COUNT(DISTINCT lead_id) AS n FROM activity WHERE campaign_id = ? AND status = 'ok' GROUP BY type", [campaignId])
      .map((r) => [r.type, r.n]),
  );
  const atNode = Object.fromEntries(
    ctx.db.all<{ node_id: string; n: number }>("SELECT node_id, COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ? AND state = 'active' GROUP BY node_id", [campaignId]).map((r) => [r.node_id, r.n]),
  );
  const total = Object.values(states).reduce((a, b) => a + b, 0);
  const invited = acts.connect ?? 0;
  const accepted = acts.accepted ?? 0;
  const messaged = acts.message ?? 0;
  const replied = acts.replied ?? 0;
  const contacted = ctx.db.get<{ n: number }>(
    "SELECT COUNT(DISTINCT lead_id) AS n FROM activity WHERE campaign_id = ? AND status = 'ok' AND type IN ('connect', 'message', 'email')",
    [campaignId],
  )!.n;
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return {
    total,
    active: states.active ?? 0,
    done: states.done ?? 0,
    replied: states.replied ?? 0,
    failed: states.failed ?? 0,
    skipped: states.skipped ?? 0,
    actions: acts,
    funnel: { viewed: acts.view_profile ?? 0, invited, accepted, messaged, emailed: acts.email ?? 0, replied, contacted },
    acceptanceRate: pct(accepted, invited),
    replyRate: pct(replied, contacted),
    atNode,
  };
}

const settingsPatch = CampaignSettingsSchema.partial();

export function campaignRoutes(app: FastifyInstance, ctx: Ctx) {
  const load = (req: any): CampaignRow => {
    const { id } = parse(idParam, req.params);
    return ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?', [id, user(req).workspace_id]) ?? notFound('Campaign');
  };
  const ownsAccount = (req: any, accountId: number | null | undefined) => {
    if (accountId == null) return;
    if (!ctx.db.get('SELECT 1 FROM accounts WHERE id = ? AND workspace_id = ?', [accountId, user(req).workspace_id])) notFound('Account');
  };

  const serialize = (c: CampaignRow, full = false) => {
    const seq = campaignSequence(c);
    const account = c.account_id ? ctx.db.get<{ id: number; name: string; status: string }>('SELECT id, name, status FROM accounts WHERE id = ?', [c.account_id]) : null;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      account: account ?? null,
      accountId: c.account_id,
      settings: CampaignSettingsSchema.parse(json(c.settings, {})),
      createdAt: c.created_at,
      startedAt: c.started_at,
      stats: campaignStats(ctx, c.id),
      steps: Object.keys(seq.nodes).length,
      ...(full ? { sequence: seq, problems: validateSequence(seq), warnings: sequenceWarnings(seq) } : {}),
    };
  };

  app.get('/api/campaigns', async (req) => {
    return ctx.db.all<CampaignRow>('SELECT * FROM campaigns WHERE workspace_id = ? ORDER BY id DESC', [user(req).workspace_id]).map((c) => serialize(c));
  });

  app.get('/api/campaigns/:id', async (req) => serialize(load(req), true));

  app.post('/api/campaigns', async (req) => {
    const body = parse(z.object({ name: z.string().min(1).max(150), accountId: z.number().int().nullable().optional(), sequence: SequenceSchema.optional(), settings: settingsPatch.optional() }), req.body);
    ownsAccount(req, body.accountId);
    const id = ctx.db.insert('campaigns', {
      workspace_id: user(req).workspace_id,
      account_id: body.accountId ?? null,
      name: body.name,
      status: 'draft',
      sequence: JSON.stringify(body.sequence ?? defaultSequence()),
      settings: JSON.stringify(CampaignSettingsSchema.parse(body.settings ?? {})),
      created_at: ctx.clock.now(),
    });
    return serialize(ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [id])!, true);
  });

  app.patch('/api/campaigns/:id', async (req) => {
    const c = load(req);
    const body = parse(z.object({ name: z.string().min(1).max(150), accountId: z.number().int().nullable(), sequence: SequenceSchema, settings: settingsPatch }).partial(), req.body);
    ownsAccount(req, body.accountId);
    const cols: Record<string, any> = {};
    if (body.name) cols.name = body.name;
    if (body.accountId !== undefined) {
      if (c.status === 'active' && body.accountId !== c.account_id) throw new HttpError(409, 'Pause the campaign before switching its LinkedIn account');
      cols.account_id = body.accountId;
    }
    if (body.settings) cols.settings = JSON.stringify(CampaignSettingsSchema.parse({ ...json(c.settings, {}), ...body.settings }));
    if (body.sequence) {
      const problems = validateSequence(body.sequence);
      if (problems.length && c.status === 'active') throw new HttpError(400, problems[0], problems);
      cols.sequence = JSON.stringify(body.sequence);
    }
    ctx.db.tx(() => {
      ctx.db.update('campaigns', c.id, cols);
      if (body.sequence) reconcile(ctx, c.id, body.sequence);
    });
    return serialize(ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [c.id])!, true);
  });

  app.post('/api/campaigns/:id/start', async (req) => {
    const c = load(req);
    if (!c.account_id) throw new HttpError(400, 'Choose a LinkedIn account for this campaign first');
    const problems = validateSequence(campaignSequence(c));
    if (problems.length) throw new HttpError(400, problems[0], problems);
    if (!campaignSequence(c).start) throw new HttpError(400, 'Add at least one step');
    ctx.db.run("UPDATE campaigns SET status = 'active', started_at = COALESCE(started_at, ?) WHERE id = ?", [ctx.clock.now(), c.id]);
    return serialize(load(req));
  });

  app.post('/api/campaigns/:id/pause', async (req) => {
    const c = load(req);
    ctx.db.run("UPDATE campaigns SET status = 'paused' WHERE id = ?", [c.id]);
    return serialize(load(req));
  });

  app.post('/api/campaigns/:id/duplicate', async (req) => {
    const c = load(req);
    const id = ctx.db.insert('campaigns', { workspace_id: c.workspace_id, account_id: c.account_id, name: `${c.name} (copy)`, status: 'draft', sequence: c.sequence, settings: c.settings, created_at: ctx.clock.now() });
    return { id };
  });

  app.delete('/api/campaigns/:id', async (req) => {
    const c = load(req);
    ctx.db.run('DELETE FROM campaigns WHERE id = ?', [c.id]);
    return { ok: true };
  });

  app.post('/api/campaigns/:id/leads', async (req) => {
    const c = load(req);
    const body = parse(z.object({ listId: z.number().int().optional(), leadIds: z.array(z.number().int()).max(50000).optional() }), req.body);
    let ids = body.leadIds ?? [];
    if (body.listId) ids = ids.concat(ctx.db.all<{ id: number }>('SELECT id FROM leads WHERE list_id = ? AND workspace_id = ?', [body.listId, c.workspace_id]).map((r) => r.id));
    if (!ids.length) throw new HttpError(400, 'No leads to add');
    return addLeadsToCampaign(ctx, c, [...new Set(ids)]);
  });

  app.post('/api/campaigns/:id/leads/remove', async (req) => {
    const c = load(req);
    const { leadIds } = parse(z.object({ leadIds: z.array(z.number().int()).min(1) }), req.body);
    const r = ctx.db.run(`DELETE FROM campaign_leads WHERE campaign_id = ? AND lead_id IN (${leadIds.map(Number).join(',')})`, [c.id]);
    return { removed: r.changes };
  });

  app.get('/api/campaigns/:id/leads', async (req) => {
    const c = load(req);
    const q = parse(z.object({ state: z.string().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(50) }), req.query);
    const where = q.state ? 'AND cl.state = $state' : '';
    const p = { c: c.id, ...(q.state ? { state: q.state } : {}) };
    const total = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM campaign_leads cl WHERE cl.campaign_id = $c ${where}`, p)!.n;
    const rows = ctx.db.all<LeadRow & { cl_state: string; node_id: string; node_type: string; next_run_at: number; last_error: string; added_at: number }>(
      `SELECT l.*, cl.state AS cl_state, cl.node_id, cl.node_type, cl.next_run_at, cl.last_error, cl.added_at
       FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.campaign_id = $c ${where}
       ORDER BY cl.id LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
      p,
    );
    return {
      total,
      items: rows.map((r) => ({ lead: serializeLead(r), state: r.cl_state, nodeId: r.node_id, nodeType: r.node_type, nextRunAt: r.next_run_at, lastError: r.last_error, addedAt: r.added_at })),
    };
  });

  app.post('/api/templates/preview', async (req) => {
    const body = parse(z.object({ template: z.string().max(20000), leadId: z.number().int().optional() }), req.body);
    const lead =
      (body.leadId && ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [body.leadId, user(req).workspace_id])) ||
      ctx.db.get<LeadRow>('SELECT * FROM leads WHERE workspace_id = ? ORDER BY id DESC LIMIT 1', [user(req).workspace_id]);
    const vars = lead
      ? leadVars({ ...lead, custom: json(lead.custom, {}) })
      : { firstName: 'Ava', lastName: 'Thompson', fullName: 'Ava Thompson', company: 'Northwind Labs', title: 'Head of Growth', headline: 'Head of Growth at Northwind Labs', location: 'London, UK', email: '' };
    const custom = lead ? Object.keys(json(lead.custom, {})) : [];
    return { text: render(body.template, vars), length: render(body.template, vars).length, unknown: unknownVariables(body.template, [...VARIABLE_NAMES, ...custom]), sampleLead: vars.fullName };
  });
}

function sequenceWarnings(seq: Sequence): string[] {
  const out: string[] = [];
  for (const n of Object.values(seq.nodes)) {
    if (n.type === 'connect' && n.note.length > 300) out.push('An invitation note is over 300 characters and will be shortened.');
    for (const text of n.type === 'message' ? [n.text] : n.type === 'connect' ? [n.note] : n.type === 'email' ? [n.subject, n.body] : []) {
      const unknown = unknownVariables(text);
      if (unknown.length) out.push(`Unknown variable${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `{{${u}}}`).join(', ')}: they are blank unless a lead has a custom field with that name.`);
    }
  }
  return [...new Set(out)];
}

// After a sequence edit, leads standing on removed steps finish; the rest re-evaluate now.
function reconcile(ctx: Ctx, campaignId: number, seq: Sequence) {
  const now = ctx.clock.now();
  const active = ctx.db.all<{ id: number; node_id: string | null }>("SELECT id, node_id FROM campaign_leads WHERE campaign_id = ? AND state = 'active'", [campaignId]);
  for (const cl of active) {
    const node = cl.node_id ? seq.nodes[cl.node_id] : undefined;
    if (!node) ctx.db.update('campaign_leads', cl.id, { state: 'done', finished_at: now, node_id: null, node_type: null });
    else ctx.db.update('campaign_leads', cl.id, { node_type: node.type, next_run_at: now });
  }
}

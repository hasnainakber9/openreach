import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { CampaignSettingsSchema, defaultSequence, isAbTest, isVariantNode, nodeVariants, SequenceSchema, validateSequence, VARIANT_IDS, type Sequence } from '../engine/sequence.js';
import { leadVars, render, unknownVariables, VARIABLE_NAMES } from '../engine/template.js';
import { setWinner, syncVariants, variantReport } from '../engine/variants.js';
import { HttpError, idParam, notFound, parse, requireWriter, user } from '../http.js';
import { contactTypesSql } from '../services/activity.js';
import { addLeadsToCampaign, campaignSequence } from '../services/leads.js';
import { campaignAccountIds, campaignAccounts, setCampaignAccounts } from '../services/rotation.js';
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
    `SELECT COUNT(DISTINCT lead_id) AS n FROM activity WHERE campaign_id = ? AND status = 'ok' AND type IN (${contactTypesSql()})`,
    [campaignId],
  )!.n;
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
    bySender: senderStats(ctx, campaignId),
  };
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

// Results per sending account: current senders plus any account that pinned or worked a lead here.
function senderStats(ctx: Ctx, campaignId: number) {
  const acts = ctx.db.all<{ account_id: number; type: string; n: number }>(
    "SELECT account_id, type, COUNT(DISTINCT lead_id) AS n FROM activity WHERE campaign_id = ? AND status = 'ok' AND account_id IS NOT NULL GROUP BY account_id, type",
    [campaignId],
  );
  const contacted = ctx.db.all<{ account_id: number; n: number }>(
    `SELECT account_id, COUNT(DISTINCT lead_id) AS n FROM activity WHERE campaign_id = ? AND status = 'ok' AND account_id IS NOT NULL AND type IN (${contactTypesSql()}) GROUP BY account_id`,
    [campaignId],
  );
  const pinned = ctx.db.all<{ account_id: number; n: number; active: number }>(
    "SELECT account_id, COUNT(*) AS n, SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active FROM campaign_leads WHERE campaign_id = ? AND account_id IS NOT NULL GROUP BY account_id",
    [campaignId],
  );
  const ids = [...new Set([...campaignAccountIds(ctx, campaignId), ...pinned.map((r) => r.account_id), ...acts.map((r) => r.account_id)])];
  return ids.map((id) => {
    const account = ctx.db.get<{ name: string; status: string }>('SELECT name, status FROM accounts WHERE id = ?', [id]);
    const n = (type: string) => acts.find((r) => r.account_id === id && r.type === type)?.n ?? 0;
    const p = pinned.find((r) => r.account_id === id);
    const invited = n('connect');
    const accepted = n('accepted');
    const replied = n('replied');
    const reached = contacted.find((r) => r.account_id === id)?.n ?? 0;
    return {
      accountId: id,
      name: account?.name ?? 'Removed account',
      status: account?.status ?? 'removed',
      leads: p?.n ?? 0,
      active: p?.active ?? 0,
      invited,
      accepted,
      messaged: n('message'),
      replied,
      acceptanceRate: pct(accepted, invited),
      replyRate: pct(replied, reached),
    };
  });
}

const settingsPatch = CampaignSettingsSchema.partial();
const accountIdsSchema = z.array(z.number().int().positive()).max(20);

export function campaignRoutes(app: FastifyInstance, ctx: Ctx) {
  const load = (req: any): CampaignRow => {
    const { id } = parse(idParam, req.params);
    return ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?', [id, user(req).workspace_id]) ?? notFound('Campaign');
  };
  // Sender list from a create/patch body. `accountId` (one sender) is still accepted for older clients.
  // Every id must belong to the caller's workspace; a foreign id is a 404 like any other row.
  const senderIds = (req: any, body: { accountIds?: number[]; accountId?: number | null }): number[] | undefined => {
    const ids = body.accountIds ?? (body.accountId === undefined ? undefined : body.accountId === null ? [] : [body.accountId]);
    if (!ids) return undefined;
    const unique = [...new Set(ids)];
    if (!unique.length) return unique;
    const found = ctx.db.all<{ id: number }>(`SELECT id FROM accounts WHERE workspace_id = ? AND id IN (${unique.map(() => '?').join(',')})`, [user(req).workspace_id, ...unique]);
    if (found.length !== unique.length) notFound('Account');
    return unique;
  };

  const serialize = (c: CampaignRow, full = false) => {
    const seq = campaignSequence(c);
    const accounts = campaignAccounts(ctx, c.id);
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      // `account`/`accountId` are the first sender, kept for older clients.
      account: accounts[0] ?? null,
      accountId: accounts[0]?.id ?? null,
      accounts,
      accountIds: accounts.map((a) => a.id),
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
    requireWriter(req);
    const body = parse(
      z.object({ name: z.string().min(1).max(150), accountId: z.number().int().nullable().optional(), accountIds: accountIdsSchema.optional(), sequence: SequenceSchema.optional(), settings: settingsPatch.optional() }),
      req.body,
    );
    const senders = senderIds(req, body) ?? [];
    const id = ctx.db.tx(() => {
      const id = ctx.db.insert('campaigns', {
        workspace_id: user(req).workspace_id,
        account_id: senders[0] ?? null,
        name: body.name,
        status: 'draft',
        sequence: JSON.stringify(body.sequence ?? defaultSequence()),
        settings: JSON.stringify(CampaignSettingsSchema.parse(body.settings ?? {})),
        created_at: ctx.clock.now(),
      });
      setCampaignAccounts(ctx, id, senders);
      return id;
    });
    return serialize(ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [id])!, true);
  });

  app.patch('/api/campaigns/:id', async (req) => {
    requireWriter(req);
    const c = load(req);
    const body = parse(z.object({ name: z.string().min(1).max(150), accountId: z.number().int().nullable(), accountIds: accountIdsSchema, sequence: SequenceSchema, settings: settingsPatch }).partial(), req.body);
    // Senders can change while the campaign runs: leads they already contacted stay with them.
    const senders = senderIds(req, body);
    if (senders && !senders.length && c.status === 'active') throw new HttpError(409, 'A running campaign needs at least one LinkedIn account. Pause it first.');
    const cols: Record<string, any> = {};
    if (body.name) cols.name = body.name;
    if (body.settings) cols.settings = JSON.stringify(CampaignSettingsSchema.parse({ ...json(c.settings, {}), ...body.settings }));
    if (body.sequence) {
      const problems = validateSequence(body.sequence);
      if (problems.length && c.status === 'active') throw new HttpError(400, problems[0], problems);
      cols.sequence = JSON.stringify(body.sequence);
    }
    ctx.db.tx(() => {
      ctx.db.update('campaigns', c.id, cols);
      if (senders) setCampaignAccounts(ctx, c.id, senders);
      if (body.sequence) {
        syncVariants(ctx, c.id, campaignSequence(c), body.sequence);
        reconcile(ctx, c.id, body.sequence);
      }
    });
    return serialize(ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [c.id])!, true);
  });

  app.post('/api/campaigns/:id/start', async (req) => {
    requireWriter(req);
    const c = load(req);
    if (!campaignAccountIds(ctx, c.id).length) throw new HttpError(400, 'Choose a LinkedIn account for this campaign first');
    const problems = validateSequence(campaignSequence(c));
    if (problems.length) throw new HttpError(400, problems[0], problems);
    if (!campaignSequence(c).start) throw new HttpError(400, 'Add at least one step');
    ctx.db.run("UPDATE campaigns SET status = 'active', started_at = COALESCE(started_at, ?) WHERE id = ?", [ctx.clock.now(), c.id]);
    return serialize(load(req));
  });

  app.post('/api/campaigns/:id/pause', async (req) => {
    requireWriter(req);
    const c = load(req);
    ctx.db.run("UPDATE campaigns SET status = 'paused' WHERE id = ?", [c.id]);
    return serialize(load(req));
  });

  app.post('/api/campaigns/:id/duplicate', async (req) => {
    requireWriter(req);
    const c = load(req);
    const id = ctx.db.tx(() => {
      const id = ctx.db.insert('campaigns', { workspace_id: c.workspace_id, account_id: c.account_id, name: `${c.name} (copy)`, status: 'draft', sequence: c.sequence, settings: c.settings, created_at: ctx.clock.now() });
      setCampaignAccounts(ctx, id, campaignAccountIds(ctx, c.id));
      return id;
    });
    return { id };
  });

  app.delete('/api/campaigns/:id', async (req) => {
    requireWriter(req);
    const c = load(req);
    ctx.db.run('DELETE FROM campaigns WHERE id = ?', [c.id]);
    return { ok: true };
  });

  app.post('/api/campaigns/:id/leads', async (req) => {
    requireWriter(req);
    const c = load(req);
    const body = parse(z.object({ listId: z.number().int().optional(), leadIds: z.array(z.number().int()).max(50000).optional() }), req.body);
    let ids = body.leadIds ?? [];
    if (body.listId) ids = ids.concat(ctx.db.all<{ id: number }>('SELECT id FROM leads WHERE list_id = ? AND workspace_id = ?', [body.listId, c.workspace_id]).map((r) => r.id));
    if (!ids.length) throw new HttpError(400, 'No leads to add');
    return addLeadsToCampaign(ctx, c, [...new Set(ids)]);
  });

  app.post('/api/campaigns/:id/leads/remove', async (req) => {
    requireWriter(req);
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
    const rows = ctx.db.all<LeadRow & { cl_state: string; node_id: string; node_type: string; next_run_at: number; last_error: string; added_at: number; sender_id: number | null; sender_name: string | null }>(
      `SELECT l.*, cl.state AS cl_state, cl.node_id, cl.node_type, cl.next_run_at, cl.last_error, cl.added_at, s.id AS sender_id, s.name AS sender_name
       FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id LEFT JOIN accounts s ON s.id = cl.account_id WHERE cl.campaign_id = $c ${where}
       ORDER BY cl.id LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
      p,
    );
    return {
      total,
      items: rows.map((r) => ({ lead: serializeLead(r), state: r.cl_state, nodeId: r.node_id, nodeType: r.node_type, nextRunAt: r.next_run_at, lastError: r.last_error, addedAt: r.added_at, sender: r.sender_id ? { id: r.sender_id, name: r.sender_name! } : null })),
    };
  });

  // ---- A/B tests ---------------------------------------------------------------
  app.get('/api/campaigns/:id/variants', async (req) => {
    const c = load(req);
    return { nodes: variantReport(ctx, c, campaignSequence(c)) };
  });

  // Picks a step's winner by hand (every later lead gets it), or null to split again (auto-pick then stays off).
  app.post('/api/campaigns/:id/nodes/:nodeId/winner', async (req) => {
    const u = requireWriter(req);
    const c = load(req);
    const { nodeId } = parse(z.object({ nodeId: z.string().min(1).max(64) }), req.params);
    const { variant } = parse(z.object({ variant: z.enum(VARIANT_IDS).nullable() }), req.body);
    const node = campaignSequence(c).nodes[nodeId];
    if (!node || !isAbTest(node)) notFound('A/B test step');
    if (variant && !nodeVariants(node).some((v) => v.id === variant)) throw new HttpError(400, `This step has no variant ${variant}`);
    ctx.db.tx(() => setWinner(ctx, c, nodeId, variant, 'user', u.name));
    return { nodes: variantReport(ctx, c, campaignSequence(c)) };
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
    if (!isVariantNode(n)) continue;
    // Every variant is checked, not just the one in the single-text fields.
    const variants = nodeVariants(n);
    if (n.type === 'connect' && variants.some((v) => (v.note ?? '').length > 300)) out.push('An invitation note is over 300 characters and will be shortened.');
    if (n.abtest?.autoPickAfter && !isAbTest(n)) out.push('Automatic winner picking only works on a step with A/B variants.');
    for (const text of variants.flatMap((v) => [v.note, v.text, v.subject, v.body]).filter((t): t is string => t != null)) {
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

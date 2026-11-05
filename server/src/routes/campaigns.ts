import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { ACTION_TYPES, CHANNEL_NODE_TYPES, CampaignSettingsSchema, defaultSequence, type CampaignSettings, isAbTest, isVariantNode, nodeVariants, precededBy, SequenceSchema, validateSequence, VARIANT_IDS, type Sequence } from '../engine/sequence.js';
import { leadVars, render, unknownVariables, VARIABLE_NAMES } from '../engine/template.js';
import { setWinner, syncVariants, variantReport } from '../engine/variants.js';
import { HttpError, idParam, notFound, parse, requireWriter, user } from '../http.js';
import { contactTypesSql } from '../services/activity.js';
import { addLeadsToCampaign, campaignSequence, campaignSettings } from '../services/leads.js';
import { isWorkspaceMember, skipOpenTasks } from '../services/tasks.js';
import { campaignAccountIds, campaignAccounts, setCampaignAccounts } from '../services/rotation.js';
import { campaignMailboxes, campaignMailboxIds, setCampaignMailboxes } from '../mail/mailboxes.js';
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
    // Email results (opens and clicks only when tracking is on; scanners can inflate them).
    email: {
      sent: acts.email ?? 0,
      opened: acts.email_open ?? 0,
      clicked: acts.email_click ?? 0,
      bounced: ctx.db.get<{ n: number }>("SELECT COUNT(DISTINCT lead_id) AS n FROM activity WHERE campaign_id = ? AND type = 'email_bounce'", [campaignId])!.n,
    },
    byMailbox: mailboxStats(ctx, campaignId),
  };
}

// Results per mailbox: current campaign mailboxes plus any mailbox that emailed leads here.
function mailboxStats(ctx: Ctx, campaignId: number) {
  // Leads, not emails: a lead who got three emails counts once.
  const rows = ctx.db.all<{ mailbox_id: number; sent: number; replied: number; bounced: number }>(
    `SELECT mailbox_id,
            COUNT(DISTINCT CASE WHEN direction = 'out' AND status IN ('sent', 'simulated', 'bounced') THEN lead_id END) AS sent,
            COUNT(DISTINCT CASE WHEN direction = 'in' AND status = 'received' THEN lead_id END) AS replied,
            COUNT(DISTINCT CASE WHEN direction = 'out' AND status = 'bounced' THEN lead_id END) AS bounced
     FROM email_messages WHERE campaign_id = ? GROUP BY mailbox_id`,
    [campaignId],
  );
  const pinned = ctx.db.all<{ mailbox_id: number; n: number }>('SELECT mailbox_id, COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ? AND mailbox_id IS NOT NULL GROUP BY mailbox_id', [campaignId]);
  const ids = [...new Set([...campaignMailboxIds(ctx, campaignId), ...pinned.map((r) => r.mailbox_id), ...rows.map((r) => r.mailbox_id)])];
  return ids.map((id) => {
    const mb = ctx.db.get<{ name: string; status: string }>('SELECT name, status FROM mailboxes WHERE id = ?', [id]);
    const r = rows.find((x) => x.mailbox_id === id) ?? { sent: 0, replied: 0, bounced: 0 };
    return { mailboxId: id, name: mb?.name ?? 'Removed mailbox', status: mb?.status ?? 'removed', leads: pinned.find((p) => p.mailbox_id === id)?.n ?? 0, sent: r.sent, replied: r.replied, bounced: r.bounced, replyRate: pct(r.replied, r.sent) };
  });
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
  // Same rules for the campaign's mailboxes (email steps rotate across them).
  const mailboxIdList = (req: any, ids: number[] | undefined): number[] | undefined => {
    if (!ids) return undefined;
    const unique = [...new Set(ids)];
    if (!unique.length) return unique;
    const found = ctx.db.all<{ id: number }>(`SELECT id FROM mailboxes WHERE workspace_id = ? AND id IN (${unique.map(() => '?').join(',')})`, [user(req).workspace_id, ...unique]);
    if (found.length !== unique.length) notFound('Mailbox');
    return unique;
  };
  // Task steps may only be assigned to members of this workspace (re-checked when a task is created).
  const checkAssignees = (req: any, seq: Sequence | undefined) => {
    for (const n of Object.values(seq?.nodes ?? {})) {
      if (n.type === 'task' && n.assigneeId != null && !isWorkspaceMember(ctx, user(req).workspace_id, n.assigneeId)) notFound('User');
    }
  };

  const serialize = (c: CampaignRow, full = false) => {
    const seq = campaignSequence(c);
    const settings = campaignSettings(c);
    const accounts = campaignAccounts(ctx, c.id);
    const mailboxes = campaignMailboxes(ctx, c.id);
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      // `account`/`accountId` are the first sender, kept for older clients.
      account: accounts[0] ?? null,
      accountId: accounts[0]?.id ?? null,
      accounts,
      accountIds: accounts.map((a) => a.id),
      mailboxes,
      mailboxIds: mailboxes.map((m) => m.id),
      settings,
      createdAt: c.created_at,
      startedAt: c.started_at,
      stats: campaignStats(ctx, c.id),
      steps: Object.keys(seq.nodes).length,
      ...(full ? { sequence: seq, problems: validateSequence(seq), warnings: [...sequenceWarnings(seq, settings), ...senderWarnings(ctx, seq, settings, mailboxes.length), ...channelWarnings(ctx, c.workspace_id, seq)] } : {}),
    };
  };

  app.get('/api/campaigns', async (req) => {
    return ctx.db.all<CampaignRow>('SELECT * FROM campaigns WHERE workspace_id = ? ORDER BY id DESC', [user(req).workspace_id]).map((c) => serialize(c));
  });

  app.get('/api/campaigns/:id', async (req) => serialize(load(req), true));

  app.post('/api/campaigns', async (req) => {
    requireWriter(req);
    const body = parse(
      z.object({
        name: z.string().min(1).max(150),
        accountId: z.number().int().nullable().optional(),
        accountIds: accountIdsSchema.optional(),
        mailboxIds: accountIdsSchema.optional(),
        sequence: SequenceSchema.optional(),
        settings: settingsPatch.optional(),
      }),
      req.body,
    );
    const senders = senderIds(req, body) ?? [];
    const mailboxIds = mailboxIdList(req, body.mailboxIds) ?? [];
    checkAssignees(req, body.sequence);
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
      setCampaignMailboxes(ctx, id, mailboxIds);
      return id;
    });
    return serialize(ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [id])!, true);
  });

  app.patch('/api/campaigns/:id', async (req) => {
    requireWriter(req);
    const c = load(req);
    const body = parse(z.object({ name: z.string().min(1).max(150), accountId: z.number().int().nullable(), accountIds: accountIdsSchema, mailboxIds: accountIdsSchema, sequence: SequenceSchema, settings: settingsPatch }).partial(), req.body);
    // Senders and mailboxes can change while the campaign runs: leads they already contacted stay with them.
    const senders = senderIds(req, body);
    const mailboxIds = mailboxIdList(req, body.mailboxIds);
    checkAssignees(req, body.sequence);
    if (c.status === 'active' && (senders || mailboxIds || body.sequence)) {
      const problem = senderProblem(body.sequence ?? campaignSequence(c), (senders ?? campaignAccountIds(ctx, c.id)).length, (mailboxIds ?? campaignMailboxIds(ctx, c.id)).length);
      if (problem) throw new HttpError(409, `${problem} Pause the campaign first.`);
    }
    const cols: Record<string, any> = {};
    if (body.name) cols.name = body.name;
    if (body.settings) cols.settings = JSON.stringify(CampaignSettingsSchema.parse({ ...campaignSettings(c), ...body.settings }));
    if (body.sequence) {
      const problems = validateSequence(body.sequence);
      if (problems.length && c.status === 'active') throw new HttpError(400, problems[0], problems);
      cols.sequence = JSON.stringify(body.sequence);
    }
    ctx.db.tx(() => {
      ctx.db.update('campaigns', c.id, cols);
      if (senders) setCampaignAccounts(ctx, c.id, senders);
      if (mailboxIds) setCampaignMailboxes(ctx, c.id, mailboxIds);
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
    const sendersProblem = senderProblem(campaignSequence(c), campaignAccountIds(ctx, c.id).length, campaignMailboxIds(ctx, c.id).length);
    if (sendersProblem) throw new HttpError(400, sendersProblem);
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
      setCampaignMailboxes(ctx, id, campaignMailboxIds(ctx, c.id));
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
    const rows = ctx.db.all<LeadRow & { cl_state: string; node_id: string; node_type: string; next_run_at: number; last_error: string; added_at: number; sender_id: number | null; sender_name: string | null; mb_id: number | null; mb_name: string | null }>(
      `SELECT l.*, cl.state AS cl_state, cl.node_id, cl.node_type, cl.next_run_at, cl.last_error, cl.added_at, s.id AS sender_id, s.name AS sender_name, mb.id AS mb_id, mb.name AS mb_name
       FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id LEFT JOIN accounts s ON s.id = cl.account_id LEFT JOIN mailboxes mb ON mb.id = cl.mailbox_id WHERE cl.campaign_id = $c ${where}
       ORDER BY cl.id LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
      p,
    );
    return {
      total,
      items: rows.map((r) => ({ lead: serializeLead(r), state: r.cl_state, nodeId: r.node_id, nodeType: r.node_type, nextRunAt: r.next_run_at, lastError: r.last_error, addedAt: r.added_at, sender: r.sender_id ? { id: r.sender_id, name: r.sender_name! } : null, mailbox: r.mb_id ? { id: r.mb_id, name: r.mb_name! } : null })),
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
    const body = parse(
      z.object({
        template: z.string().max(20000),
        leadId: z.number().int().optional(),
        // With a campaign, its {{ai:name}} variables are known: they show `aiValues` (from an AI preview),
        // else the fallback, else a marker where the text will go.
        campaignId: z.number().int().positive().optional(),
        aiValues: z.record(z.string().max(500)).optional(),
      }),
      req.body,
    );
    const ai = body.campaignId
      ? campaignSettings(ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?', [body.campaignId, user(req).workspace_id]) ?? notFound('Campaign')).aiVariables
      : [];
    const lead =
      (body.leadId && ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [body.leadId, user(req).workspace_id])) ||
      ctx.db.get<LeadRow>('SELECT * FROM leads WHERE workspace_id = ? ORDER BY id DESC LIMIT 1', [user(req).workspace_id]);
    const vars = lead
      ? leadVars({ ...lead, custom: json(lead.custom, {}) })
      : { firstName: 'Ava', lastName: 'Thompson', fullName: 'Ava Thompson', company: 'Northwind Labs', title: 'Head of Growth', headline: 'Head of Growth at Northwind Labs', location: 'London, UK', email: '' };
    const custom = lead ? Object.keys(json(lead.custom, {})) : [];
    for (const v of ai) vars[`ai:${v.name}`] = body.aiValues?.[v.name] ?? (v.fallback || `[ai:${v.name}]`);
    const text = render(body.template, vars);
    return { text, length: text.length, unknown: unknownVariables(body.template, [...VARIABLE_NAMES, ...custom], ai.map((v) => v.name)), sampleLead: vars.fullName };
  });
}

// Who sends what: LinkedIn steps need a LinkedIn account; LinkedIn and email steps need at least one sender of
// either kind. Tasks and SMS/WhatsApp steps need neither (SMS goes through the workspace's SMS provider).
function senderProblem(seq: Sequence, accounts: number, mailboxes: number): string | null {
  const sends = Object.values(seq.nodes).some((n) => (ACTION_TYPES as readonly string[]).includes(n.type));
  if (sends && !accounts && !mailboxes) return 'Choose a LinkedIn account or a mailbox for this campaign first.';
  const linkedIn = Object.values(seq.nodes).some((n) => (ACTION_TYPES as readonly string[]).includes(n.type) && n.type !== 'email');
  if (linkedIn && !accounts) return 'This sequence has LinkedIn steps: choose a LinkedIn account for this campaign.';
  return null;
}

function senderWarnings(ctx: Ctx, seq: Sequence, settings: CampaignSettings, mailboxes: number): string[] {
  const emails = Object.values(seq.nodes).filter((n) => n.type === 'email');
  if (!emails.length) return [];
  const out: string[] = [];
  if (!mailboxes) out.push('Email steps have no mailbox: they go out through the LinkedIn account’s old SMTP settings, or are only recorded (not delivered) without them. Choose mailboxes in the campaign settings.');
  if ((settings.trackOpens || settings.trackClicks) && !ctx.config.publicUrl) out.push('Open and click tracking need PUBLIC_URL on the server; without it emails go out untracked.');
  if (!mailboxes && emails.some((n) => n.type === 'email' && n.replyInThread)) out.push('"Reply in the same thread" only works when the campaign sends from mailboxes.');
  return out;
}

// SMS and WhatsApp steps go through the workspace's SMS provider; say when that is only the simulator.
function channelWarnings(ctx: Ctx, workspaceId: number, seq: Sequence): string[] {
  const nodes = Object.values(seq.nodes);
  if (!nodes.some((n) => (CHANNEL_NODE_TYPES as readonly string[]).includes(n.type))) return [];
  const out = ['SMS and WhatsApp steps only reach leads with a phone number (in international form, or with the SMS integration’s default country code).'];
  const sms = ctx.providers.get(workspaceId, 'sms');
  if (sms?.simulated) out.push('SMS and WhatsApp steps use the built-in simulator, so nothing is delivered. Add Twilio under Settings → Integrations to send for real.');
  else if (sms) {
    if (nodes.some((n) => n.type === 'sms') && !sms.policy.sms) out.push('The SMS integration has no SMS from number or Messaging Service, so SMS steps are skipped.');
    if (nodes.some((n) => n.type === 'whatsapp') && !sms.policy.whatsapp) out.push('The SMS integration has no WhatsApp sender, so WhatsApp steps are skipped.');
  }
  return out;
}

function sequenceWarnings(seq: Sequence, settings: CampaignSettings): string[] {
  const aiNames = settings.aiVariables.map((v) => v.name);
  const out: string[] = [];
  for (const n of Object.values(seq.nodes)) {
    // With stop-on-reply, only replies in "Keep going after these replies" ever reach a later step.
    if (n.type === 'condition' && n.kind === 'reply_sentiment' && settings.stopOnReply) {
      const keep = settings.continueOnCategories;
      if (!keep.length) out.push('A "reply is" condition never sees a reply while the campaign stops on replies: choose categories under "Keep going after these replies" in the settings, or turn off stop on reply.');
      else if ((n.categories ?? []).some((c) => !keep.includes(c))) out.push('A "reply is" condition checks categories that stop the campaign (they are not under "Keep going after these replies"), so those leads never reach it.');
    }
    // Open Profile status is only known once a profile view has seen it; before that the answer is No.
    if (n.type === 'condition' && n.kind === 'is_open_profile' && !precededBy(seq, n.id, 'view_profile')) {
      out.push('An "open profile" check needs a View profile step before it, or every lead goes down No.');
    }
    if (n.type === 'task' || n.type === 'whatsapp') {
      const unknown = unknownVariables(n.type === 'task' ? `${n.title} ${n.instructions}` : n.text, VARIABLE_NAMES, aiNames);
      if (unknown.length) out.push(`Unknown variable${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `{{${u}}}`).join(', ')}: they are blank unless a lead has a custom field with that name.`);
    }
    if (!isVariantNode(n)) continue;
    // Every variant is checked, not just the one in the single-text fields.
    const variants = nodeVariants(n);
    if (n.type === 'connect' && variants.some((v) => (v.note ?? '').length > 300)) out.push('An invitation note is over 300 characters and will be shortened.');
    if (n.abtest?.autoPickAfter && !isAbTest(n)) out.push('Automatic winner picking only works on a step with A/B variants.');
    for (const text of variants.flatMap((v) => [v.note, v.text, v.subject, v.body]).filter((t): t is string => t != null)) {
      const all = unknownVariables(text, VARIABLE_NAMES, aiNames);
      const unknownAi = all.filter((u) => u.startsWith('ai:'));
      const unknown = all.filter((u) => !u.startsWith('ai:'));
      if (unknownAi.length) out.push(`${unknownAi.map((u) => `{{${u}}}`).join(', ')} ${unknownAi.length > 1 ? 'are' : 'is'} not defined under AI variables in the campaign settings, so ${unknownAi.length > 1 ? 'they stay' : 'it stays'} blank.`);
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
    if (!node) {
      ctx.db.update('campaign_leads', cl.id, { state: 'done', finished_at: now, node_id: null, node_type: null, hold_reason: null });
      skipOpenTasks(ctx, cl.id, 'The task step was removed from the sequence');
    }
    else ctx.db.update('campaign_leads', cl.id, { node_type: node.type, next_run_at: now });
  }
}

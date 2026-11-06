import type { FastifyInstance } from 'fastify';
import { parse as parseCsv } from 'csv-parse/sync';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { csv, HttpError, idParam, notFound, parse, requireWriter, user } from '../http.js';
import { autoEnrichImported } from '../services/enrichment.js';
import { cancelImport, IMPORT_KINDS, serializeImport, sourceUrlProblem, startImport } from '../services/imports.js';
import { importLeads, type LeadInput } from '../services/leads.js';
import { effectiveStage, listStages, stageWhere } from '../services/pipeline.js';
import { canonicalTags, tagLike } from '../services/tags.js';
import { isWorkspaceMember } from '../services/tasks.js';
import type { AccountRow, ImportRow, LeadRow, StageRow } from '../types.js';

const FIELD_ALIASES: Record<string, keyof LeadInput | 'fullName'> = {
  profileurl: 'profileUrl', linkedinurl: 'profileUrl', linkedin: 'profileUrl', url: 'profileUrl', profile: 'profileUrl',
  linkedinprofile: 'profileUrl', linkedinprofileurl: 'profileUrl', publicprofileurl: 'profileUrl', personlinkedinurl: 'profileUrl',
  firstname: 'firstName', first: 'firstName', givenname: 'firstName',
  lastname: 'lastName', last: 'lastName', surname: 'lastName', familyname: 'lastName',
  name: 'fullName', fullname: 'fullName',
  company: 'company', companyname: 'company', organization: 'company', currentcompany: 'company', employer: 'company',
  title: 'title', jobtitle: 'title', position: 'title', role: 'title',
  headline: 'headline', location: 'location', city: 'location', region: 'location',
  email: 'email', emailaddress: 'email', workemail: 'email', phone: 'phone', phonenumber: 'phone', tags: 'tags',
};

// Custom fields are exported as custom_<name>; importing that file gives them their names back.
const CUSTOM_PREFIX = 'custom_';

const camel = (s: string) => s.trim().replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toLowerCase());

// Turns a CSV export from LinkedIn, Sales Navigator, a CRM or a spreadsheet into leads.
// Known columns map to lead fields; everything else becomes a custom field usable in templates.
export function csvToLeads(text: string): LeadInput[] {
  const rows: Record<string, string>[] = parseCsv(text.replace(/^﻿/, ''), { columns: true, skip_empty_lines: true, relax_column_count: true, trim: true });
  return rows.map((row) => {
    const lead: LeadInput = { profileUrl: '', custom: {} };
    for (const [header, value] of Object.entries(row)) {
      if (!value) continue;
      if (header.toLowerCase().startsWith(CUSTOM_PREFIX) && camel(header.slice(CUSTOM_PREFIX.length))) {
        lead.custom![camel(header.slice(CUSTOM_PREFIX.length))] = value;
        continue;
      }
      const field = FIELD_ALIASES[header.toLowerCase().replace(/[^a-z]/g, '')];
      if (field === 'fullName') {
        const [first, ...rest] = value.split(/\s+/);
        lead.firstName ||= first;
        lead.lastName ||= rest.join(' ');
      } else if (field === 'tags') lead.tags = value.split(/[;,|]/).map((t) => t.trim()).filter(Boolean);
      else if (field) (lead as any)[field] = value;
      else if (camel(header)) lead.custom![camel(header)] = value;
    }
    return lead;
  });
}

// Pass the workspace's stages to include the lead's pipeline stage (the first one when it has none).
export function serializeLead(l: LeadRow, stages?: StageRow[]) {
  const stage = stages ? effectiveStage(stages, l.stage_id) : undefined;
  return {
    id: l.id,
    listId: l.list_id,
    publicId: l.public_id,
    profileUrl: l.profile_url,
    firstName: l.first_name,
    lastName: l.last_name,
    headline: l.headline,
    title: l.title,
    company: l.company,
    location: l.location,
    email: l.email,
    phone: l.phone,
    tags: json<string[]>(l.tags, []),
    custom: json<Record<string, string>>(l.custom, {}),
    connectionStatus: l.connection_status,
    connectedAt: l.connected_at,
    repliedAt: l.replied_at,
    replyCategory: l.reply_category ?? null,
    emailStatus: l.email_status ?? null,
    emailStatusReason: l.email_status_reason ?? null,
    emailStatusAt: l.email_status_at ?? null,
    // NULL is an address saved before sources were recorded: it counts as the user's own.
    emailSource: l.email ? (l.email_source ?? 'user') : null,
    emailFoundAt: l.email_found_at ?? null,
    companyDomain: l.company_domain ?? null,
    enrichment: json<Record<string, unknown>>(l.enrichment, {}),
    enrichmentStatus: l.enrichment_status ?? null,
    enrichedAt: l.enriched_at ?? null,
    openProfile: l.open_profile == null ? null : l.open_profile === 1,
    stageId: stage?.id ?? l.stage_id ?? null,
    stage: stage ? { id: stage.id, slug: stage.slug, name: stage.name, color: stage.color, kind: stage.kind } : null,
    stageChangedAt: l.stage_changed_at ?? null,
    stageManual: l.stage_manual === 1,
    ownerId: l.owner_id ?? null,
    createdAt: l.created_at,
  };
}

const leadPatch = z.object({
  firstName: z.string().max(100),
  lastName: z.string().max(100),
  headline: z.string().max(500),
  title: z.string().max(200),
  company: z.string().max(200),
  location: z.string().max(200),
  email: z.string().email().nullable().or(z.literal('')),
  phone: z.string().max(50).nullable(),
  tags: z.array(z.string().max(50)).max(50),
  custom: z.record(z.string(), z.string()),
  listId: z.number().int().nullable(),
  // A workspace member, or null for nobody.
  ownerId: z.number().int().positive().nullable(),
}).partial();

export function leadRoutes(app: FastifyInstance, ctx: Ctx) {
  const list = (req: any, id: number) =>
    ctx.db.get<{ id: number }>('SELECT id FROM lead_lists WHERE id = ? AND workspace_id = ?', [id, user(req).workspace_id]) ?? notFound('List');

  app.get('/api/lists', async (req) => {
    return ctx.db.all(
      `SELECT l.id, l.name, l.created_at AS "createdAt", COUNT(ld.id) AS leads,
              SUM(CASE WHEN ld.connection_status = 'connected' THEN 1 WHEN ld.id IS NULL THEN NULL ELSE 0 END) AS connected
       FROM lead_lists l LEFT JOIN leads ld ON ld.list_id = l.id
       WHERE l.workspace_id = ? GROUP BY l.id ORDER BY l.id DESC`,
      [user(req).workspace_id],
    );
  });

  app.post('/api/lists', async (req) => {
    const body = parse(z.object({ name: z.string().min(1).max(100) }), req.body);
    return { id: ctx.db.insert('lead_lists', { workspace_id: user(req).workspace_id, name: body.name, created_at: ctx.clock.now() }) };
  });

  app.patch('/api/lists/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    list(req, id);
    const body = parse(z.object({ name: z.string().min(1).max(100) }), req.body);
    ctx.db.update('lead_lists', id, { name: body.name });
    return { ok: true };
  });

  app.delete('/api/lists/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    list(req, id);
    ctx.db.tx(() => {
      ctx.db.run('DELETE FROM leads WHERE list_id = ?', [id]);
      ctx.db.run('DELETE FROM lead_lists WHERE id = ?', [id]);
    });
    return { ok: true };
  });

  const leadQuery = z.object({
    listId: z.coerce.number().int().optional(),
    campaignId: z.coerce.number().int().optional(),
    q: z.string().optional(),
    status: z.enum(['none', 'pending', 'connected']).optional(),
    // unknown: an address nobody could confirm yet (never checked, or checked without a clear answer).
    emailStatus: z.enum(['valid', 'risky', 'invalid', 'unknown', 'missing']).optional(),
    enrichment: z.enum(['queued', 'done', 'not_found', 'failed', 'none']).optional(),
    stageId: z.coerce.number().int().positive().optional(),
    tag: z.string().trim().min(1).max(50).optional(),
    ownerId: z.union([z.enum(['me', 'none']), z.coerce.number().int().positive()]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(500).default(50),
  });

  const findLeads = (req: any, q: z.infer<typeof leadQuery>, paged = true) => {
    const where = ['l.workspace_id = $ws'];
    const p: Record<string, any> = { ws: user(req).workspace_id };
    if (q.listId) (where.push('l.list_id = $list'), (p.list = q.listId));
    if (q.campaignId) (where.push('l.id IN (SELECT lead_id FROM campaign_leads WHERE campaign_id = $camp)'), (p.camp = q.campaignId));
    if (q.status) (where.push('l.connection_status = $status'), (p.status = q.status));
    if (q.emailStatus === 'missing') where.push('l.email IS NULL');
    else if (q.emailStatus === 'unknown') where.push("l.email IS NOT NULL AND (l.email_status IS NULL OR l.email_status = 'unknown')");
    else if (q.emailStatus) (where.push('l.email IS NOT NULL AND l.email_status = $es'), (p.es = q.emailStatus));
    if (q.enrichment === 'none') where.push('l.enrichment_status IS NULL');
    else if (q.enrichment) (where.push('l.enrichment_status = $enr'), (p.enr = q.enrichment));
    if (q.stageId) where.push(stageWhere(listStages(ctx, user(req).workspace_id), q.stageId));
    if (q.tag) (where.push("l.tags LIKE $tag ESCAPE '\\'"), (p.tag = tagLike(q.tag)));
    if (q.ownerId === 'none') where.push('l.owner_id IS NULL');
    else if (q.ownerId) (where.push('l.owner_id = $owner'), (p.owner = q.ownerId === 'me' ? user(req).id : q.ownerId));
    if (q.q) {
      where.push("(l.first_name || ' ' || l.last_name || ' ' || l.company || ' ' || l.headline || ' ' || COALESCE(l.email, '')) LIKE $q");
      p.q = `%${q.q}%`;
    }
    const w = where.join(' AND ');
    const total = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM leads l WHERE ${w}`, p)!.n;
    const limit = paged ? `LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}` : '';
    const items = ctx.db.all<LeadRow>(`SELECT l.* FROM leads l WHERE ${w} ORDER BY l.id DESC ${limit}`, p);
    return { total, items };
  };

  app.get('/api/leads', async (req) => {
    const q = parse(leadQuery, req.query);
    const { total, items } = findLeads(req, q);
    const stages = listStages(ctx, user(req).workspace_id);
    // Attach each lead's current campaign, if any.
    const ids = items.map((l) => l.id);
    const camps = ids.length
      ? ctx.db.all<{ lead_id: number; name: string; state: string; campaign_id: number }>(
          `SELECT cl.lead_id, cl.state, c.name, c.id AS campaign_id FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.lead_id IN (${ids.join(',')}) ORDER BY cl.added_at`,
        )
      : [];
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: items.map((l) => ({ ...serializeLead(l, stages), campaigns: camps.filter((c) => c.lead_id === l.id).map((c) => ({ id: c.campaign_id, name: c.name, state: c.state })) })),
    };
  });

  app.get('/api/leads/export.csv', async (req, reply) => {
    const q = parse(leadQuery, req.query);
    const { items } = findLeads(req, q, false);
    const stages = listStages(ctx, user(req).workspace_id);
    // Custom fields get their own column prefix, so one named "email" can't replace the real email column.
    const customKeys = [...new Set(items.flatMap((l) => Object.keys(json(l.custom, {}))))];
    const rows = items.map((l) => {
      const s = serializeLead(l, stages);
      const custom = s.custom as Record<string, string>;
      return {
        profile_url: s.profileUrl, first_name: s.firstName, last_name: s.lastName, headline: s.headline, title: s.title, company: s.company,
        location: s.location, email: s.email, email_status: s.emailStatus ?? '', email_source: s.emailSource ?? '', company_domain: s.companyDomain ?? '', phone: s.phone, connection_status: s.connectionStatus,
        connected_at: s.connectedAt ? new Date(s.connectedAt).toISOString() : '', replied_at: s.repliedAt ? new Date(s.repliedAt).toISOString() : '',
        tags: s.tags.join(';'), stage: s.stage?.name ?? '', ...Object.fromEntries(customKeys.map((k) => [`${CUSTOM_PREFIX}${k}`, custom[k] ?? ''])),
      };
    });
    return csv(reply, 'leads.csv', rows);
  });

  app.get('/api/leads/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const l = ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [id, user(req).workspace_id]) ?? notFound('Lead');
    const campaigns = ctx.db.all(
      'SELECT c.id, c.name, cl.state, cl.node_id AS "nodeId", cl.node_type AS "nodeType", cl.next_run_at AS "nextRunAt", cl.last_error AS "lastError" FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.lead_id = ?',
      [id],
    );
    const activity = ctx.db.all('SELECT id, type, status, detail, variant, created_at AS "createdAt", campaign_id AS "campaignId" FROM activity WHERE lead_id = ? ORDER BY id DESC LIMIT 200', [id]);
    const owner = l.owner_id ? ctx.db.get<{ id: number; name: string }>('SELECT u.id, u.name FROM users u JOIN memberships m ON m.user_id = u.id AND m.workspace_id = ? WHERE u.id = ?', [l.workspace_id, l.owner_id]) : undefined;
    return { ...serializeLead(l, listStages(ctx, l.workspace_id)), owner: owner ?? null, campaigns, activity };
  });

  app.post('/api/leads', async (req) => {
    const body = parse(z.object({ listId: z.number().int(), profileUrl: z.string().min(3) }).and(leadPatch), req.body);
    list(req, body.listId);
    const { addedIds, ...r } = importLeads(ctx, user(req).workspace_id, body.listId, [{ ...body, email: body.email || null }], { emailSource: 'user' });
    if (r.invalid) throw new HttpError(400, 'That is not a LinkedIn profile URL');
    if (r.duplicates) throw new HttpError(409, 'This person is already in your leads');
    return { ...r, id: addedIds[0] };
  });

  app.patch('/api/leads/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    ctx.db.get('SELECT id FROM leads WHERE id = ? AND workspace_id = ?', [id, user(req).workspace_id]) ?? notFound('Lead');
    const b = parse(leadPatch, req.body);
    if (b.listId) list(req, b.listId);
    // Another workspace's user is a 404 like any other row.
    if (b.ownerId != null && !isWorkspaceMember(ctx, user(req).workspace_id, b.ownerId)) notFound('User');
    const cols: Record<string, any> = {};
    const map: Record<string, string> = { firstName: 'first_name', lastName: 'last_name', headline: 'headline', title: 'title', company: 'company', location: 'location', email: 'email', phone: 'phone', listId: 'list_id' };
    for (const [k, col] of Object.entries(map)) if ((b as any)[k] !== undefined) cols[col] = (b as any)[k] === '' && k === 'email' ? null : (b as any)[k];
    // Tags take the workspace's spelling of an existing tag, and new names get a tag row.
    if (b.tags) cols.tags = JSON.stringify(canonicalTags(ctx, user(req).workspace_id, b.tags));
    if (b.ownerId !== undefined) cols.owner_id = b.ownerId;
    if (b.custom) cols.custom = JSON.stringify(b.custom);
    // A new address hasn't bounced: its status starts over.
    const before = ctx.db.get<{ email: string | null }>('SELECT email FROM leads WHERE id = ?', [id])!;
    // A typed address is the user's own from now on: finders never replace it unless asked to.
    if ('email' in cols && (cols.email ?? '').toLowerCase() !== (before.email ?? '').toLowerCase()) {
      Object.assign(cols, { email_status: null, email_status_reason: null, email_status_at: null, email_source: cols.email ? 'user' : null, email_found_at: null });
    }
    ctx.db.update('leads', id, cols);
    return { ok: true };
  });

  app.post('/api/leads/delete', async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.number().int()).min(1).max(10000) }), req.body);
    const r = ctx.db.run(`DELETE FROM leads WHERE workspace_id = ? AND id IN (${ids.map(Number).join(',')})`, [user(req).workspace_id]);
    return { deleted: r.changes };
  });

  app.post('/api/leads/import/csv', async (req) => {
    const body = parse(z.object({ listId: z.number().int(), csv: z.string().min(1).max(20_000_000), autoEnrich: z.boolean().optional() }), req.body);
    list(req, body.listId);
    let leads: LeadInput[];
    try {
      leads = csvToLeads(body.csv);
    } catch (e) {
      throw new HttpError(400, `Could not read the CSV: ${(e as Error).message}`);
    }
    if (leads.length && !leads.some((l) => l.profileUrl)) throw new HttpError(400, 'No LinkedIn profile URL column found (expected a header like "Profile URL" or "LinkedIn URL")');
    const me = user(req);
    const { addedIds, ...r } = importLeads(ctx, me.workspace_id, body.listId, leads, { emailSource: 'csv' });
    // Members may import, so they may also start the lookup for what they imported.
    const enrich = autoEnrichImported(ctx, me.workspace_id, addedIds, me.id, body.autoEnrich);
    return { rows: leads.length, ...r, enrichRunId: enrich?.runId ?? null, enrichRunIds: enrich?.runIds ?? [] };
  });

  const account = (req: any, id: number) =>
    ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND workspace_id = ?', [id, user(req).workspace_id]) ?? notFound('Account');

  // Collects people from a LinkedIn or Sales Navigator search in the background (kept for older clients).
  app.post('/api/leads/import/search', async (req) => {
    requireWriter(req);
    // Same host check as the route below: the URL is opened in the account's logged-in browser.
    const body = parse(
      z.object({
        listId: z.number().int(),
        accountId: z.number().int(),
        url: z.string().trim().min(1).max(2000).superRefine((u, c) => {
          const problem = sourceUrlProblem('search', u);
          if (problem) c.addIssue({ code: 'custom', message: problem });
        }),
        limit: z.number().int().min(1).max(1000).default(100),
      }),
      req.body,
    );
    list(req, body.listId);
    const a = account(req, body.accountId);
    return { importId: startImport(ctx, user(req).workspace_id, body.listId, a, 'search', body.url, { limit: body.limit }) };
  });

  // Collects people from a search, a post's reactions and comments, an event or a group, in the background.
  app.post('/api/leads/import/linkedin', async (req) => {
    requireWriter(req);
    const body = parse(
      z
        .object({
          listId: z.number().int(),
          accountId: z.number().int(),
          source: z.enum(IMPORT_KINDS),
          url: z.string().trim().min(1).max(2000),
          limit: z.number().int().min(1).max(1000).default(100),
          likers: z.boolean().default(true),
          commenters: z.boolean().default(true),
          autoEnrich: z.boolean().optional(),
        })
        .superRefine((b, c) => {
          const problem = sourceUrlProblem(b.source, b.url);
          if (problem) c.addIssue({ code: 'custom', path: ['url'], message: problem });
          if (b.source === 'post' && !b.likers && !b.commenters) c.addIssue({ code: 'custom', path: ['likers'], message: 'Choose reactions, comments or both' });
        }),
      req.body,
    );
    list(req, body.listId);
    const a = account(req, body.accountId);
    const base = { limit: body.limit, ...(body.autoEnrich !== undefined ? { autoEnrich: body.autoEnrich } : {}) };
    const options = body.source === 'post' ? { ...base, likers: body.likers, commenters: body.commenters } : base;
    return { importId: startImport(ctx, user(req).workspace_id, body.listId, a, body.source, body.url, options) };
  });

  app.get('/api/imports', async (req) => {
    const rows = ctx.db.all<ImportRow & { list_name: string | null; account_name: string | null; job_status: string | null; job_error: string | null }>(
      `SELECT i.*, l.name AS list_name, a.name AS account_name, j.status AS job_status, j.last_error AS job_error
       FROM imports i LEFT JOIN lead_lists l ON l.id = i.list_id LEFT JOIN accounts a ON a.id = i.account_id LEFT JOIN jobs j ON j.id = i.job_id
       WHERE i.workspace_id = ? ORDER BY i.id DESC LIMIT 20`,
      [user(req).workspace_id],
    );
    return rows.map(serializeImport);
  });

  app.post('/api/imports/:id/cancel', async (req) => {
    const u = requireWriter(req);
    const { id } = parse(idParam, req.params);
    const imp = ctx.db.get<ImportRow>('SELECT * FROM imports WHERE id = ? AND workspace_id = ?', [id, u.workspace_id]) ?? notFound('Import');
    if (cancelImport(ctx, imp) === 'not_running') throw new HttpError(409, 'This import has already finished');
    return { ok: true };
  });
}

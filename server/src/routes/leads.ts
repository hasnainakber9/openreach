import type { FastifyInstance } from 'fastify';
import { parse as parseCsv } from 'csv-parse/sync';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { csv, HttpError, idParam, notFound, parse, user } from '../http.js';
import { importLeads, personToLead, type LeadInput } from '../services/leads.js';
import type { AccountRow, LeadRow } from '../types.js';

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

const camel = (s: string) => s.trim().replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toLowerCase());

// Turns a CSV export from LinkedIn, Sales Navigator, a CRM or a spreadsheet into leads.
// Known columns map to lead fields; everything else becomes a custom field usable in templates.
export function csvToLeads(text: string): LeadInput[] {
  const rows: Record<string, string>[] = parseCsv(text.replace(/^﻿/, ''), { columns: true, skip_empty_lines: true, relax_column_count: true, trim: true });
  return rows.map((row) => {
    const lead: LeadInput = { profileUrl: '', custom: {} };
    for (const [header, value] of Object.entries(row)) {
      if (!value) continue;
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

export function serializeLead(l: LeadRow) {
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
}).partial();

export function leadRoutes(app: FastifyInstance, ctx: Ctx) {
  const list = (req: any, id: number) =>
    ctx.db.get<{ id: number }>('SELECT id FROM lead_lists WHERE id = ? AND workspace_id = ?', [id, user(req).workspace_id]) ?? notFound('List');

  app.get('/api/lists', async (req) => {
    return ctx.db.all(
      `SELECT l.id, l.name, l.created_at AS createdAt, COUNT(ld.id) AS leads,
              SUM(ld.connection_status = 'connected') AS connected
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
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(500).default(50),
  });

  const findLeads = (req: any, q: z.infer<typeof leadQuery>, paged = true) => {
    const where = ['l.workspace_id = $ws'];
    const p: Record<string, any> = { ws: user(req).workspace_id };
    if (q.listId) (where.push('l.list_id = $list'), (p.list = q.listId));
    if (q.campaignId) (where.push('l.id IN (SELECT lead_id FROM campaign_leads WHERE campaign_id = $camp)'), (p.camp = q.campaignId));
    if (q.status) (where.push('l.connection_status = $status'), (p.status = q.status));
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
      items: items.map((l) => ({ ...serializeLead(l), campaigns: camps.filter((c) => c.lead_id === l.id).map((c) => ({ id: c.campaign_id, name: c.name, state: c.state })) })),
    };
  });

  app.get('/api/leads/export.csv', async (req, reply) => {
    const q = parse(leadQuery, req.query);
    const { items } = findLeads(req, q, false);
    const customKeys = [...new Set(items.flatMap((l) => Object.keys(json(l.custom, {}))))];
    const rows = items.map((l) => {
      const s = serializeLead(l);
      const custom = s.custom as Record<string, string>;
      return {
        profile_url: s.profileUrl, first_name: s.firstName, last_name: s.lastName, headline: s.headline, title: s.title, company: s.company,
        location: s.location, email: s.email, phone: s.phone, connection_status: s.connectionStatus,
        connected_at: s.connectedAt ? new Date(s.connectedAt).toISOString() : '', replied_at: s.repliedAt ? new Date(s.repliedAt).toISOString() : '',
        tags: s.tags.join(';'), ...Object.fromEntries(customKeys.map((k) => [k, custom[k] ?? ''])),
      };
    });
    return csv(reply, 'leads.csv', rows);
  });

  app.get('/api/leads/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const l = ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [id, user(req).workspace_id]) ?? notFound('Lead');
    const campaigns = ctx.db.all(
      'SELECT c.id, c.name, cl.state, cl.node_id AS nodeId, cl.node_type AS nodeType, cl.next_run_at AS nextRunAt, cl.last_error AS lastError FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.lead_id = ?',
      [id],
    );
    const activity = ctx.db.all('SELECT id, type, status, detail, created_at AS createdAt, campaign_id AS campaignId FROM activity WHERE lead_id = ? ORDER BY id DESC LIMIT 200', [id]);
    return { ...serializeLead(l), campaigns, activity };
  });

  app.post('/api/leads', async (req) => {
    const body = parse(z.object({ listId: z.number().int(), profileUrl: z.string().min(3) }).and(leadPatch), req.body);
    list(req, body.listId);
    const r = importLeads(ctx, user(req).workspace_id, body.listId, [{ ...body, email: body.email || null }]);
    if (r.invalid) throw new HttpError(400, 'That is not a LinkedIn profile URL');
    if (r.duplicates) throw new HttpError(409, 'This person is already in your leads');
    return r;
  });

  app.patch('/api/leads/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    ctx.db.get('SELECT id FROM leads WHERE id = ? AND workspace_id = ?', [id, user(req).workspace_id]) ?? notFound('Lead');
    const b = parse(leadPatch, req.body);
    if (b.listId) list(req, b.listId);
    const cols: Record<string, any> = {};
    const map: Record<string, string> = { firstName: 'first_name', lastName: 'last_name', headline: 'headline', title: 'title', company: 'company', location: 'location', email: 'email', phone: 'phone', listId: 'list_id' };
    for (const [k, col] of Object.entries(map)) if ((b as any)[k] !== undefined) cols[col] = (b as any)[k] === '' && k === 'email' ? null : (b as any)[k];
    if (b.tags) cols.tags = JSON.stringify(b.tags);
    if (b.custom) cols.custom = JSON.stringify(b.custom);
    ctx.db.update('leads', id, cols);
    return { ok: true };
  });

  app.post('/api/leads/delete', async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.number().int()).min(1).max(10000) }), req.body);
    const r = ctx.db.run(`DELETE FROM leads WHERE workspace_id = ? AND id IN (${ids.map(Number).join(',')})`, [user(req).workspace_id]);
    return { deleted: r.changes };
  });

  app.post('/api/leads/import/csv', async (req) => {
    const body = parse(z.object({ listId: z.number().int(), csv: z.string().min(1).max(20_000_000) }), req.body);
    list(req, body.listId);
    let leads: LeadInput[];
    try {
      leads = csvToLeads(body.csv);
    } catch (e) {
      throw new HttpError(400, `Could not read the CSV: ${(e as Error).message}`);
    }
    if (leads.length && !leads.some((l) => l.profileUrl)) throw new HttpError(400, 'No LinkedIn profile URL column found (expected a header like "Profile URL" or "LinkedIn URL")');
    return { rows: leads.length, ...importLeads(ctx, user(req).workspace_id, body.listId, leads) };
  });

  // Collects people from a LinkedIn or Sales Navigator search, in the background.
  app.post('/api/leads/import/search', async (req) => {
    const ws = user(req).workspace_id;
    const body = parse(z.object({ listId: z.number().int(), accountId: z.number().int(), url: z.string().url().refine((u) => /linkedin\.com\//.test(u), 'Must be a linkedin.com search URL'), limit: z.number().int().min(1).max(1000).default(100) }), req.body);
    list(req, body.listId);
    const a = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND workspace_id = ?', [body.accountId, ws]) ?? notFound('Account');
    const importId = ctx.db.insert('imports', { workspace_id: ws, list_id: body.listId, account_id: a.id, source: body.url, created_at: ctx.clock.now() });
    void ctx.drivers
      .use(a, (d) => d.search(body.url, body.limit, (found) => ctx.db.run('UPDATE imports SET found = ? WHERE id = ?', [found, importId])))
      .then((people) => {
        const r = importLeads(ctx, ws, body.listId, people.map(personToLead));
        ctx.db.update('imports', importId, { status: 'done', found: people.length, added: r.added });
      })
      .catch((e) => ctx.db.update('imports', importId, { status: 'failed', error: (e as Error).message }));
    return { importId };
  });

  app.get('/api/imports', async (req) => {
    return ctx.db.all(
      'SELECT i.id, i.list_id AS listId, l.name AS listName, i.source, i.status, i.found, i.added, i.error, i.created_at AS createdAt FROM imports i LEFT JOIN lead_lists l ON l.id = i.list_id WHERE i.workspace_id = ? ORDER BY i.id DESC LIMIT 20',
      [user(req).workspace_id],
    );
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError, idParam, isAdmin, notFound, parse, requireAdmin, requireWriter, user, type SessionUser } from '../http.js';
import {
  deleteStage,
  effectiveStage,
  findStage,
  FIRST_STAGE_OPEN,
  listStages,
  newStageSlug,
  pinUnstaged,
  pipelineSettings,
  PipelineSettingsSchema,
  serializeStage,
  setStage,
  STAGE_KINDS,
  stageWhere,
  writeOrder,
} from '../services/pipeline.js';
import { setSetting } from '../services/settings.js';
import { applyTags, createTag, deleteTag, findTagByName, leadTags, listTags, renameTag, TAG_LIKE_SQL, tagColor, tagLike, tagName } from '../services/tags.js';
import { isWorkspaceMember } from '../services/tasks.js';
import { leadTimeline } from '../services/timeline.js';
import type { LeadRow, NoteRow, TagRow } from '../types.js';

const stageName = z.string().trim().min(1, 'Enter a stage name').max(50);
const stageColor = tagColor;

// Lead filters shared by the board (and usable by other lists): campaign, owner, tag, search.
export const boardFilters = z.object({
  campaignId: z.coerce.number().int().positive().optional(),
  // A user id, "me" or "none" (no owner).
  ownerId: z.union([z.enum(['me', 'none']), z.coerce.number().int().positive()]).optional(),
  tag: z.string().trim().min(1).max(50).optional(),
  q: z.string().trim().max(200).optional(),
});

export function filterSql(f: z.infer<typeof boardFilters>, me: { id: number }): { where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.campaignId) (where.push('l.id IN (SELECT lead_id FROM campaign_leads WHERE campaign_id = ?)'), params.push(f.campaignId));
  if (f.ownerId === 'none') where.push('l.owner_id IS NULL');
  else if (f.ownerId === 'me') (where.push('l.owner_id = ?'), params.push(me.id));
  else if (f.ownerId) (where.push('l.owner_id = ?'), params.push(f.ownerId));
  if (f.tag) (where.push(TAG_LIKE_SQL()), params.push(tagLike(f.tag)));
  if (f.q) (where.push("(l.first_name || ' ' || l.last_name || ' ' || l.company || ' ' || l.headline || ' ' || COALESCE(l.email, '')) LIKE ?"), params.push(`%${f.q}%`));
  return { where, params };
}

export function pipelineRoutes(app: FastifyInstance, ctx: Ctx) {
  const ws = (req: any) => user(req).workspace_id;
  const loadStage = (req: any, id: number) => findStage(ctx, ws(req), id) ?? notFound('Stage');
  const loadLead = (req: any, id: number) => ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [id, ws(req)]) ?? notFound('Lead');
  const loadTag = (req: any) => {
    const { id } = parse(idParam, req.params);
    return ctx.db.get<TagRow>('SELECT * FROM tags WHERE id = ? AND workspace_id = ?', [id, ws(req)]) ?? notFound('Tag');
  };
  // Owners must belong to the workspace; anyone else is a 404 like any other row.
  const checkOwner = (w: number, id: number | null | undefined) => {
    if (id != null && !isWorkspaceMember(ctx, w, id)) notFound('User');
  };

  // ---- Stages ----

  app.get('/api/pipeline/stages', async (req) => {
    const stages = listStages(ctx, ws(req));
    const counts = new Map<number, number>();
    for (const r of ctx.db.all<{ stage_id: number | null; n: number }>('SELECT stage_id, COUNT(*) AS n FROM leads WHERE workspace_id = ? GROUP BY stage_id', [ws(req)])) {
      const s = effectiveStage(stages, r.stage_id);
      if (s) counts.set(s.id, (counts.get(s.id) ?? 0) + r.n);
    }
    return stages.map((s) => ({ ...serializeStage(s), leads: counts.get(s.id) ?? 0 }));
  });

  app.post('/api/pipeline/stages', async (req) => {
    const u = requireAdmin(req);
    const b = parse(z.object({ name: stageName, color: stageColor.optional(), kind: z.enum(STAGE_KINDS).default('open') }), req.body);
    const stages = listStages(ctx, u.workspace_id);
    if (stages.length >= 30) throw new HttpError(400, 'A pipeline can have at most 30 stages');
    // Before the closing (won/lost) stages, so a new working stage lands where people expect it.
    const closing = stages.findIndex((s) => s.kind !== 'open');
    const at = b.kind === 'open' && closing >= 0 ? closing : stages.length;
    const id = ctx.db.insert('pipeline_stages', { workspace_id: u.workspace_id, slug: newStageSlug(), name: b.name, color: b.color ?? '#64748b', position: stages.length, kind: b.kind, created_at: ctx.clock.now() });
    const ids = stages.map((s) => s.id);
    ids.splice(at, 0, id);
    writeOrder(ctx, u.workspace_id, ids);
    return serializeStage(findStage(ctx, u.workspace_id, id)!);
  });

  // Registered before /:id so "order" is never read as an id.
  app.put('/api/pipeline/stages/order', async (req) => {
    const u = requireAdmin(req);
    const { ids } = parse(z.object({ ids: z.array(z.number().int().positive()).min(1).max(30) }), req.body);
    const stages = listStages(ctx, u.workspace_id);
    const known = new Set(stages.map((s) => s.id));
    if (ids.length !== stages.length || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) throw new HttpError(400, 'ids: list every stage of the pipeline exactly once');
    if (stages.find((s) => s.id === ids[0])!.kind !== 'open') throw new HttpError(400, FIRST_STAGE_OPEN);
    // Leads without a stage stay where they are; only leads added later start in the new first stage.
    ctx.db.tx(() => {
      if (ids[0] !== stages[0].id) pinUnstaged(ctx, u.workspace_id, stages);
      writeOrder(ctx, u.workspace_id, ids);
    });
    return listStages(ctx, u.workspace_id).map(serializeStage);
  });

  app.patch('/api/pipeline/stages/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const s = loadStage(req, id);
    const b = parse(z.object({ name: stageName, color: stageColor, kind: z.enum(STAGE_KINDS) }).partial(), req.body);
    if (b.kind && b.kind !== 'open' && listStages(ctx, s.workspace_id)[0]?.id === s.id) throw new HttpError(400, FIRST_STAGE_OPEN);
    ctx.db.update('pipeline_stages', s.id, { ...(b.name !== undefined ? { name: b.name } : {}), ...(b.color !== undefined ? { color: b.color } : {}), ...(b.kind !== undefined ? { kind: b.kind } : {}) });
    return serializeStage(loadStage(req, id));
  });

  app.delete('/api/pipeline/stages/:id', async (req) => {
    const u = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const s = loadStage(req, id);
    // The target may come in the body or the query string (some clients drop DELETE bodies).
    const { moveTo } = parse(z.object({ moveTo: z.coerce.number().int().positive() }), { ...(req.query as object), ...((req.body as object) ?? {}) });
    const stages = listStages(ctx, u.workspace_id);
    if (stages.length <= 1) throw new HttpError(409, "The last stage can't be deleted");
    if (stages[0].id === s.id && stages[1].kind !== 'open') throw new HttpError(409, `${FIRST_STAGE_OPEN}. Move an in-progress stage above "${stages[1].name}" first.`);
    if (moveTo === s.id) throw new HttpError(400, 'moveTo: choose another stage for its leads');
    const target = loadStage(req, moveTo);
    const moved = deleteStage(ctx, u.workspace_id, s, target, u.id);
    return { ok: true, moved };
  });

  app.get('/api/pipeline/settings', async (req) => pipelineSettings(ctx, ws(req)));

  app.put('/api/pipeline/settings', async (req) => {
    const u = requireAdmin(req);
    const b = parse(z.object({ autoLost: z.boolean() }), req.body);
    return setSetting(ctx, u.workspace_id, 'pipeline', PipelineSettingsSchema, b);
  });

  // ---- Board ----

  app.get('/api/pipeline/board', async (req) => {
    const me = user(req);
    const q = parse(
      boardFilters.extend({
        perStage: z.coerce.number().int().min(1).max(200).default(50),
        // "Load more" on one column: only that stage, from `offset`.
        stageId: z.coerce.number().int().positive().optional(),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );
    const stages = listStages(ctx, me.workspace_id);
    if (q.stageId && !stages.some((s) => s.id === q.stageId)) notFound('Stage');
    const f = filterSql(q, me);
    const base = ['l.workspace_id = ?', ...f.where];
    const owners = new Map(ctx.db.all<{ id: number; name: string }>('SELECT u.id, u.name FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.workspace_id = ?', [me.workspace_id]).map((u) => [u.id, u.name]));
    const columns = stages
      .filter((s) => !q.stageId || s.id === q.stageId)
      .map((s) => {
        const where = [...base, stageWhere(stages, s.id)].join(' AND ');
        const params = [me.workspace_id, ...f.params] as (string | number)[];
        const total = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM leads l WHERE ${where}`, params)!.n;
        const rows = ctx.db.all<LeadRow & { last_activity_at: number | null }>(
          `SELECT l.*, (SELECT MAX(a.created_at) FROM activity a WHERE a.lead_id = l.id) AS last_activity_at FROM leads l WHERE ${where}
           ORDER BY CASE WHEN l.stage_changed_at IS NULL THEN 1 ELSE 0 END, l.stage_changed_at DESC, l.id DESC LIMIT ${q.perStage} OFFSET ${q.offset}`,
          params,
        );
        return {
          ...serializeStage(s),
          total,
          leads: rows.map((l) => ({
            id: l.id,
            name: `${l.first_name} ${l.last_name}`.trim() || l.public_id,
            company: l.company,
            title: l.title,
            headline: l.headline,
            tags: leadTags(l),
            ownerId: l.owner_id,
            ownerName: l.owner_id ? (owners.get(l.owner_id) ?? null) : null,
            lastActivityAt: l.last_activity_at,
            stageChangedAt: l.stage_changed_at,
            replyCategory: l.reply_category ?? null,
          })),
        };
      });
    return { stages: columns };
  });

  // ---- Lead stage, owner, bulk ----

  app.post('/api/leads/:id/stage', async (req) => {
    const u = requireWriter(req);
    const { id } = parse(idParam, req.params);
    const lead = loadLead(req, id);
    const { stageId } = parse(z.object({ stageId: z.number().int().positive() }), req.body);
    const s = loadStage(req, stageId);
    const moved = setStage(ctx, lead, s.id, { source: 'manual', userId: u.id });
    return { moved, stage: serializeStage(s) };
  });

  app.post('/api/leads/bulk', async (req) => {
    const u = requireWriter(req);
    const b = parse(
      z.object({
        leadIds: z.array(z.number().int().positive()).min(1).max(5000),
        stageId: z.number().int().positive().optional(),
        addTags: z.array(tagName).max(20).default([]),
        removeTags: z.array(tagName).max(20).default([]),
        ownerId: z.number().int().positive().nullable().optional(),
      }),
      req.body,
    );
    const stage = b.stageId ? loadStage(req, b.stageId) : null;
    checkOwner(u.workspace_id, b.ownerId);
    const leads = ctx.db.all<LeadRow>(`SELECT * FROM leads WHERE workspace_id = ? AND id IN (${[...new Set(b.leadIds)].join(',')})`, [u.workspace_id]);
    const changed = new Set<number>();
    ctx.db.tx(() => {
      if (stage) for (const l of leads) if (setStage(ctx, l, stage.id, { source: 'manual', userId: u.id })) changed.add(l.id);
      if (b.ownerId !== undefined)
        for (const l of leads)
          if (l.owner_id !== b.ownerId) {
            ctx.db.update('leads', l.id, { owner_id: b.ownerId });
            changed.add(l.id);
          }
      if (b.addTags.length || b.removeTags.length) {
        const before = new Map(leads.map((l) => [l.id, ctx.db.get<{ tags: string }>('SELECT tags FROM leads WHERE id = ?', [l.id])!.tags]));
        applyTags(ctx, u.workspace_id, leads.map((l) => l.id), b.addTags, b.removeTags);
        for (const l of leads) if (ctx.db.get<{ tags: string }>('SELECT tags FROM leads WHERE id = ?', [l.id])!.tags !== before.get(l.id)) changed.add(l.id);
      }
    });
    return { updated: changed.size, matched: leads.length };
  });

  // ---- Tags ----

  app.get('/api/tags', async (req) => listTags(ctx, ws(req)));

  app.post('/api/tags', async (req) => {
    const u = requireWriter(req);
    const b = parse(z.object({ name: tagName, color: tagColor.optional() }), req.body);
    if (findTagByName(ctx, u.workspace_id, b.name)) throw new HttpError(409, 'A tag with that name already exists');
    const t = createTag(ctx, u.workspace_id, b.name, b.color);
    return { id: t.id, name: t.name, color: t.color, leads: 0, createdAt: t.created_at };
  });

  app.patch('/api/tags/:id', async (req) => {
    requireAdmin(req);
    const t = loadTag(req);
    const b = parse(z.object({ name: tagName, color: tagColor }).partial(), req.body);
    if (b.name !== undefined) {
      const clash = findTagByName(ctx, t.workspace_id, b.name);
      if (clash && clash.id !== t.id) throw new HttpError(409, 'A tag with that name already exists');
      renameTag(ctx, t, b.name);
    }
    if (b.color !== undefined) ctx.db.update('tags', t.id, { color: b.color });
    const row = ctx.db.get<TagRow>('SELECT * FROM tags WHERE id = ?', [t.id])!;
    return { id: row.id, name: row.name, color: row.color };
  });

  app.delete('/api/tags/:id', async (req) => {
    requireAdmin(req);
    deleteTag(ctx, loadTag(req));
    return { ok: true };
  });

  // ---- Notes ----

  const serializeNote = (n: NoteRow & { author_name?: string | null }, me: SessionUser) => ({
    id: n.id,
    leadId: n.lead_id,
    body: n.body,
    userId: n.user_id,
    authorName: n.author_name ?? null,
    createdAt: n.created_at,
    updatedAt: n.updated_at,
    canEdit: me.role !== 'client' && (n.user_id === me.id || isAdmin(me)),
  });
  const noteBody = z.object({ body: z.string().trim().min(1, 'Write something first').max(10_000) });
  // Authors edit their own notes; admins can edit or remove anyone's.
  const loadNote = (req: any) => {
    const u = requireWriter(req);
    const { id } = parse(idParam, req.params);
    const n = ctx.db.get<NoteRow>('SELECT * FROM lead_notes WHERE id = ? AND workspace_id = ?', [id, u.workspace_id]) ?? notFound('Note');
    if (n.user_id !== u.id && !isAdmin(u)) throw new HttpError(403, 'Only the author or an admin can change this note');
    return { u, n };
  };
  const noteById = (id: number) => ctx.db.get<NoteRow & { author_name: string | null }>('SELECT n.*, u.name AS author_name FROM lead_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.id = ?', [id])!;

  app.get('/api/leads/:id/notes', async (req) => {
    const me = user(req);
    const { id } = parse(idParam, req.params);
    loadLead(req, id);
    return ctx.db
      .all<NoteRow & { author_name: string | null }>('SELECT n.*, u.name AS author_name FROM lead_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.lead_id = ? AND n.workspace_id = ? ORDER BY n.created_at DESC, n.id DESC', [id, me.workspace_id])
      .map((n) => serializeNote(n, me));
  });

  app.post('/api/leads/:id/notes', async (req) => {
    const u = requireWriter(req);
    const { id } = parse(idParam, req.params);
    loadLead(req, id);
    const { body } = parse(noteBody, req.body);
    const now = ctx.clock.now();
    const noteId = ctx.db.insert('lead_notes', { workspace_id: u.workspace_id, lead_id: id, user_id: u.id, body, created_at: now, updated_at: now });
    return serializeNote(noteById(noteId), u);
  });

  app.patch('/api/notes/:id', async (req) => {
    const { u, n } = loadNote(req);
    const { body } = parse(noteBody, req.body);
    ctx.db.update('lead_notes', n.id, { body, updated_at: ctx.clock.now() });
    return serializeNote(noteById(n.id), u);
  });

  app.delete('/api/notes/:id', async (req) => {
    const { n } = loadNote(req);
    ctx.db.run('DELETE FROM lead_notes WHERE id = ?', [n.id]);
    return { ok: true };
  });

  // ---- Timeline ----

  app.get('/api/leads/:id/timeline', async (req) => {
    const { id } = parse(idParam, req.params);
    loadLead(req, id);
    const q = parse(z.object({ before: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }), req.query);
    return leadTimeline(ctx, ws(req), id, q);
  });
}

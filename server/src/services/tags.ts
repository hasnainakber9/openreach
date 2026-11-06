import { z } from 'zod';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import type { LeadRow, TagRow } from '../types.js';

// Tags live on leads as a JSON array of names (CSV import/export use it as is); the tags table only adds
// a color and lets a tag exist before any lead has it. Names are compared case-insensitively, and a row
// is created the first time a name shows up on a lead, so the two never drift apart for long.

export const tagName = z.string().trim().min(1, 'Enter a tag name').max(50);
export const tagColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #3b82f6');

// New tags take the next color from this list, so a board of tags isn't all grey.
const PALETTE = ['#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#ec4899', '#14b8a6', '#64748b'];

const key = (name: string) => name.trim().toLowerCase();
export const leadTags = (l: Pick<LeadRow, 'tags'>) => json<string[]>(l.tags, []).filter((t) => typeof t === 'string');

// `l.tags LIKE ?` matching leads that may carry the tag; confirm with hasTag (LIKE also matches other cases).
export function tagLike(name: string) {
  const quoted = JSON.stringify(name.trim());
  return `%${quoted.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
}
export const TAG_LIKE_SQL = (col = 'l.tags') => `${col} LIKE ? ESCAPE '\\'`;
export const hasTag = (l: Pick<LeadRow, 'tags'>, name: string) => leadTags(l).some((t) => key(t) === key(name));

const tagRows = (ctx: Ctx, ws: number) => ctx.db.all<TagRow>('SELECT * FROM tags WHERE workspace_id = ? ORDER BY lower(name), id', [ws]);

function createRow(ctx: Ctx, ws: number, name: string, color: string | undefined, existing: number): TagRow {
  const id = ctx.db.insert('tags', { workspace_id: ws, name, color: color ?? PALETTE[existing % PALETTE.length], created_at: ctx.clock.now() });
  return ctx.db.get<TagRow>('SELECT * FROM tags WHERE id = ?', [id])!;
}

// Tag rows, with rows created for names found on leads, and how many leads have each.
export function listTags(ctx: Ctx, ws: number) {
  const counts = new Map<string, { name: string; n: number }>();
  for (const l of ctx.db.all<{ tags: string }>("SELECT tags FROM leads WHERE workspace_id = ? AND tags <> '[]'", [ws])) {
    for (const t of new Set(leadTags(l).map((x) => x.trim()).filter(Boolean))) {
      const c = counts.get(key(t));
      if (c) c.n++;
      else counts.set(key(t), { name: t, n: 1 });
    }
  }
  let rows = tagRows(ctx, ws);
  const known = new Set(rows.map((r) => key(r.name)));
  const missing = [...counts.values()].filter((c) => !known.has(key(c.name)) && c.name.length <= 50);
  if (missing.length) {
    ctx.db.tx(() => missing.forEach((m, i) => createRow(ctx, ws, m.name, undefined, rows.length + i)));
    rows = tagRows(ctx, ws);
  }
  return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, leads: counts.get(key(r.name))?.n ?? 0, createdAt: r.created_at }));
}

export function findTagByName(ctx: Ctx, ws: number, name: string): TagRow | undefined {
  return tagRows(ctx, ws).find((r) => key(r.name) === key(name));
}

export function createTag(ctx: Ctx, ws: number, name: string, color?: string): TagRow {
  return createRow(ctx, ws, name.trim(), color, tagRows(ctx, ws).length);
}

// Names as the workspace spells them (an existing tag's case wins), without duplicates; new names get a row.
export function canonicalTags(ctx: Ctx, ws: number, names: string[]): string[] {
  const rows = tagRows(ctx, ws);
  const byKey = new Map(rows.map((r) => [key(r.name), r.name]));
  const out = new Map<string, string>();
  ctx.db.tx(() => {
    for (const raw of names) {
      const name = raw.trim();
      if (!name || out.has(key(name))) continue;
      let canonical = byKey.get(key(name));
      if (!canonical) {
        canonical = createRow(ctx, ws, name, undefined, byKey.size).name;
        byKey.set(key(name), canonical);
      }
      out.set(key(name), canonical);
    }
  });
  return [...out.values()];
}

// Adds and removes tags on the workspace's leads in `leadIds` (read 500 at a time). Returns the ids of the
// leads that changed.
export function applyTags(ctx: Ctx, ws: number, leadIds: number[], add: string[], remove: string[]): number[] {
  const toAdd = canonicalTags(ctx, ws, add);
  const removeKeys = new Set(remove.map(key));
  const changed: number[] = [];
  ctx.db.tx(() => {
    for (let i = 0; i < leadIds.length; i += 500) {
      const chunk = leadIds.slice(i, i + 500);
      const rows = ctx.db.all<{ id: number; tags: string }>(`SELECT id, tags FROM leads WHERE workspace_id = ? AND id IN (${chunk.map(() => '?').join(',')})`, [ws, ...chunk]);
      for (const l of rows) {
        const before = leadTags(l);
        const kept = before.filter((t) => !removeKeys.has(key(t)));
        const next = [...kept, ...toAdd.filter((t) => !kept.some((k) => key(k) === key(t)))];
        if (JSON.stringify(next) === JSON.stringify(before)) continue;
        ctx.db.update('leads', l.id, { tags: JSON.stringify(next) });
        changed.push(l.id);
      }
    }
  });
  return changed;
}

// Rewrites every lead that has `from` (any case): renamed to `to`, or removed when `to` is null.
function rewriteLeads(ctx: Ctx, ws: number, from: string, to: string | null) {
  const rows = ctx.db.all<{ id: number; tags: string }>(`SELECT id, tags FROM leads WHERE workspace_id = ? AND ${TAG_LIKE_SQL('tags')}`, [ws, tagLike(from)]);
  for (const l of rows) {
    if (!hasTag(l, from)) continue;
    const out: string[] = [];
    for (const t of leadTags(l)) {
      const name = key(t) === key(from) ? to : t;
      if (name != null && !out.some((o) => key(o) === key(name))) out.push(name);
    }
    ctx.db.update('leads', l.id, { tags: JSON.stringify(out) });
  }
}

export function renameTag(ctx: Ctx, tag: TagRow, name: string) {
  ctx.db.tx(() => {
    if (name !== tag.name) rewriteLeads(ctx, tag.workspace_id, tag.name, name);
    ctx.db.update('tags', tag.id, { name });
  });
}

export function deleteTag(ctx: Ctx, tag: TagRow) {
  ctx.db.tx(() => {
    rewriteLeads(ctx, tag.workspace_id, tag.name, null);
    ctx.db.run('DELETE FROM tags WHERE id = ?', [tag.id]);
  });
}

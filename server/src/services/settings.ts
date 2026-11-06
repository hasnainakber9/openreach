import type { z } from 'zod';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';

// Small per-workspace settings documents (JSON). The schema should carry defaults, so a
// missing or outdated value still parses.
export function getSetting<T extends z.ZodTypeAny>(ctx: Ctx, workspaceId: number, name: string, schema: T): z.infer<T> {
  const row = ctx.db.get<{ value: string }>('SELECT value FROM workspace_settings WHERE workspace_id = ? AND name = ?', [workspaceId, name]);
  const r = schema.safeParse(row ? json(row.value, undefined) : undefined);
  return r.success ? r.data : schema.parse(undefined);
}

export function setSetting<T extends z.ZodTypeAny>(ctx: Ctx, workspaceId: number, name: string, schema: T, value: z.input<T>): z.infer<T> {
  const parsed = schema.parse(value);
  ctx.db.run(
    `INSERT INTO workspace_settings (workspace_id, name, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (workspace_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [workspaceId, name, JSON.stringify(parsed), ctx.clock.now()],
  );
  return parsed;
}

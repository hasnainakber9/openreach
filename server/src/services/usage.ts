import type { Ctx } from '../context.js';

export interface UsageInput {
  workspaceId: number;
  kind: string;
  provider: string;
  operation: string;
  credits?: number;
  inputTokens?: number;
  outputTokens?: number;
  ok?: boolean;
}

// Months are UTC 'YYYY-MM' strings computed here, not in SQL, so the query stays portable.
export const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

// One row per external call, so plan limits and the usage page can sum credits and tokens per month.
export function recordUsage(ctx: Ctx, u: UsageInput): number {
  const now = ctx.clock.now();
  return ctx.db.insert('usage_events', {
    workspace_id: u.workspaceId,
    kind: u.kind,
    provider: u.provider,
    operation: u.operation,
    credits: Math.max(0, Math.round(u.credits ?? 0)),
    input_tokens: Math.max(0, Math.round(u.inputTokens ?? 0)),
    output_tokens: Math.max(0, Math.round(u.outputTokens ?? 0)),
    ok: u.ok === false ? 0 : 1,
    month: monthOf(now),
    created_at: now,
  });
}

// Completes a row recorded before the call (a reserved credit): its token counts, or that it failed.
export function finishUsage(ctx: Ctx, id: number, u: Pick<UsageInput, 'inputTokens' | 'outputTokens' | 'ok'>) {
  ctx.db.run('UPDATE usage_events SET input_tokens = ?, output_tokens = ?, ok = ? WHERE id = ?', [
    Math.max(0, Math.round(u.inputTokens ?? 0)),
    Math.max(0, Math.round(u.outputTokens ?? 0)),
    u.ok === false ? 0 : 1,
    id,
  ]);
}

export function monthlyUsage(ctx: Ctx, workspaceId: number, month: string) {
  return ctx.db.all<{ kind: string; provider: string; operation: string; calls: number; credits: number; inputTokens: number; outputTokens: number }>(
    `SELECT kind, provider, operation, COUNT(*) AS calls, SUM(credits) AS credits, SUM(input_tokens) AS "inputTokens", SUM(output_tokens) AS "outputTokens"
     FROM usage_events WHERE workspace_id = ? AND month = ?
     GROUP BY kind, provider, operation ORDER BY kind, provider, operation`,
    [workspaceId, month],
  );
}

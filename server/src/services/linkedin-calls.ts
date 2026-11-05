import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { DriverError } from '../drivers/types.js';
import { recordOutbound } from '../engine/engine.js';
import { syncAccount } from '../engine/sync.js';
import { HttpError } from '../http.js';
import type { JobInfo, JobHelpers } from '../jobs/queue.js';
import type { AccountRow, LeadRow } from '../types.js';
import { logActivity } from './activity.js';
import { releaseUnstartedLeads } from './rotation.js';

// LinkedIn browser sessions live only in the instance that runs the engine: its DriverPool keeps one session
// per account and serializes its calls, so another instance sharing the database must never open the same
// account. LinkedIn calls the API makes for the user (Check, Sync now, inbox replies) run right here on that
// instance; any other one sends them to it as a job and the request waits for the answer.

export type LinkedInCall = { op: 'check'; accountId: number } | { op: 'sync'; accountId: number } | { op: 'reply'; conversationId: number; text: string };

// What the job stores: an HttpError travels back to the waiting request as status and message.
type Outcome = { ok: true; value: unknown } | { ok: false; status: number; message: string };

// The leader claims jobs every TICK_MS; a reply waits behind that account's running action.
const WAIT_MS = 90_000;
const POLL_MS = 300;

export const LINKEDIN_CALL_JOB_OPTIONS = { maxAttempts: 1 };

export async function callLinkedIn(ctx: Ctx, workspaceId: number, call: LinkedInCall): Promise<any> {
  if (ctx.isLeader()) return perform(ctx, workspaceId, call);
  // One attempt: a message must never go out twice because a retry didn't know the first one landed.
  const id = ctx.jobs.enqueue('linkedin.call', call, { workspaceId, maxAttempts: 1 });
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const job = ctx.jobs.get(id, workspaceId);
    if (!job || job.status === 'cancelled') throw new HttpError(409, 'The LinkedIn request was cancelled');
    if (job.status === 'done') {
      const out = json<Outcome | null>(job.result, null);
      if (out && !out.ok) throw new HttpError(out.status, out.message);
      return out?.value ?? { ok: true };
    }
    if (job.status === 'failed') throw new HttpError(422, job.last_error ?? 'The LinkedIn request failed');
    if (Date.now() >= deadline) {
      // Not started: withdraw it, so it doesn't run long after the user gave up.
      if (ctx.jobs.cancel(id, workspaceId) === 'ok') {
        throw new HttpError(503, 'The server that runs LinkedIn sessions did not take the request. Check that the campaign engine is running, then try again.');
      }
      throw new HttpError(504, 'LinkedIn is still working on it. Refresh in a moment to see the result.');
    }
  }
}

export async function linkedInCallJob(job: JobInfo<LinkedInCall>, h: JobHelpers): Promise<Outcome> {
  try {
    return { ok: true, value: await perform(h.ctx, job.workspaceId!, job.payload) };
  } catch (e) {
    if (e instanceof HttpError) return { ok: false, status: e.status, message: e.message };
    throw e;
  }
}

// Rows are re-loaded with the workspace id: a job's payload is only trusted as far as its workspace.
async function perform(ctx: Ctx, workspaceId: number, call: LinkedInCall): Promise<unknown> {
  if (call.op === 'reply') return reply(ctx, workspaceId, call.conversationId, call.text);
  const a = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND workspace_id = ?', [call.accountId, workspaceId]);
  if (!a) throw new HttpError(404, 'Account not found');
  return call.op === 'check' ? check(ctx, a) : sync(ctx, a);
}

// Opens LinkedIn with the saved session and records whose account it is.
async function check(ctx: Ctx, a: AccountRow) {
  try {
    const info = await ctx.drivers.use(a, (d) => d.checkSession());
    ctx.db.run("UPDATE accounts SET linkedin_name = ?, linkedin_url = ?, status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'active' END, status_message = NULL WHERE id = ?", [info.name, info.profileUrl, a.id]);
    return { ok: true, ...info };
  } catch (e) {
    const msg = (e as Error).message;
    if (e instanceof DriverError && (e.code === 'SESSION_EXPIRED' || e.code === 'CHECKPOINT')) {
      ctx.db.run("UPDATE accounts SET status = 'needs_login', status_message = ? WHERE id = ?", [msg, a.id]);
      releaseUnstartedLeads(ctx, a.id);
    }
    throw new HttpError(422, msg);
  }
}

async function sync(ctx: Ctx, a: AccountRow) {
  try {
    const r = await syncAccount(ctx, a);
    ctx.db.run('UPDATE accounts SET last_sync_at = ? WHERE id = ?', [ctx.clock.now(), a.id]);
    return r;
  } catch (e) {
    throw new HttpError(422, (e as Error).message);
  }
}

async function reply(ctx: Ctx, workspaceId: number, conversationId: number, text: string) {
  const c = ctx.db.get<{ id: number; account_id: number | null; lead_id: number | null; participant_url: string }>(
    "SELECT id, account_id, lead_id, participant_url FROM conversations WHERE id = ? AND workspace_id = ? AND channel = 'linkedin'",
    [conversationId, workspaceId],
  );
  if (!c) throw new HttpError(404, 'Conversation not found');
  const a = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND workspace_id = ?', [c.account_id, workspaceId]);
  if (!a) throw new HttpError(409, 'This conversation has no LinkedIn account to reply from');
  if (a.status === 'needs_login') throw new HttpError(409, 'This LinkedIn account needs a fresh session cookie before it can send');
  try {
    await ctx.drivers.use(a, (d) => d.sendMessage(c.participant_url, text));
  } catch (e) {
    throw new HttpError(422, `LinkedIn did not accept the message: ${(e as Error).message}`);
  }
  const lead = c.lead_id ? ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [c.lead_id, workspaceId]) : undefined;
  if (lead) recordOutbound(ctx, a, lead, text);
  else {
    ctx.db.insert('messages', { conversation_id: c.id, external_id: `local:${Date.now()}`, direction: 'out', body: text, sent_at: ctx.clock.now() });
    ctx.db.run('UPDATE conversations SET last_message_at = ? WHERE id = ?', [ctx.clock.now(), c.id]);
  }
  logActivity(ctx, { workspaceId: a.workspace_id, accountId: a.id, leadId: c.lead_id, type: 'message', detail: text, timezone: a.timezone });
  return { ok: true };
}

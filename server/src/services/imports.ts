import { DAY, MINUTE } from '../clock.js';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { DriverError, SignInOpen, type LinkedInDriver, type Person } from '../drivers/types.js';
import { nextWorkingDay } from '../engine/capacity.js';
import { accountLimits, accountNeedsLogin, isSessionError, schedule, usage } from '../engine/engine.js';
import { isWorkingTime, localParts, nextWorkingTime, randomDelay } from '../engine/limits.js';
import { PermanentError, RetryLater, type JobHelpers, type JobInfo } from '../jobs/queue.js';
import type { AccountRow, ImportKind, ImportRow } from '../types.js';
import { autoEnrichImported } from './enrichment.js';
import { importLeads, personToLead } from './leads.js';

// Collecting leads from LinkedIn (a search, a post's reactions and comments, an event's attendees or
// a group's members) runs as a background job, so a 1,000-profile scrape survives restarts and shows
// progress. Scraping uses the account's browser like an action does: only in working hours, never
// right after an action, and within a daily budget of profiles (the `scrape` limit).

export const IMPORT_KINDS = ['search', 'post', 'event', 'group'] as const;

export interface ImportOptions {
  limit: number;
  likers?: boolean;
  commenters?: boolean;
  // Find and verify emails for the added leads (unset: the workspace's enrichment setting decides).
  autoEnrich?: boolean;
}

const URL_RULES: Record<ImportKind, { path: RegExp; message: string }> = {
  search: { path: /^\/(search|sales)\//i, message: 'Paste the URL of a LinkedIn or Sales Navigator people search' },
  post: { path: /^\/(posts|feed\/update)\/[^/]+/i, message: 'Paste the URL of a LinkedIn post (it contains /posts/ or /feed/update/)' },
  event: { path: /^\/events\/[^/]+/i, message: 'Paste the URL of a LinkedIn event (it contains /events/)' },
  group: { path: /^\/groups\/[^/]+/i, message: 'Paste the URL of a LinkedIn group (it contains /groups/ and the group number)' },
};

// Why `url` can't be used for this kind of import, or null when it can.
export function sourceUrlProblem(kind: ImportKind, url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'That is not a valid URL';
  }
  if (!/^https?:$/.test(u.protocol) || !/(^|\.)linkedin\.com$/i.test(u.hostname)) return 'Must be a linkedin.com URL';
  return URL_RULES[kind].path.test(u.pathname) ? null : URL_RULES[kind].message;
}

// Records the import and queues its job. The caller has checked the list and account belong to the workspace.
export function startImport(ctx: Ctx, workspaceId: number, listId: number, account: AccountRow, kind: ImportKind, url: string, options: ImportOptions): number {
  const importId = ctx.db.insert('imports', {
    workspace_id: workspaceId,
    list_id: listId,
    account_id: account.id,
    kind,
    source: url,
    options: JSON.stringify(options),
    created_at: ctx.clock.now(),
  });
  const jobId = ctx.jobs.enqueue('leads.import', { importId }, { workspaceId, dedupeKey: `leads.import:${importId}` });
  ctx.db.update('imports', importId, { job_id: jobId });
  return importId;
}

function collect(d: LinkedInDriver, kind: ImportKind, url: string, o: ImportOptions, limit: number, onPage: (n: number) => void): Promise<Person[]> {
  switch (kind) {
    case 'search':
      return d.search(url, limit, onPage);
    case 'post':
      return d.postEngagers(url, { likers: o.likers ?? true, commenters: o.commenters ?? true }, limit, onPage);
    case 'event':
      return d.eventAttendees(url, limit, onPage);
    case 'group':
      return d.groupMembers(url, limit, onPage);
  }
}

const MAX_ATTEMPTS = 3;
// How long actions are held off while a scrape runs (released as soon as it ends).
const SCRAPE_HOLD = 60 * MINUTE;
// How often an import queued behind another one on the same account checks again.
const QUEUED_BEHIND = 5 * MINUTE;

export async function importJob(job: JobInfo<{ importId: number }>, h: JobHelpers) {
  const { ctx } = h;
  const imp = ctx.db.get<ImportRow>('SELECT * FROM imports WHERE id = ? AND workspace_id = ?', [job.payload.importId, job.workspaceId]);
  if (!imp) throw new PermanentError('Import not found');
  // Idempotent: a job that runs again after a crash leaves a finished import alone.
  if (imp.status !== 'running') return { status: imp.status };
  const fail = (message: string) => {
    ctx.db.update('imports', imp.id, { status: 'failed', error: message, finished_at: ctx.clock.now() });
    return new PermanentError(message);
  };
  const note = (text: string | null) => ctx.db.update('imports', imp.id, { note: text });
  const load = () => (imp.account_id == null ? undefined : ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND workspace_id = ?', [imp.account_id, imp.workspace_id]));
  const account = load();
  if (!account) throw fail('The LinkedIn account for this import was removed');
  if (!ctx.db.get('SELECT 1 FROM lead_lists WHERE id = ? AND workspace_id = ?', [imp.list_id, imp.workspace_id])) throw fail('The lead list was deleted');
  const opts = json<ImportOptions>(imp.options, { limit: 100 });
  // One import per account at a time: one queued behind another's scrape would hold a job slot and
  // could time out waiting for the browser.
  const ahead = ctx.db.get(
    `SELECT 1 FROM imports i JOIN jobs j ON j.id = i.job_id
     WHERE i.account_id = ? AND i.id < ? AND i.status = 'running' AND j.status = 'running'`,
    [account.id, imp.id],
  );
  if (ahead) {
    note(`Waiting for another import from ${account.name} to finish`);
    throw new RetryLater(QUEUED_BEHIND, 'Another import is using this account');
  }

  let scraped: { people: Person[]; budget: number; clamped: boolean } | null;
  try {
    // Every check happens inside the account's driver lock: an action or another import may have
    // used the account while this job waited for it.
    scraped = await ctx.drivers.use(account, async (d) => {
      // A run that timed out while waiting here has been retried (or the import has finished
      // meanwhile): it must not scrape too, which would browse LinkedIn twice for one import.
      if (h.signal.aborted) return null;
      const cur = ctx.db.get<Pick<ImportRow, 'status' | 'day' | 'scraped'>>('SELECT status, day, scraped FROM imports WHERE id = ?', [imp.id]);
      if (cur?.status !== 'running') return null;
      const a = load();
      if (!a) throw fail('The LinkedIn account for this import was removed');
      const now = ctx.clock.now();
      const wait = (ms: number, why: string) => (note(why), new RetryLater(Math.max(MINUTE, ms), why));
      if (a.status !== 'active') throw wait(30 * MINUTE, `Waiting for ${a.name} to be active again`);
      if (!isWorkingTime(now, schedule(a))) throw wait(nextWorkingTime(now, schedule(a)) - now, `Waiting for ${a.name}'s working hours`);
      // Never scrape straight after an action: wait out the same randomized pause.
      if (a.next_action_at > now) throw new RetryLater(a.next_action_at - now, 'Waiting for the pause after the last action');
      const budget = accountLimits(ctx, a).scrape;
      const left = budget - (usage(ctx, a).scrape ?? 0);
      if (left <= 0) throw wait(nextWorkingDay(now, a) - now, `${a.name} has collected its ${budget} profiles for today; continuing on its next working day`);
      const limit = Math.min(opts.limit, left);

      // Hold the account's actions for the duration, then pause before the next one as after an action.
      ctx.db.run('UPDATE accounts SET next_action_at = ? WHERE id = ?', [now + SCRAPE_HOLD, a.id]);
      // `found` restarts with each attempt, but profiles an earlier attempt loaded today stay in the budget.
      const day = localParts(now, a.timezone).date;
      const before = cur.day === day ? cur.scraped : 0;
      ctx.db.update('imports', imp.id, { day, scraped: before, found: 0, note: null });
      try {
        const people = await collect(d, imp.kind, imp.source, opts, limit, (found) => {
          const n = Math.min(found, limit);
          ctx.db.run('UPDATE imports SET found = ?, scraped = ? WHERE id = ?', [n, before + n, imp.id]);
          h.progress(n, limit);
        });
        return { people: people.slice(0, limit), budget, clamped: limit < opts.limit };
      } finally {
        ctx.db.run('UPDATE accounts SET next_action_at = ? WHERE id = ?', [ctx.clock.now() + randomDelay(a.delay_min_sec, a.delay_max_sec, ctx.random), a.id]);
      }
    });
  } catch (e) {
    if (e instanceof RetryLater || e instanceof PermanentError) throw e;
    if (e instanceof SignInOpen) {
      note(`Waiting for ${account.name} to finish signing in`);
      throw new RetryLater(2 * MINUTE, e.message);
    }
    if (isSessionError(e)) {
      // The account stops like it does after a failed action; the import resumes once it is reconnected.
      await accountNeedsLogin(ctx, account, e.message);
      note(`Waiting for ${account.name} to be active again`);
      throw new RetryLater(30 * MINUTE, e.message);
    }
    if (e instanceof DriverError && e.code === 'NOT_FOUND') throw fail(e.message);
    if (e instanceof DriverError && e.code === 'LIMIT_REACHED') {
      note(`LinkedIn pushed back (${e.message}); trying again in a day`);
      throw new RetryLater(DAY, e.message);
    }
    const message = (e as Error).message;
    if (job.attempts >= MAX_ATTEMPTS) throw fail(message);
    note(`Retrying after an error: ${message}`);
    throw e;
  }
  if (!scraped) return { status: ctx.db.get<{ status: string }>('SELECT status FROM imports WHERE id = ?', [imp.id])?.status ?? 'gone' };
  // Cancelled while the browser was collecting: keep the "Cancelled" result and add nobody.
  const after = ctx.db.get<{ status: string }>('SELECT status FROM imports WHERE id = ?', [imp.id]);
  if (after?.status !== 'running') return { status: after?.status ?? 'gone' };

  const r = importLeads(ctx, imp.workspace_id, imp.list_id, scraped.people.map(personToLead), { skipBlacklisted: true, emailSource: 'linkedin' });
  const result = { found: scraped.people.length, added: r.added, duplicates: r.duplicates, blacklisted: r.blacklisted ?? 0 };
  autoEnrichImported(ctx, imp.workspace_id, r.addedIds, null, opts.autoEnrich);
  ctx.db.update('imports', imp.id, {
    status: 'done',
    ...result,
    error: null,
    note: scraped.clamped ? `Stopped at this account's daily limit of ${scraped.budget} profiles. Run the import again tomorrow for more.` : null,
    finished_at: ctx.clock.now(),
  });
  return result;
}

export const IMPORT_JOB_OPTIONS = { timeoutMs: 60 * MINUTE, maxAttempts: MAX_ATTEMPTS };

// Stops a running import. A queued job is cancelled; one that is scraping right now finishes its page
// and then adds nobody (importJob re-reads the status), since a browser mid-scroll can't be interrupted.
export function cancelImport(ctx: Ctx, imp: ImportRow): 'ok' | 'not_running' {
  const now = ctx.clock.now();
  const changed = ctx.db.run("UPDATE imports SET status = 'failed', error = 'Cancelled', note = NULL, finished_at = ? WHERE id = ? AND status = 'running'", [now, imp.id]);
  if (!changed.changes) return 'not_running';
  if (imp.job_id != null) ctx.jobs.cancel(imp.job_id, imp.workspace_id);
  return 'ok';
}

export function serializeImport(i: ImportRow & { list_name: string | null; account_name: string | null; job_status: string | null; job_error: string | null }) {
  const opts = json<ImportOptions>(i.options, { limit: 0 });
  // A job cancelled from the jobs API leaves the import row running; show it as stopped.
  const stopped = i.status === 'running' && (i.job_status === 'cancelled' || i.job_status === 'failed');
  return {
    id: i.id,
    listId: i.list_id,
    listName: i.list_name,
    accountId: i.account_id,
    accountName: i.account_name,
    kind: i.kind,
    source: i.source,
    options: { limit: opts.limit, likers: opts.likers ?? null, commenters: opts.commenters ?? null },
    status: stopped ? 'failed' : i.status,
    found: i.found,
    added: i.added,
    duplicates: i.duplicates,
    blacklisted: i.blacklisted,
    error: stopped ? (i.job_status === 'cancelled' ? 'Cancelled' : i.job_error) : i.error,
    note: i.note,
    progress: { done: i.found, total: opts.limit || null },
    jobId: i.job_id,
    createdAt: i.created_at,
    finishedAt: i.finished_at,
  };
}

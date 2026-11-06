import { createHash } from 'node:crypto';
import { MINUTE } from '../clock.js';
import type { Ctx } from '../context.js';
import { isVariantNode, nodeVariants, withVariant, type AiVariable, type SeqNode, type VariantId } from '../engine/sequence.js';
import { aiNamesIn } from '../engine/template.js';
import { PermanentError, RetryLater, type JobHelpers, type JobInfo } from '../jobs/queue.js';
import { AI_MAX_TIMEOUT_SECONDS } from '../providers/ai/types.js';
import { ProviderError } from '../providers/http.js';
import { logActivity } from '../services/activity.js';
import { campaignSequence, campaignSettings } from '../services/leads.js';
import type { CampaignLeadRow, CampaignRow, LeadRow } from '../types.js';
import { aiProvider, completeAi } from './complete.js';
import { personalizeRequest } from './prompts.js';

export { aiNamesIn };

// {{ai:name}} variables are generated per campaign lead by the ai.personalize job before the step
// that uses them runs, and cached in campaign_lead_ai. The engine waits a bounded time for them
// (AI_WAIT_MAX_MIN), then sends with the variable's fallback; one lead's failure never holds up others.

export const AI_RECHECK = 2 * MINUTE;
// One request may take up to AI_MAX_TIMEOUT_SECONDS (a slow local model), and progress is reported after each.
export const AI_JOB_OPTIONS = { concurrency: 2, maxAttempts: 3, timeoutMs: AI_MAX_TIMEOUT_SECONDS * 1000 + MINUTE };

export interface AiRow {
  campaign_lead_id: number;
  name: string;
  instruction_hash: string;
  status: 'pending' | 'ready' | 'failed';
  value: string | null;
  error: string | null;
  simulated: number;
  requested_at: number;
  generated_at: number | null;
}

// A changed instruction or length makes a cached value stale; the fallback can change freely.
export const definitionHash = (v: Pick<AiVariable, 'instruction' | 'maxChars'>) => createHash('sha256').update(`${v.instruction}\u0000${v.maxChars}`).digest('hex').slice(0, 16);

// The texts a step sends (after its variant is applied).
export function nodeTexts(node: SeqNode): string[] {
  if (node.type === 'connect') return [node.note];
  if (node.type === 'message' || node.type === 'sms' || node.type === 'whatsapp') return [node.text];
  if (node.type === 'email' || node.type === 'inmail') return [node.subject, node.body];
  return [];
}

// Model output made safe to drop into a template: one line, no braces (spintax), within the length.
export function tidyAiValue(text: string, maxChars: number): string {
  let v = text
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .trim();
  if (v.length > maxChars) {
    const cut = v.slice(0, maxChars);
    const space = cut.lastIndexOf(' ');
    v = (space > maxChars * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, '');
  }
  return v;
}

const jobKey = (campaignLeadId: number) => `ai.personalize:cl:${campaignLeadId}`;

function definitions(campaign: CampaignRow, names: string[]): AiVariable[] {
  return campaignSettings(campaign).aiVariables.filter((v) => names.includes(v.name));
}

function rowsFor(ctx: Ctx, campaignLeadId: number): Map<string, AiRow> {
  return new Map(ctx.db.all<AiRow>('SELECT * FROM campaign_lead_ai WHERE campaign_lead_id = ?', [campaignLeadId]).map((r) => [r.name, r]));
}

// Makes sure every named variable has a current row: missing or stale ones become pending, and a job
// generates them. The job's dedupe key absorbs an enqueue while it runs, so pending rows with no live
// job (a new name added while it ran, or a run that timed out) get a new one here.
export function requestAiVars(ctx: Ctx, campaign: CampaignRow, cl: Pick<CampaignLeadRow, 'id'>, names: string[]): Map<string, AiRow> {
  const defs = definitions(campaign, names);
  if (!defs.length) return new Map();
  const now = ctx.clock.now();
  const rows = rowsFor(ctx, cl.id);
  // Simulated text cached before a real AI provider was connected is generated again by the real one
  // (otherwise a real account would send the fallback for it forever). Looked up only when needed.
  let realAi: boolean | undefined;
  const isRealAi = () => (realAi ??= ctx.providers.get(campaign.workspace_id, 'ai')?.simulated === false);
  for (const def of defs) {
    const row = rows.get(def.name);
    const hash = definitionHash(def);
    if (row && row.instruction_hash === hash && !(row.status === 'ready' && row.simulated && isRealAi())) continue;
    ctx.db.run(
      `INSERT INTO campaign_lead_ai (campaign_lead_id, name, instruction_hash, status, requested_at) VALUES (?, ?, ?, 'pending', ?)
       ON CONFLICT (campaign_lead_id, name) DO UPDATE SET instruction_hash = excluded.instruction_hash, status = 'pending', value = NULL, error = NULL,
         simulated = 0, requested_at = excluded.requested_at, generated_at = NULL`,
      [cl.id, def.name, hash, now],
    );
    rows.set(def.name, { campaign_lead_id: cl.id, name: def.name, instruction_hash: hash, status: 'pending', value: null, error: null, simulated: 0, requested_at: now, generated_at: null });
  }
  const waiting = defs.some((d) => rows.get(d.name)!.status === 'pending' && now - rows.get(d.name)!.requested_at < ctx.config.aiWaitMaxMin * MINUTE);
  if (waiting && !ctx.db.get("SELECT 1 FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running')", [jobKey(cl.id)])) {
    ctx.jobs.enqueue('ai.personalize', { campaignLeadId: cl.id }, { workspaceId: campaign.workspace_id, dedupeKey: jobKey(cl.id) });
  }
  return rows;
}

// Called when a lead walks onto an action step, so the text is usually ready by the time it runs.
// The variant is only fixed when the step runs, so without a stored choice every variant's names are fetched.
export function prefetchAi(ctx: Ctx, campaign: CampaignRow, cl: Pick<CampaignLeadRow, 'id'>, node: SeqNode) {
  if (!isVariantNode(node)) return;
  // Cheap check first: this runs on every step change, and most steps use no AI variables.
  const all = nodeVariants(node).flatMap((v) => [v.note, v.text, v.subject, v.body].filter((t): t is string => t != null));
  if (!aiNamesIn(all).length || !campaignSettings(campaign).aiVariables.length) return;
  const stored = ctx.db.get<{ variant: string }>('SELECT variant FROM campaign_lead_variants WHERE campaign_lead_id = ? AND node_id = ?', [cl.id, node.id]);
  const texts = stored
    ? nodeTexts(withVariant(node, stored.variant as VariantId))
    : all;
  const names = aiNamesIn(texts);
  if (names.length) requestAiVars(ctx, campaign, cl, names);
}

// How each AI variable is doing across the campaign's leads, for the settings page.
export function aiValueCounts(ctx: Ctx, campaign: CampaignRow) {
  const rows = ctx.db.all<{ name: string; status: AiRow['status']; n: number; last_error: string | null }>(
    `SELECT a.name, a.status, COUNT(*) AS n, MAX(a.error) AS last_error FROM campaign_lead_ai a JOIN campaign_leads cl ON cl.id = a.campaign_lead_id
     WHERE cl.campaign_id = ? GROUP BY a.name, a.status`,
    [campaign.id],
  );
  return campaignSettings(campaign).aiVariables.map((v) => {
    const mine = rows.filter((r) => r.name === v.name);
    const count = (s: AiRow['status']) => mine.find((r) => r.status === s)?.n ?? 0;
    return { name: v.name, ready: count('ready'), pending: count('pending'), failed: count('failed'), lastError: mine.find((r) => r.status === 'failed')?.last_error ?? null };
  });
}

// Failed values stay failed (the fallback is sent) so a broken key doesn't retry forever. Once the
// user has fixed the cause, this clears them for leads still in the campaign and asks again for those
// standing on a step that uses them; the rest are generated when they reach such a step.
export function retryFailedAi(ctx: Ctx, campaign: CampaignRow): number {
  const seq = campaignSequence(campaign);
  return ctx.db.tx(() => {
    const failed = ctx.db.all<{ id: number; node_id: string | null }>(
      `SELECT DISTINCT cl.id, cl.node_id FROM campaign_leads cl JOIN campaign_lead_ai a ON a.campaign_lead_id = cl.id
       WHERE cl.campaign_id = ? AND cl.state = 'active' AND a.status = 'failed'`,
      [campaign.id],
    );
    for (const cl of failed) {
      ctx.db.run("DELETE FROM campaign_lead_ai WHERE campaign_lead_id = ? AND status = 'failed'", [cl.id]);
      const node = cl.node_id ? seq.nodes[cl.node_id] : undefined;
      if (node) prefetchAi(ctx, campaign, cl, node);
    }
    return failed.length;
  });
}

// 'failed' notes record a one-time change (the row fails), so they are logged right away; 'skipped'
// notes repeat on every run, so they are logged only with the step's outcome (not on retries or holds).
export interface AiNote {
  status: 'failed' | 'skipped';
  detail: string;
}

export type AiResolution = { wait: number } | { values: Record<string, string>; notes: AiNote[] };

// Values for a step about to send. `realChannel`: the text would reach a real person (a browser
// LinkedIn account or real SMTP), so simulated AI text is replaced by the fallback there.
export function resolveAiVars(ctx: Ctx, campaign: CampaignRow, cl: Pick<CampaignLeadRow, 'id'>, names: string[], realChannel: boolean): AiResolution {
  const defs = definitions(campaign, names);
  const rows = requestAiVars(ctx, campaign, cl, names);
  const now = ctx.clock.now();
  const limit = ctx.config.aiWaitMaxMin * MINUTE;
  const pending = defs.map((d) => rows.get(d.name)!).filter((r) => r.status === 'pending');
  const young = pending.filter((r) => now - r.requested_at < limit);
  if (young.length) return { wait: Math.min(...young.map((r) => r.requested_at)) + limit };

  const values: Record<string, string> = {};
  const notes: AiNote[] = [];
  for (const def of defs) {
    const row = rows.get(def.name)!;
    const key = `ai:${def.name}`;
    values[key] = def.fallback;
    if (row.status === 'pending') {
      // Waited long enough: the fallback goes out, and later steps don't wait for this value again.
      const error = `Not ready after ${ctx.config.aiWaitMaxMin} minutes`;
      ctx.db.run("UPDATE campaign_lead_ai SET status = 'failed', error = ? WHERE campaign_lead_id = ? AND name = ? AND status = 'pending'", [error, cl.id, def.name]);
      notes.push({ status: 'failed', detail: `{{${key}}}: ${error}; sent the fallback` });
    } else if (row.status === 'ready' && row.simulated && realChannel) {
      notes.push({ status: 'skipped', detail: `{{${key}}}: Simulated AI text is not sent to real people; sent the fallback` });
    } else if (row.status === 'ready' && row.value) {
      values[key] = row.value;
    }
  }
  return { values, notes };
}

// Values for a preview in the builder: generated now, not cached, nothing sent.
export async function previewAiVars(ctx: Ctx, workspaceId: number, lead: LeadRow, defs: AiVariable[]) {
  const provider = aiProvider(ctx, workspaceId);
  const values: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const def of defs) {
    try {
      const out = await completeAi(ctx, workspaceId, personalizeRequest(lead, def), provider);
      values[def.name] = tidyAiValue(out.text, def.maxChars);
    } catch (e) {
      errors[def.name] = e instanceof ProviderError ? e.message : 'Generation failed';
      values[def.name] = def.fallback;
    }
  }
  return { values, errors, simulated: provider.simulated };
}

const PERMANENT_CODES = ['AUTH', 'QUOTA', 'BAD_REQUEST'];

// Whether this failure ends the job (no retry follows), so its effects (failed rows, activity) apply now.
export function isFinalAiError(e: unknown, attempts: number, maxAttempts = AI_JOB_OPTIONS.maxAttempts) {
  if (e instanceof RetryLater || (e instanceof ProviderError && e.code === 'RATE_LIMIT')) return false;
  if (e instanceof PermanentError || (e instanceof ProviderError && PERMANENT_CODES.includes(e.code))) return true;
  return attempts >= maxAttempts;
}

// Ends the AI wait of a lead parked by the engine (only that wait: retry back-offs and limit waits stay).
function wake(ctx: Ctx, campaignLeadId: number) {
  const now = ctx.clock.now();
  ctx.db.run("UPDATE campaign_leads SET next_run_at = ? WHERE id = ? AND state = 'active' AND attempts = 0 AND next_run_at > ? AND next_run_at <= ?", [now, campaignLeadId, now, now + AI_RECHECK]);
}

// Job handler: generates the lead's pending variables. Works from the database (not the payload) so a
// re-run after a crash, or rows added while it ran, are handled the same way.
export async function personalizeJob(job: JobInfo<{ campaignLeadId: number }>, h: JobHelpers) {
  const { ctx } = h;
  let generated = 0;
  // A few rounds pick up names requested while a round was generating.
  for (let round = 0; round < 3; round++) {
    const cl = ctx.db.get<CampaignLeadRow>('SELECT cl.* FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.id = ? AND c.workspace_id = ?', [
      job.payload.campaignLeadId,
      job.workspaceId,
    ]);
    if (!cl) return { generated, note: 'Campaign lead no longer exists' };
    const campaign = ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?', [cl.campaign_id, job.workspaceId])!;
    const lead = ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [cl.lead_id, job.workspaceId]);
    if (!lead) return { generated, note: 'Lead no longer exists' };
    const defs = new Map(campaignSettings(campaign).aiVariables.map((d) => [d.name, d]));
    const pending = ctx.db.all<AiRow>("SELECT * FROM campaign_lead_ai WHERE campaign_lead_id = ? AND status = 'pending' ORDER BY name", [cl.id]);
    if (!pending.length) break;
    const provider = aiProvider(ctx, campaign.workspace_id);
    for (const [i, row] of pending.entries()) {
      const def = defs.get(row.name);
      if (!def) {
        // The variable was removed from the campaign; nothing uses it any more.
        ctx.db.run('DELETE FROM campaign_lead_ai WHERE campaign_lead_id = ? AND name = ?', [cl.id, row.name]);
        continue;
      }
      try {
        const out = await completeAi(ctx, campaign.workspace_id, personalizeRequest(lead, def), provider);
        const value = tidyAiValue(out.text, def.maxChars);
        if (!value) throw new ProviderError('BAD_REQUEST', 'The AI returned an empty text');
        // Stored under the definition it was generated from; if that changed meanwhile, the engine asks again.
        ctx.db.run(
          "UPDATE campaign_lead_ai SET status = 'ready', value = ?, error = NULL, simulated = ?, generated_at = ?, instruction_hash = ? WHERE campaign_lead_id = ? AND name = ? AND status = 'pending'",
          [value, out.simulated ? 1 : 0, ctx.clock.now(), definitionHash(def), cl.id, row.name],
        );
        generated++;
        h.progress(generated);
      } catch (e) {
        if (isFinalAiError(e, job.attempts)) failRows(ctx, campaign, cl, pending.slice(i).map((r) => r.name), e);
        if (generated) wake(ctx, cl.id);
        throw e;
      }
    }
    wake(ctx, cl.id);
  }
  return { generated };
}

// The last attempt failed: the rows fail (the engine sends their fallbacks), and the failure shows in the
// activity feed and on the campaign lead. The lead is woken so it doesn't wait out AI_WAIT_MAX_MIN.
function failRows(ctx: Ctx, campaign: CampaignRow, cl: CampaignLeadRow, names: string[], e: unknown) {
  const message = (e instanceof ProviderError || e instanceof PermanentError ? e.message : 'AI generation failed').slice(0, 300);
  ctx.db.tx(() => {
    for (const name of names) {
      ctx.db.run("UPDATE campaign_lead_ai SET status = 'failed', error = ? WHERE campaign_lead_id = ? AND name = ? AND status = 'pending'", [message, cl.id, name]);
    }
    logActivity(ctx, {
      workspaceId: campaign.workspace_id,
      accountId: cl.account_id,
      campaignId: campaign.id,
      leadId: cl.lead_id,
      type: 'ai_personalize',
      status: 'failed',
      detail: `${names.map((n) => `{{ai:${n}}}`).join(', ')}: ${message}`,
    });
    ctx.db.update('campaign_leads', cl.id, { last_error: `AI: ${message}` });
  });
  wake(ctx, cl.id);
}

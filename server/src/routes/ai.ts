import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { previewAiVars } from '../ai/personalize.js';
import { LENGTHS, TONES, WRITER_CHANNELS } from '../ai/prompts.js';
import { writeDrafts } from '../ai/writer.js';
import { PlanLimitError } from '../billing/limits.js';
import type { Ctx } from '../context.js';
import { AiVariableSchema } from '../engine/sequence.js';
import { HttpError, idParam, notFound, parse, requireWriter } from '../http.js';
import { ProviderError } from '../providers/http.js';
import { campaignSettings } from '../services/leads.js';
import type { CampaignRow, LeadRow } from '../types.js';

// Calls a workspace may make per minute (writer and previews together), so a stuck button or a script
// can't run up the AI bill.
const CALLS_PER_MINUTE = 30;

const briefSchema = z.object({
  offer: z.string().trim().min(3, 'Describe what you offer').max(1000),
  audience: z.string().trim().max(300).optional(),
  tone: z.enum(TONES).default('friendly'),
  length: z.enum(LENGTHS).default('short'),
  language: z.string().trim().min(2).max(40).default('English'),
  cta: z.string().trim().max(200).optional(),
});

const writeSchema = z.object({
  nodeType: z.enum(WRITER_CHANNELS),
  brief: briefSchema,
  variants: z.number().int().min(1).max(5).default(1),
  leadId: z.number().int().positive().optional(),
  campaignId: z.number().int().positive().optional(),
});

const previewSchema = z.object({
  leadId: z.number().int().positive(),
  names: z.array(z.string().max(40)).max(10).optional(),
  // Unsaved definitions from the settings editor, so a new instruction can be tried before saving.
  variables: z.array(AiVariableSchema).max(10).optional(),
});

// One budget per context, shared by every route that calls the AI (writer, previews, reply suggestions).
const budgets = new WeakMap<Ctx, Map<number, number[]>>();

export function aiThrottle(ctx: Ctx) {
  if (!budgets.has(ctx)) budgets.set(ctx, new Map());
  const calls = budgets.get(ctx)!;
  // Wall-clock window: the demo clock may run faster than real time.
  return (workspaceId: number) => {
    const now = Date.now();
    const recent = (calls.get(workspaceId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= CALLS_PER_MINUTE) throw new HttpError(429, 'Too many AI requests. Wait a minute and try again.');
    recent.push(now);
    calls.set(workspaceId, recent);
  };
}

export function aiRoutes(app: FastifyInstance, ctx: Ctx) {
  const throttle = aiThrottle(ctx);
  const leadOf = (workspaceId: number, id: number) => ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [id, workspaceId]) ?? notFound('Lead');
  const campaignOf = (workspaceId: number, id: number) => ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?', [id, workspaceId]) ?? notFound('Campaign');
  // External service failures are a 422 with the provider's (already scrubbed) message; used-up plan credits a 402.
  const external = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PlanLimitError) throw new HttpError(402, e.message, e.details);
      if (e instanceof ProviderError) throw new HttpError(422, e.message);
      throw e;
    }
  };

  // Drafts text for a step. Nothing is saved or sent: the builder inserts what the user picks.
  app.post('/api/ai/write', async (req: FastifyRequest) => {
    const u = requireWriter(req);
    const body = parse(writeSchema, req.body);
    const lead = body.leadId ? leadOf(u.workspace_id, body.leadId) : null;
    const settings = body.campaignId ? campaignSettings(campaignOf(u.workspace_id, body.campaignId)) : null;
    throttle(u.workspace_id);
    return external(() =>
      writeDrafts(ctx, u.workspace_id, {
        nodeType: body.nodeType,
        brief: body.brief,
        variants: body.variants,
        lead,
        noteLimit: settings?.noteLimit,
        aiNames: settings?.aiVariables.map((v) => v.name),
      }),
    );
  });

  // AI variables for one lead, generated now and not cached.
  app.post('/api/campaigns/:id/ai/preview', async (req) => {
    const u = requireWriter(req);
    const { id } = parse(idParam, req.params);
    const campaign = campaignOf(u.workspace_id, id);
    const body = parse(previewSchema, req.body);
    const lead = leadOf(u.workspace_id, body.leadId);
    const defs = (body.variables ?? campaignSettings(campaign).aiVariables).filter((v) => !body.names || body.names.includes(v.name));
    if (!defs.length) throw new HttpError(400, 'Add an AI variable first');
    throttle(u.workspace_id);
    return external(() => previewAiVars(ctx, u.workspace_id, lead, defs));
  });
}

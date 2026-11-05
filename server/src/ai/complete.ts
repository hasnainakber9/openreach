import type { z } from 'zod';
import { assertCredits } from '../billing/limits.js';
import type { Ctx } from '../context.js';
import type { AiProvider, AiRequest, AiResult } from '../providers/ai/types.js';
import { ProviderError } from '../providers/http.js';
import { recordUsage } from '../services/usage.js';

export interface AiOutput extends AiResult {
  simulated: boolean;
  providerId: string;
}

export function aiProvider(ctx: Ctx, workspaceId: number): AiProvider {
  const p = ctx.providers.get(workspaceId, 'ai');
  if (!p) throw new ProviderError('BAD_REQUEST', 'No AI provider is available');
  return p;
}

// Every AI call goes through here, so token usage is recorded per workspace (failed calls too).
export async function completeAi(ctx: Ctx, workspaceId: number, req: AiRequest, provider = aiProvider(ctx, workspaceId)): Promise<AiOutput> {
  const usage = { workspaceId, kind: 'ai', provider: provider.providerId, operation: `ai.${req.purpose}` };
  // Hosted plans include a number of AI calls a month; the simulated provider is free.
  if (!provider.simulated) assertCredits(ctx, workspaceId, 'aiCreditsMonthly');
  try {
    const out = await provider.complete(req);
    recordUsage(ctx, { ...usage, inputTokens: out.inputTokens, outputTokens: out.outputTokens });
    return { ...out, simulated: provider.simulated, providerId: provider.providerId };
  } catch (e) {
    recordUsage(ctx, { ...usage, ok: false });
    throw e;
  }
}

// The JSON object in a reply, tolerating code fences or a sentence around it.
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

// Structured output: validated with zod; one retry with a reminder, then a BAD_REQUEST.
export async function completeJson<T extends z.ZodTypeAny>(ctx: Ctx, workspaceId: number, req: AiRequest, schema: T, provider = aiProvider(ctx, workspaceId)): Promise<{ data: z.infer<T>; out: AiOutput }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt ? `${req.prompt}\n\nYour previous answer was not valid JSON in the requested shape. Answer with the JSON object only.` : req.prompt;
    const out = await completeAi(ctx, workspaceId, { ...req, prompt }, provider);
    const parsed = schema.safeParse(extractJson(out.text));
    if (parsed.success) return { data: parsed.data, out };
  }
  throw new ProviderError('BAD_REQUEST', 'The AI did not answer in the expected format. Try again or rephrase the brief.');
}

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { ProviderError, scrub } from '../http.js';
import type { ProviderDef } from '../registry.js';
import type { AiProvider, AiRequest } from './types.js';

// Anthropic's Messages API through the official SDK (https://platform.claude.com/docs/en/api/messages).
// Follows the public docs and SDK types; tested only against fakes (ctx.fetch), never the live API.

export const ANTHROPIC_WRITER_MODEL = 'claude-sonnet-5-5';
export const ANTHROPIC_CLASSIFIER_MODEL = 'claude-haiku-5-5';
const BASE_URL = 'https://api.anthropic.com';

// Models that accept the server-side refusal fallback ("default" routing picks the fallback model).
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// Current models think adaptively and thinking counts against max_tokens, so leave room beyond the answer.
const THINKING_ROOM = 8000;

const modelName = z.string().trim().min(1).max(100);

// SDK errors to ProviderError codes, from the most specific class to the least.
export function anthropicError(e: unknown, integrationId: number | null, secrets: string[]): ProviderError {
  if (e instanceof ProviderError) return e;
  const vendor = (e as any)?.error?.error?.message;
  const detail = typeof vendor === 'string' && vendor.trim() ? `: ${scrub(vendor.trim(), secrets).slice(0, 200)}` : '';
  const opts = { integrationId };
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError('AUTH', `Anthropic rejected the API key (${e.status})${detail}`, { ...opts, status: e.status });
  }
  if (e instanceof Anthropic.RateLimitError) {
    const after = Number(e.headers?.get('retry-after'));
    return new ProviderError('RATE_LIMIT', `Anthropic is rate limiting requests${detail}`, { ...opts, status: 429, retryAfterMs: Number.isFinite(after) && after > 0 ? after * 1000 : undefined });
  }
  // A missing model is a settings problem, so it fails at once instead of retrying.
  if (e instanceof Anthropic.NotFoundError) return new ProviderError('BAD_REQUEST', `Anthropic does not know this model${detail}`, { ...opts, status: 404 });
  if (e instanceof Anthropic.BadRequestError) return new ProviderError('BAD_REQUEST', `Anthropic refused the request (400)${detail}`, { ...opts, status: 400 });
  if (e instanceof Anthropic.InternalServerError) return new ProviderError('UNAVAILABLE', `Anthropic had a server error (${e.status})${detail}`, { ...opts, status: e.status });
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('TIMEOUT', 'Anthropic did not answer in time', opts);
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError('UNAVAILABLE', 'Could not reach Anthropic', opts);
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? 0;
    if (status === 402) return new ProviderError('QUOTA', `Anthropic says the credits ran out${detail}`, { ...opts, status });
    return new ProviderError(status >= 500 ? 'UNAVAILABLE' : 'BAD_REQUEST', `Anthropic refused the request (${status})${detail}`, { ...opts, status });
  }
  return new ProviderError('UNAVAILABLE', 'The Anthropic request failed', opts);
}

export const anthropicAi: ProviderDef<'ai'> = {
  id: 'anthropic',
  kind: 'ai',
  label: 'Anthropic (Claude)',
  description: 'Claude models through the Anthropic API. Drafts messages and writes per-lead personalization.',
  docsUrl: 'https://platform.claude.com/docs/en/api/overview',
  fields: [
    { key: 'apiKey', label: 'API key', type: 'password', secret: true, required: true, placeholder: 'sk-ant-...', help: 'Create one in the Claude Console under API keys.' },
    { key: 'writerModel', label: 'Writing model', type: 'text', placeholder: ANTHROPIC_WRITER_MODEL, help: 'Used for drafts and personalization.' },
    { key: 'classifierModel', label: 'Classification model', type: 'text', placeholder: ANTHROPIC_CLASSIFIER_MODEL, help: 'A faster, cheaper model for sorting replies.' },
  ],
  credentials: z.object({ apiKey: z.string().trim().min(10).max(400) }),
  settings: z.object({ writerModel: modelName.default(ANTHROPIC_WRITER_MODEL), classifierModel: modelName.default(ANTHROPIC_CLASSIFIER_MODEL) }),
  create(ctx, cfg): AiProvider {
    const apiKey: string = cfg.credentials.apiKey ?? '';
    const secrets = [apiKey];
    // Base URL pinned so an ANTHROPIC_BASE_URL in the environment can't redirect the key elsewhere.
    // No SDK retries: the job queue retries with backoff, and the writer shows the error to the user.
    const client = new Anthropic({ apiKey, baseURL: BASE_URL, fetch: ctx.fetch, maxRetries: 0, timeout: 90_000 });
    const fail = (e: unknown) => anthropicError(e, cfg.integrationId, secrets);
    return {
      providerId: 'anthropic',
      simulated: false,
      async test() {
        if (!apiKey) return { ok: false, message: 'Add an API key first' };
        try {
          // Checks the key and the model without spending tokens.
          const m = await client.models.retrieve(cfg.settings.classifierModel);
          const writer = await client.models.retrieve(cfg.settings.writerModel);
          return { ok: true, message: `Connected. ${writer.display_name} writes, ${m.display_name} classifies.` };
        } catch (e) {
          throw fail(e);
        }
      },
      async complete(req: AiRequest) {
        if (!apiKey) throw new ProviderError('AUTH', 'No Anthropic API key is saved', { integrationId: cfg.integrationId });
        const model: string = req.tier === 'writer' ? cfg.settings.writerModel : cfg.settings.classifierModel;
        const fallback = FALLBACK_MODELS.has(model);
        let res: Anthropic.Beta.BetaMessage;
        try {
          // No temperature: current models reject sampling parameters. Effort keeps short jobs cheap.
          res = await client.beta.messages.create({
            model,
            max_tokens: req.maxTokens + THINKING_ROOM,
            system: req.system,
            messages: [{ role: 'user', content: req.prompt }],
            output_config: { effort: req.tier === 'writer' ? 'medium' : 'low' },
            ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
          });
        } catch (e) {
          throw fail(e);
        }
        if (res.stop_reason === 'refusal') throw new ProviderError('BAD_REQUEST', 'Claude declined to write this text', { integrationId: cfg.integrationId });
        const text = res.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
        if (!text) throw new ProviderError('UNAVAILABLE', 'Claude returned no text', { integrationId: cfg.integrationId });
        return { text, model: res.model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
      },
    };
  },
};

import { z } from 'zod';
import { httpJson, ProviderError } from '../http.js';
import type { ProviderDef } from '../registry.js';
import type { AiProvider, AiRequest } from './types.js';

// Any server that speaks the OpenAI-style chat completions API: POST {baseUrl}/chat/completions
// (https://platform.openai.com/docs/api-reference/chat/create), e.g. OpenAI, OpenRouter, Groq, Ollama, LM Studio.
// Follows that public API shape; tested only against fakes.

// The base URL is user-supplied, so it must be plain http(s) with no credentials or query in it.
export const baseUrlSchema = z
  .string()
  .trim()
  .max(300)
  .url('Enter a full URL such as https://api.openai.com/v1')
  .refine((v) => {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !u.search && !u.hash;
  }, 'Use an http(s) URL without a user name, password, query or #fragment')
  .transform((v) => v.replace(/\/+$/, ''));

const modelName = z.string().trim().min(1).max(200);

export const openaiCompatAi: ProviderDef<'ai'> = {
  id: 'openai_compat',
  kind: 'ai',
  label: 'OpenAI-compatible API',
  description: 'Any chat-completions API: OpenAI, OpenRouter, Groq, or a local model server such as Ollama or LM Studio.',
  fields: [
    { key: 'baseUrl', label: 'Base URL', type: 'url', required: true, placeholder: 'https://api.openai.com/v1', help: 'The part before /chat/completions.' },
    { key: 'apiKey', label: 'API key', type: 'password', secret: true, help: 'Leave empty for local servers that need none.' },
    { key: 'writerModel', label: 'Writing model', type: 'text', required: true, placeholder: 'gpt-4o-mini' },
    { key: 'classifierModel', label: 'Classification model', type: 'text', help: 'Defaults to the writing model.' },
  ],
  credentials: z.object({ apiKey: z.string().trim().min(1).max(400).optional() }),
  settings: z.object({ baseUrl: baseUrlSchema, writerModel: modelName, classifierModel: modelName.optional() }),
  create(ctx, cfg): AiProvider {
    const apiKey: string | undefined = cfg.credentials.apiKey;
    const base: string = cfg.settings.baseUrl;
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : undefined;
    const common = { headers, secrets: [apiKey], integrationId: cfg.integrationId };
    return {
      providerId: 'openai_compat',
      simulated: false,
      async test() {
        const r = await httpJson<{ data?: { id: string }[] }>(ctx, `${base}/models`, { ...common, timeoutMs: 10_000 });
        const ids = (r?.data ?? []).map((m) => m.id);
        const missing = ids.length && !ids.includes(cfg.settings.writerModel) ? ` The model "${cfg.settings.writerModel}" is not in its list, so check the name.` : '';
        return { ok: true, message: `Connected to ${new URL(base).host}.${missing}` };
      },
      async complete(req: AiRequest) {
        const model: string = req.tier === 'classifier' ? (cfg.settings.classifierModel ?? cfg.settings.writerModel) : cfg.settings.writerModel;
        const r = await httpJson<any>(ctx, `${base}/chat/completions`, {
          ...common,
          method: 'POST',
          timeoutMs: 60_000,
          body: {
            model,
            max_tokens: req.maxTokens,
            ...(req.temperature != null ? { temperature: req.temperature } : {}),
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.prompt },
            ],
          },
        });
        const text = r?.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim()) throw new ProviderError('UNAVAILABLE', `${new URL(base).host} returned no text`, { integrationId: cfg.integrationId });
        return { text: text.trim(), model: String(r.model ?? model), inputTokens: Number(r.usage?.prompt_tokens ?? 0), outputTokens: Number(r.usage?.completion_tokens ?? 0) };
      },
    };
  },
};

import { z } from 'zod';
import { billingEnabled } from '../../billing/limits.js';
import { checkHost, HostCheckError } from '../../services/hosts.js';
import { httpJson, ProviderError } from '../http.js';
import type { ProviderDef } from '../registry.js';
import { AI_MAX_TIMEOUT_SECONDS, type AiProvider, type AiRequest } from './types.js';

// Any server that speaks the OpenAI-style chat completions API: POST {baseUrl}/chat/completions
// (https://platform.openai.com/docs/api-reference/chat/create), e.g. OpenAI, OpenRouter, Groq, or a local
// model server: Ollama (http://localhost:11434/v1), llama.cpp's llama-server (http://localhost:9931/v1),
// LM Studio (http://localhost:1234/v1). Follows those public API shapes; tested only against fakes.

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

export const DEFAULT_TIMEOUT_SECONDS = 60;
const MIN_TIMEOUT_SECONDS = 5;
// Hosted installs (billing on) can't reach local model servers anyway, and the AI job slots are shared by every
// workspace, so one workspace's slow (or never-answering) server may hold a slot for at most this long.
export const HOSTED_MAX_TIMEOUT_SECONDS = 60;

// "Turn off model thinking": thinking models (Qwen3.5, Gemma 4, DeepSeek R1...) otherwise reason before they
// answer, and that reasoning counts against max_tokens, so a 200-token classification comes back empty.
// reasoning_effort 'none' is what Ollama's /v1 (and OpenAI-style servers) read; chat_template_kwargs is what
// llama.cpp's llama-server and vLLM read. Servers ignore the one they don't know, or refuse it (see below).
export const NO_THINKING = { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } } as const;
// "JSON mode for classification": the classifier is asked for JSON, and this makes the server enforce it.
export const JSON_MODE = { response_format: { type: 'json_object' } } as const;

// Optional parameters a server refused, remembered per integration, server and model so later requests
// don't pay for the refused round trip again. Kept in memory only: a restart asks again.
type Extra = 'thinking' | 'json';
const EXTRA_PARAMS: Record<Extra, Record<string, unknown>> = { thinking: NO_THINKING, json: JSON_MODE };
const refusedExtras = new Map<string, Set<Extra>>();
const REFUSED_MAX = 1000;
const remember = (key: string, extras: Extra[]) => {
  if (!extras.length) return;
  const set = refusedExtras.get(key) ?? new Set<Extra>();
  for (const x of extras) set.add(x);
  refusedExtras.delete(key);
  if (refusedExtras.size >= REFUSED_MAX) refusedExtras.delete(refusedExtras.keys().next().value!);
  refusedExtras.set(key, set);
};
export const forgetRefusedExtras = () => refusedExtras.clear();

// The ones to try after a refusal, best first: each optional parameter on its own (thinking off before JSON
// mode, as an empty answer is worse than unenforced JSON), then none.
function fallbacks(sent: Extra[]): Extra[][] {
  if (sent.length < 2) return [[]];
  return [...sent.map((x) => [x]), []];
}

// Ollama lists a model pulled as "phi4-mini" as "phi4-mini:latest", and serves either name.
const sameModel = (name: string) => name.replace(/:latest$/i, '');

// A thinking block some servers leave inside the answer text (no reasoning parser, or a model that writes it).
const THINK_BLOCK = /^\s*<think>[\s\S]*?(<\/think>\s*|$)/i;

export const openaiCompatAi: ProviderDef<'ai'> = {
  id: 'openai_compat',
  kind: 'ai',
  label: 'OpenAI-compatible API',
  description: 'Any chat-completions API: OpenAI, OpenRouter, Groq, or a model running on your own computer with Ollama, llama.cpp or LM Studio.',
  fields: [
    { key: 'baseUrl', label: 'Base URL', type: 'url', required: true, placeholder: 'https://api.openai.com/v1', help: 'The part before /chat/completions. Ollama on this computer: http://localhost:11434/v1' },
    { key: 'apiKey', label: 'API key', type: 'password', secret: true, help: 'Leave empty for local servers that need none.' },
    { key: 'writerModel', label: 'Writing model', type: 'text', required: true, placeholder: 'gpt-4o-mini', help: 'The model name as the server lists it, e.g. qwen3.5:4b in Ollama.' },
    { key: 'classifierModel', label: 'Classification model', type: 'text', help: 'Defaults to the writing model. A small model that doesn\'t think, such as phi4-mini, is fastest.' },
    {
      key: 'timeoutSeconds',
      label: 'Request timeout (seconds)',
      type: 'number',
      placeholder: String(DEFAULT_TIMEOUT_SECONDS),
      help: `How long to wait for one answer. Local models on a laptop CPU can need 300 or more; up to ${AI_MAX_TIMEOUT_SECONDS} (${HOSTED_MAX_TIMEOUT_SECONDS} on a hosted server).`,
    },
    {
      key: 'noThinking',
      label: 'Turn off model thinking',
      type: 'toggle',
      help: 'For thinking models (Qwen3.5, Gemma 4) on Ollama or llama.cpp: they answer straight away instead of using up the token budget reasoning.',
    },
    {
      key: 'jsonMode',
      label: 'JSON mode for classification',
      type: 'toggle',
      help: 'Asks the server to answer reply classification in valid JSON. Servers that don\'t support it are asked again without it.',
    },
  ],
  credentials: z.object({ apiKey: z.string().trim().min(1).max(400).optional() }),
  settings: z.object({
    baseUrl: baseUrlSchema,
    writerModel: modelName,
    classifierModel: modelName.optional(),
    timeoutSeconds: z.coerce
      .number()
      .int('Use whole seconds')
      .min(MIN_TIMEOUT_SECONDS, `Use at least ${MIN_TIMEOUT_SECONDS} seconds`)
      .max(AI_MAX_TIMEOUT_SECONDS, `Use at most ${AI_MAX_TIMEOUT_SECONDS} seconds`)
      .optional(),
    noThinking: z.boolean().optional(),
    jsonMode: z.boolean().optional(),
  }),
  hostSettings: ['baseUrl'],
  create(ctx, cfg): AiProvider {
    const apiKey: string | undefined = cfg.credentials.apiKey;
    const base: string = cfg.settings.baseUrl;
    const host = new URL(base).host;
    const maxTimeout = billingEnabled(ctx) ? HOSTED_MAX_TIMEOUT_SECONDS : AI_MAX_TIMEOUT_SECONDS;
    const timeoutSeconds: number = Math.min(cfg.settings.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, maxTimeout);
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : undefined;
    const common = { headers, secrets: [apiKey], integrationId: cfg.integrationId };
    const fail = (code: ProviderError['code'], message: string) => new ProviderError(code, message, { integrationId: cfg.integrationId });
    // Hosted installs: checked again before every request, retries included (it was checked when saved, but DNS
    // can change). fetch resolves the name once more on its own, so an answer that changes in between those two
    // lookups is not caught here.
    // Self-hosted installs (billing off) skip the check, so localhost and LAN model servers work.
    const guard = async () => {
      try {
        await checkHost(ctx, new URL(base).hostname);
      } catch (e) {
        if (e instanceof HostCheckError) throw fail(e.code === 'BLOCKED' ? 'BAD_REQUEST' : 'UNAVAILABLE', e.message);
        throw e;
      }
    };
    const chat = async (body: Record<string, unknown>) => {
      await guard();
      try {
        return await httpJson<any>(ctx, `${base}/chat/completions`, { ...common, method: 'POST', timeoutMs: timeoutSeconds * 1000, body });
      } catch (e) {
        if (e instanceof ProviderError && e.code === 'TIMEOUT') {
          const hint = timeoutSeconds < maxTimeout ? ` Local models can be slow: raise the request timeout (up to ${maxTimeout} s) or use a smaller model.` : ' Use a smaller model.';
          throw fail('TIMEOUT', `${host} did not answer within ${timeoutSeconds} s.${hint}`);
        }
        throw e;
      }
    };
    return {
      providerId: 'openai_compat',
      simulated: false,
      async test() {
        await guard();
        const r = await httpJson<{ data?: { id: string }[] }>(ctx, `${base}/models`, { ...common, timeoutMs: 10_000 });
        const ids = (r?.data ?? []).map((m) => m.id);
        const wanted = [cfg.settings.writerModel, cfg.settings.classifierModel].filter((m, i, all): m is string => !!m && all.indexOf(m) === i);
        const listed = new Set(ids.map(sameModel));
        const absent = ids.length ? wanted.filter((m) => !listed.has(sameModel(m))) : [];
        const missing = absent.length ? ` ${absent.map((m) => `"${m}"`).join(' and ')} ${absent.length > 1 ? 'are' : 'is'} not in its model list, so check the name (in Ollama, run ollama pull first).` : '';
        return { ok: true, message: `Connected to ${host}.${missing}` };
      },
      async complete(req: AiRequest) {
        const model: string = req.tier === 'classifier' ? (cfg.settings.classifierModel ?? cfg.settings.writerModel) : cfg.settings.writerModel;
        const body = {
          model,
          max_tokens: req.maxTokens,
          ...(req.temperature != null ? { temperature: req.temperature } : {}),
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.prompt },
          ],
        };
        const key = JSON.stringify([cfg.integrationId, base, model]);
        const refused = refusedExtras.get(key);
        const wanted: Extra[] = [
          ...(cfg.settings.noThinking ? (['thinking'] as const) : []),
          ...(cfg.settings.jsonMode && req.purpose === 'classify' ? (['json'] as const) : []),
        ];
        const send = (extras: Extra[]) => chat(Object.assign({}, body, ...extras.map((x) => EXTRA_PARAMS[x])));
        let sent = wanted.filter((x) => !refused?.has(x));
        let r: any;
        try {
          r = await send(sent);
        } catch (e) {
          // A server that doesn't know an optional parameter refuses the whole request (OpenAI does with
          // chat_template_kwargs on some models, LM Studio with json_object), so it is asked again with fewer:
          // each one on its own, then none. What it refused is remembered for the next request.
          const isRefusal = (err: unknown) => err instanceof ProviderError && err.code === 'BAD_REQUEST' && (err.status === 400 || err.status === 422);
          if (!isRefusal(e) || !sent.length) throw e;
          let last: unknown = e;
          let done = false;
          for (const fewer of fallbacks(sent)) {
            try {
              r = await send(fewer);
            } catch (err) {
              if (!isRefusal(err)) throw err;
              last = err;
              continue;
            }
            remember(key, sent.filter((x) => !fewer.includes(x)));
            sent = fewer;
            done = true;
            break;
          }
          if (!done) throw last;
        }
        const choice = r?.choices?.[0];
        const raw = choice?.message?.content;
        const text = typeof raw === 'string' ? raw.replace(THINK_BLOCK, '').trim() : '';
        if (!text) {
          const thought = (typeof raw === 'string' && /^\s*<think>/i.test(raw)) || !!(choice?.message?.reasoning_content || choice?.message?.reasoning);
          if (thought || choice?.finish_reason === 'length') {
            const fix = sent.includes('thinking')
              ? "Use a model that doesn't think, such as phi4-mini, or start llama-server with --reasoning-budget 0."
              : cfg.settings.noThinking
                ? `This server refused the "Turn off model thinking" parameters, so use a model that doesn't think, such as phi4-mini, or start llama-server with --reasoning-budget 0.`
                : `Turn on "Turn off model thinking", or use a model that doesn't think, such as phi4-mini.`;
            throw fail('BAD_REQUEST', `${host} used the whole token budget${thought ? ' thinking' : ''} and returned no text. ${fix}`);
          }
          throw fail('UNAVAILABLE', `${host} returned no text`);
        }
        return { text, model: String(r.model ?? model), inputTokens: Number(r.usage?.prompt_tokens ?? 0), outputTokens: Number(r.usage?.completion_tokens ?? 0) };
      },
    };
  },
};

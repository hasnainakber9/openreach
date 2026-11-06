import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyRequest } from '../src/ai/prompts.js';
import { AI_JOB_OPTIONS } from '../src/ai/personalize.js';
import { CLASSIFY_JOB_OPTIONS } from '../src/ai/classify.js';
import { forgetRefusedExtras } from '../src/providers/ai/openai-compat.js';
import type { AiRequest } from '../src/providers/ai/types.js';
import { ProviderError } from '../src/providers/http.js';
import { createIntegration } from '../src/providers/store.js';
import { fakeFetch, makeApi, makeWorld, type World } from './helpers.js';

// The OpenAI-compatible provider against local model servers (Ollama, llama-server, LM Studio): timeout,
// thinking off, JSON mode, loopback hosts. Every HTTP call is a fake; nothing touches the network.

const KEY = 'sk-local-SECRET-0123456789';
const OLLAMA = 'http://localhost:11434/v1';
const req = (o: Partial<AiRequest> = {}): AiRequest => ({ purpose: 'personalize', tier: 'writer', system: 'sys', prompt: 'first_name: Ann', maxTokens: 200, temperature: 0.7, ...o });
const answer = (content: unknown, extra: Record<string, unknown> = {}) => ({ json: { model: 'qwen3.5:4b', choices: [{ message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 4 } } });

function local(w: World, settings: Record<string, unknown> = {}, credentials: Record<string, string> = {}) {
  createIntegration(w.ctx, w.workspaceId, { kind: 'ai', provider: 'openai_compat', credentials, settings: { baseUrl: OLLAMA, writerModel: 'qwen3.5:4b', classifierModel: 'phi4-mini', ...settings } });
  return () => w.ctx.providers.get(w.workspaceId, 'ai')!;
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ProviderError;
  }
  throw new Error('expected a failure');
};

afterEach(() => {
  vi.restoreAllMocks();
  forgetRefusedExtras();
});

describe('OpenAI-compatible provider: settings', () => {
  it('validates the timeout and keeps the two switches', async () => {
    const api = await makeApi();
    await api.register('Solo');
    const make = (settings: Record<string, unknown>) => api.call('POST', '/api/integrations', { kind: 'ai', provider: 'openai_compat', settings: { baseUrl: OLLAMA, writerModel: 'qwen3.5:4b', ...settings } });
    for (const timeoutSeconds of [4, 601, 1.5, 'soon']) {
      const r = await make({ timeoutSeconds });
      expect(r.status, String(timeoutSeconds)).toBe(400);
      expect(r.body.error).toMatch(/^settings\.timeoutSeconds: /);
    }
    expect((await make({ noThinking: 'yes' })).status).toBe(400);
    const ok = await make({ timeoutSeconds: '300', noThinking: true, jsonMode: true });
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toEqual({ baseUrl: OLLAMA, writerModel: 'qwen3.5:4b', timeoutSeconds: 300, noThinking: true, jsonMode: true });
    // Cleared fields (null) go back to the defaults: 60 s, thinking left as the server has it, no JSON mode.
    const cleared = await api.call('PATCH', `/api/integrations/${ok.body.id}`, { settings: { timeoutSeconds: null, noThinking: null, jsonMode: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.settings).toEqual({ baseUrl: OLLAMA, writerModel: 'qwen3.5:4b' });
  });

  it('lists the new fields for the generic form', async () => {
    const api = await makeApi();
    await api.register('Solo');
    const r = await api.call('GET', '/api/integrations/providers');
    const def = (r.body.providers ?? r.body).find((d: any) => d.kind === 'ai' && d.id === 'openai_compat');
    expect(def.fields.map((f: any) => [f.key, f.type])).toEqual([
      ['baseUrl', 'url'],
      ['apiKey', 'password'],
      ['writerModel', 'text'],
      ['classifierModel', 'text'],
      ['timeoutSeconds', 'number'],
      ['noThinking', 'toggle'],
      ['jsonMode', 'toggle'],
    ]);
  });

  it('gives AI jobs room for the longest allowed request', () => {
    expect(AI_JOB_OPTIONS.timeoutMs).toBeGreaterThan(600_000);
    expect(CLASSIFY_JOB_OPTIONS.timeoutMs).toBeGreaterThan(600_000);
  });
});

describe('OpenAI-compatible provider: local model servers', () => {
  it('talks to Ollama on localhost with no key, and sends nothing extra by default', async () => {
    const w = makeWorld();
    const ai = local(w);
    const fetch = (w.ctx.fetch = fakeFetch([{ method: 'POST', url: /^http:\/\/localhost:11434\/v1\/chat\/completions$/, reply: () => answer(' Hi Ann ') }]));
    expect(await ai().complete(req())).toEqual({ text: 'Hi Ann', model: 'qwen3.5:4b', inputTokens: 30, outputTokens: 4 });
    expect(fetch.calls[0].headers.authorization).toBeUndefined();
    expect(JSON.parse(fetch.calls[0].body!)).toEqual({ model: 'qwen3.5:4b', max_tokens: 200, temperature: 0.7, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'first_name: Ann' }] });
    // Classification uses the classifier model, still without JSON mode while it is off.
    await ai().complete(classifyRequest([], 'Not interested, thanks'));
    const cls = JSON.parse(fetch.calls[1].body!);
    expect(cls.model).toBe('phi4-mini');
    expect(cls).not.toHaveProperty('response_format');
    expect(cls).not.toHaveProperty('reasoning_effort');
  });

  it('turns thinking off on every request and asks for JSON only when classifying', async () => {
    const w = makeWorld();
    const ai = local(w, { noThinking: true, jsonMode: true }, { apiKey: KEY });
    const fetch = (w.ctx.fetch = fakeFetch([{ method: 'POST', url: /chat\/completions$/, reply: () => answer('{"category":"not_interested","confidence":0.9}') }]));
    await ai().complete(req());
    const writer = JSON.parse(fetch.calls[0].body!);
    expect(writer).toMatchObject({ reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } });
    expect(writer).not.toHaveProperty('response_format');
    expect(fetch.calls[0].headers.authorization).toBe(`Bearer ${KEY}`);

    const out = await ai().complete(classifyRequest([{ direction: 'out', body: 'Hi Ann' }], 'Not interested, thanks'));
    expect(out.text).toBe('{"category":"not_interested","confidence":0.9}');
    const cls = JSON.parse(fetch.calls[1].body!);
    expect(cls).toMatchObject({ model: 'phi4-mini', max_tokens: 200, reasoning_effort: 'none', response_format: { type: 'json_object' } });
    // OpenAI's JSON mode needs the word JSON in the messages; the classifier prompt has it.
    expect(cls.messages[0].content).toMatch(/JSON/);
  });

  it('drops only the optional parameter the server refuses, and remembers it', async () => {
    const w = makeWorld();
    const ai = local(w, { noThinking: true, jsonMode: true });
    // LM Studio: refuses json_object but takes the thinking switch.
    const fetch = (w.ctx.fetch = fakeFetch([
      {
        url: /chat\/completions$/,
        reply: (r) => (JSON.parse(r.body!).response_format ? { status: 400, json: { error: { message: "'response_format.type' must be 'json_schema' or 'text'" } } } : answer('{"category":"interested","confidence":0.8}')),
      },
    ]));
    const out = await ai().complete(classifyRequest([], 'Sounds good, send details'));
    expect(out.text).toContain('interested');
    expect(fetch.calls).toHaveLength(2);
    const retry = JSON.parse(fetch.calls[1].body!);
    expect(retry).not.toHaveProperty('response_format');
    expect(retry).toMatchObject({ reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } });
    // The next classification skips the refused round trip and still turns thinking off.
    await ai().complete(classifyRequest([], 'Sounds good, send details'));
    expect(fetch.calls).toHaveLength(3);
    expect(JSON.parse(fetch.calls[2].body!)).toMatchObject({ reasoning_effort: 'none' });
    expect(JSON.parse(fetch.calls[2].body!)).not.toHaveProperty('response_format');
  });

  it('keeps JSON mode when only the thinking switch is refused', async () => {
    const w = makeWorld();
    const ai = local(w, { noThinking: true, jsonMode: true });
    const fetch = (w.ctx.fetch = fakeFetch([
      {
        url: /chat/,
        reply: (r) =>
          JSON.parse(r.body!).chat_template_kwargs ? { status: 400, json: { error: { message: 'Unrecognized request argument supplied: chat_template_kwargs' } } } : answer('{"category":"interested","confidence":0.8}'),
      },
    ]));
    await ai().complete(classifyRequest([], 'Sounds good'));
    // Both refused, thinking-only refused, JSON-only taken.
    const sentKeys = () => fetch.calls.map((c) => Object.keys(JSON.parse(c.body!)).filter((k) => k === 'reasoning_effort' || k === 'response_format'));
    expect(sentKeys()).toEqual([['reasoning_effort', 'response_format'], ['reasoning_effort'], ['response_format']]);
    await ai().complete(classifyRequest([], 'Sounds good'));
    expect(sentKeys()[3]).toEqual(['response_format']);

    // 422 counts as a refusal too.
    const w2 = makeWorld();
    const other = local(w2, { noThinking: true });
    w2.ctx.fetch = fakeFetch([{ url: /chat/, reply: (r) => (JSON.parse(r.body!).chat_template_kwargs ? { status: 422, json: { detail: 'extra fields not permitted' } } : answer('ok')) }]);
    expect((await other().complete(req())).text).toBe('ok');
  });

  it('gives up with the last refusal when every combination is refused', async () => {
    const w = makeWorld();
    const ai = local(w, { noThinking: true, jsonMode: true });
    const fetch = (w.ctx.fetch = fakeFetch([{ url: /chat/, reply: () => ({ status: 400, json: { error: { message: 'context too long' } } }) }]));
    const e = await failure(ai().complete(classifyRequest([], 'Maybe')));
    expect(e.code).toBe('BAD_REQUEST');
    expect(e.message).toContain('context too long');
    expect(fetch.calls).toHaveLength(4);
    // Nothing was learned, so the next request tries everything again.
    await failure(ai().complete(classifyRequest([], 'Maybe')));
    expect(JSON.parse(fetch.calls[4].body!)).toMatchObject({ reasoning_effort: 'none', response_format: { type: 'json_object' } });
  });

  it('checks the host again before a retry', async () => {
    const w = makeWorld();
    const ai = local(w, { baseUrl: 'https://models.example.com/v1', noThinking: true });
    w.ctx.stripe = {} as any;
    let lookups = 0;
    w.ctx.dns = { ...w.ctx.dns, lookup: async () => (lookups++ === 0 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '169.254.169.254', family: 4 }]) } as any;
    const fetch = (w.ctx.fetch = fakeFetch([{ url: /chat/, reply: () => ({ status: 400, json: { error: { message: 'unknown field' } } }) }]));
    const e = await failure(ai().complete(req()));
    expect(e.message).toMatch(/private or local network/);
    expect(lookups).toBe(2);
    expect(fetch.calls).toHaveLength(1);
  });

  it('does not repeat a refused request when nothing optional was sent, or when the refusal is not a 400', async () => {
    const w = makeWorld();
    let ai = local(w);
    let fetch = (w.ctx.fetch = fakeFetch([{ url: /chat/, reply: () => ({ status: 400, json: { error: { message: 'context too long' } } }) }]));
    const e = await failure(ai().complete(req()));
    expect([e.code, e.status]).toEqual(['BAD_REQUEST', 400]);
    expect(e.message).toContain('context too long');
    expect(fetch.calls).toHaveLength(1);

    const w2 = makeWorld();
    ai = local(w2, { noThinking: true });
    fetch = w2.ctx.fetch = fakeFetch([{ url: /chat/, reply: () => ({ status: 401, json: { error: { message: 'bad key' } } }) }]);
    expect((await failure(ai().complete(req()))).code).toBe('AUTH');
    expect(fetch.calls).toHaveLength(1);
  });

  it('removes a thinking block left in the answer', async () => {
    const w = makeWorld();
    const ai = local(w);
    w.ctx.fetch = fakeFetch([{ url: /chat/, reply: () => answer('<think>\nThe reply says no.\n</think>\n\n{"category":"not_interested","confidence":0.95}') }]);
    expect((await ai().complete(req())).text).toBe('{"category":"not_interested","confidence":0.95}');
  });

  it('explains an empty answer from a model that spent its budget thinking', async () => {
    const w = makeWorld();
    let ai = local(w);
    const empty = (extra: Record<string, unknown>, content: unknown = '') => (w.ctx.fetch = fakeFetch([{ url: /chat/, reply: () => ({ json: { choices: [{ message: { content, ...extra }, finish_reason: 'length' }] } }) }]));
    empty({ reasoning_content: 'Let me think about the categories...' });
    let e = await failure(ai().complete(classifyRequest([], 'Maybe later')));
    expect(e.code).toBe('BAD_REQUEST');
    expect(e.message).toBe('localhost:11434 used the whole token budget thinking and returned no text. Turn on "Turn off model thinking", or use a model that doesn\'t think, such as phi4-mini.');
    empty({ reasoning: 'hmm' }, null);
    expect((await failure(ai().complete(req()))).message).toMatch(/thinking and returned no text/);
    empty({}, '<think>still going');
    expect((await failure(ai().complete(req()))).code).toBe('BAD_REQUEST');
    // Cut off without any thinking: still a budget problem.
    empty({});
    expect((await failure(ai().complete(req()))).message).toMatch(/^localhost:11434 used the whole token budget and returned no text/);

    const w2 = makeWorld();
    ai = local(w2, { noThinking: true });
    w2.ctx.fetch = fakeFetch([{ url: /chat/, reply: () => ({ json: { choices: [{ message: { content: '', reasoning_content: 'x' }, finish_reason: 'length' }] } }) }]);
    expect((await failure(ai().complete(req()))).message).toMatch(/Use a model that doesn't think, such as phi4-mini, or start llama-server with --reasoning-budget 0\.$/);
    // When the server refused the switch, the message says it never took effect.
    w2.ctx.fetch = fakeFetch([{ url: /chat/, reply: (r) => (JSON.parse(r.body!).reasoning_effort ? { status: 400, json: { error: { message: 'unknown field' } } } : { json: { choices: [{ message: { content: '', reasoning_content: 'x' }, finish_reason: 'length' }] } }) }]);
    expect((await failure(ai().complete(req()))).message).toMatch(/This server refused the "Turn off model thinking" parameters, so use a model/);

    // An empty answer for no visible reason is the server's problem (retried).
    w2.ctx.fetch = fakeFetch([{ url: /chat/, reply: () => answer('   ') }]);
    e = await failure(ai().complete(req()));
    expect([e.code, e.message]).toEqual(['UNAVAILABLE', 'localhost:11434 returned no text']);
    w2.ctx.fetch = fakeFetch([{ url: /chat/, reply: () => ({ json: { choices: [] } }) }]);
    expect((await failure(ai().complete(req()))).code).toBe('UNAVAILABLE');
  });
});

describe('OpenAI-compatible provider: timeout', () => {
  // Captures the timeout handed to AbortSignal.timeout and fires it at once; the fake fetch honours the signal.
  function expireAtOnce() {
    const seen: number[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      seen.push(ms);
      return AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    });
    const fetch = (async (_url: any, init: any) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      throw new Error('signal was not aborted');
    }) as typeof globalThis.fetch;
    return { seen, fetch };
  }

  it('keeps 60 seconds by default and says how to fix a slow local model', async () => {
    const w = makeWorld();
    const ai = local(w);
    const t = expireAtOnce();
    w.ctx.fetch = t.fetch;
    const e = await failure(ai().complete(req()));
    expect(t.seen).toEqual([60_000]);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.code).toBe('TIMEOUT');
    expect(e.message).toBe('localhost:11434 did not answer within 60 s. Local models can be slow: raise the request timeout (up to 600 s) or use a smaller model.');
    expect(e.integrationId).toBeGreaterThan(0);
  });

  it('uses the configured timeout for answers but not for the connection test', async () => {
    const w = makeWorld();
    const ai = local(w, { timeoutSeconds: 600 });
    const t = expireAtOnce();
    w.ctx.fetch = t.fetch;
    const e = await failure(ai().complete(req()));
    expect(t.seen).toEqual([600_000]);
    expect(e.message).toBe('localhost:11434 did not answer within 600 s. Use a smaller model.');
    await failure(ai().test());
    expect(t.seen[1]).toBe(10_000);
  });

  it('caps the timeout at 60 seconds on a hosted server', async () => {
    const w = makeWorld();
    const ai = local(w, { baseUrl: 'https://models.example.com/v1', timeoutSeconds: 600 });
    w.ctx.stripe = {} as any;
    w.ctx.dns = { ...w.ctx.dns, lookup: async () => [{ address: '93.184.216.34', family: 4 }] } as any;
    const t = expireAtOnce();
    w.ctx.fetch = t.fetch;
    const e = await failure(ai().complete(req()));
    expect(t.seen).toEqual([60_000]);
    expect(e.message).toBe('models.example.com did not answer within 60 s. Use a smaller model.');
  });
});

describe('OpenAI-compatible provider: errors and connection test', () => {
  it('maps every status to a provider error without leaking the key', async () => {
    const w = makeWorld();
    const ai = local(w, { noThinking: true }, { apiKey: KEY });
    const cases: [number, string, Record<string, string>?][] = [
      [401, 'AUTH'],
      [403, 'AUTH'],
      [402, 'QUOTA'],
      [404, 'NOT_FOUND'],
      [429, 'RATE_LIMIT', { 'retry-after': '3' }],
      [500, 'UNAVAILABLE'],
      [503, 'UNAVAILABLE'],
    ];
    for (const [status, code, headers] of cases) {
      const fetch = (w.ctx.fetch = fakeFetch([{ url: /chat/, reply: () => ({ status, headers, json: { error: { message: `model not loaded for ${KEY}` } } }) }]));
      const e = await failure(ai().complete(req()));
      expect([status, e.code]).toEqual([status, code]);
      expect(e.message).not.toContain(KEY);
      expect(fetch.calls).toHaveLength(1);
      if (status === 429) expect(e.retryAfterMs).toBe(3000);
    }
    w.ctx.fetch = (async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:11434');
    }) as typeof fetch;
    const down = await failure(ai().complete(req()));
    expect([down.code, down.message]).toEqual(['UNAVAILABLE', 'Could not reach localhost:11434']);
  });

  it('checks both model names in the connection test', async () => {
    const w = makeWorld();
    const ai = local(w);
    const models = (ids: string[]) => (w.ctx.fetch = fakeFetch([{ method: 'GET', url: /^http:\/\/localhost:11434\/v1\/models$/, reply: () => ({ json: { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) } }) }]));
    models(['qwen3.5:4b', 'phi4-mini']);
    expect(await ai().test()).toEqual({ ok: true, message: 'Connected to localhost:11434.' });
    // Ollama lists a model pulled without a tag as name:latest.
    models(['qwen3.5:4b', 'phi4-mini:latest']);
    expect(await ai().test()).toEqual({ ok: true, message: 'Connected to localhost:11434.' });
    models(['qwen3.5:4b']);
    expect((await ai().test()).message).toBe('Connected to localhost:11434. "phi4-mini" is not in its model list, so check the name (in Ollama, run ollama pull first).');
    models(['llama3']);
    expect((await ai().test()).message).toMatch(/"qwen3\.5:4b" and "phi4-mini" are not in its model list/);
    // Some servers list nothing (or only the loaded model is served): no warning then.
    models([]);
    expect((await ai().test()).message).toBe('Connected to localhost:11434.');
  });
});

describe('OpenAI-compatible provider: hosts', () => {
  it('allows loopback on self-hosted installs and refuses it once billing is on, before any request', async () => {
    const w = makeWorld();
    const ai = local(w, {}, {});
    const fetch = (w.ctx.fetch = fakeFetch([{ url: /chat/, reply: () => answer('fine') }]));
    expect((await ai().complete(req())).text).toBe('fine');
    for (const baseUrl of ['http://127.0.0.1:9931/v1', 'http://[::1]:1234/v1']) {
      const w2 = makeWorld();
      const other = local(w2, { baseUrl });
      w2.ctx.fetch = fakeFetch([{ url: /chat/, reply: () => answer('fine') }]);
      expect((await other().complete(req())).text, baseUrl).toBe('fine');
    }

    // A hosted installation (billing on) never connects to the server's own network.
    w.ctx.stripe = {} as any;
    w.ctx.dns = { ...w.ctx.dns, lookup: async (h: string) => (h === 'localhost' ? [{ address: '127.0.0.1', family: 4 }] : []) } as any;
    const e = await failure(ai().complete(req()));
    expect(e.code).toBe('BAD_REQUEST');
    expect(e.message).toMatch(/private or local network/);
    expect((await failure(ai().test())).code).toBe('BAD_REQUEST');
    expect(fetch.calls).toHaveLength(1);
  });
});

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError, idParam, notFound, parse, requireAdmin, user } from '../http.js';
import { ProviderError } from '../providers/http.js';
import { PROVIDER_KINDS, providerDef, providerDefs, type ProviderKind } from '../providers/registry.js';
import { createIntegration, integrationCreate, integrationPatch, loadIntegration, serializeIntegration, updateIntegration, type IntegrationRow } from '../providers/store.js';
import { hostProblem, urlHost } from '../services/hosts.js';
import { monthlyUsage, monthOf } from '../services/usage.js';

const TEST_TIMEOUT_MS = 15_000;

export function integrationRoutes(app: FastifyInstance, ctx: Ctx) {
  const load = (req: any): IntegrationRow => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    return loadIntegration(ctx, admin.workspace_id, id) ?? notFound('Integration');
  };

  // Everyone may see which providers exist and which one is in use; only admins see configurations.
  app.get('/api/integrations/providers', async () =>
    providerDefs().map((d) => ({ id: d.id, kind: d.kind, label: d.label, description: d.description, docsUrl: d.docsUrl ?? null, simulated: !!d.simulated, fields: d.fields })),
  );

  app.get('/api/integrations/status', async (req) => ctx.providers.status(user(req).workspace_id));

  app.get('/api/integrations', async (req) => {
    const admin = requireAdmin(req);
    return ctx.db
      .all<IntegrationRow>('SELECT * FROM integrations WHERE workspace_id = ? ORDER BY kind, priority, id', [admin.workspace_id])
      .map((r) => serializeIntegration(ctx, r));
  });

  // Hosted installs: URLs the tenant chose must point at public hosts (the saved ones were checked already).
  const checkHosts = async (kind: ProviderKind, provider: string, settings: Record<string, unknown> | undefined) => {
    for (const key of providerDef(kind, provider)?.hostSettings ?? []) {
      const host = urlHost(settings?.[key]);
      const problem = host && (await hostProblem(ctx, host));
      if (problem) throw new HttpError(400, `settings.${key}: ${problem}`);
    }
  };

  app.post('/api/integrations', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(integrationCreate, req.body);
    await checkHosts(body.kind, body.provider, body.settings);
    return serializeIntegration(ctx, createIntegration(ctx, admin.workspace_id, body));
  });

  app.patch('/api/integrations/:id', async (req) => {
    const row = load(req);
    const patch = parse(integrationPatch, req.body);
    await checkHosts(row.kind, row.provider, patch.settings);
    return serializeIntegration(ctx, updateIntegration(ctx, row, patch));
  });

  app.delete('/api/integrations/:id', async (req) => {
    const row = load(req);
    ctx.db.run('DELETE FROM integrations WHERE id = ? AND workspace_id = ?', [row.id, row.workspace_id]);
    return { ok: true };
  });

  app.post('/api/integrations/:id/test', async (req) => {
    const row = load(req);
    const inst = ctx.providers.instance(row);
    if (!inst) throw new HttpError(409, `Provider "${row.provider}" is no longer available; remove this integration`);
    let out: { ok: boolean; message: string };
    let timer: NodeJS.Timeout | undefined;
    try {
      out = await Promise.race([
        inst.test(),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new ProviderError('TIMEOUT', 'The service did not answer within 15 seconds')), TEST_TIMEOUT_MS))),
      ]);
    } catch (e) {
      // Provider errors are already scrubbed of secrets; anything else gets a generic message.
      out = { ok: false, message: e instanceof ProviderError ? e.message : 'The connection test failed unexpectedly' };
      if (!(e instanceof ProviderError)) console.error(`[integrations] test ${row.kind}/${row.provider} failed`, e);
    } finally {
      clearTimeout(timer);
    }
    ctx.providers.markStatus(row.id, out.ok ? 'ok' : 'error', out.message);
    return { ok: out.ok, message: out.message };
  });

  // Order within a kind decides which provider is used first (and the waterfall order).
  app.put('/api/integrations/order', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(z.object({ kind: z.enum(PROVIDER_KINDS), ids: z.array(z.number().int().positive()).min(1).max(100) }), req.body);
    const owned = ctx.db.all<{ id: number }>('SELECT id FROM integrations WHERE workspace_id = ? AND kind = ?', [admin.workspace_id, body.kind]).map((r) => r.id);
    if (new Set(body.ids).size !== body.ids.length || body.ids.length !== owned.length || body.ids.some((id) => !owned.includes(id))) {
      throw new HttpError(400, `ids must list every ${body.kind} integration of this workspace exactly once`);
    }
    ctx.db.tx(() => body.ids.forEach((id, i) => ctx.db.run('UPDATE integrations SET priority = ? WHERE id = ? AND workspace_id = ?', [i, id, admin.workspace_id])));
    return { ok: true };
  });

  app.get('/api/usage', async (req) => {
    const admin = requireAdmin(req);
    const q = parse(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM').optional() }), req.query);
    const month = q.month ?? monthOf(ctx.clock.now());
    return { month, rows: monthlyUsage(ctx, admin.workspace_id, month) };
  });
}

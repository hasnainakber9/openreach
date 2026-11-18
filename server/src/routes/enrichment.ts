import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError, idParam, notFound, parse, requireAdmin, requireWriter, user } from '../http.js';
import { enrichmentSettings, EnrichmentSettingsSchema, enrichSingleLead, MAX_RUN_LEADS, serializeRun, startEnrichmentRun } from '../services/enrichment.js';
import { setSetting } from '../services/settings.js';
import type { EnrichmentRunRow } from '../types.js';

// What a lookup does. Overwrite lets finders replace addresses people entered (CSV, typed in, LinkedIn).
const options = z.object({
  find: z.boolean().default(true),
  verify: z.boolean().default(true),
  company: z.boolean().default(false),
  overwrite: z.boolean().default(false),
});
const someWork = (o: z.infer<typeof options>) => o.find || o.verify || o.company;
const NOTHING = 'Choose at least one of find, verify or company data';

export function enrichmentRoutes(app: FastifyInstance, ctx: Ctx) {
  // Bulk "Find & verify emails" on selected leads or a whole list.
  app.post('/api/leads/enrich', async (req) => {
    const me = requireWriter(req);
    const body = parse(
      options
        .extend({ leadIds: z.array(z.number().int().positive()).min(1).max(MAX_RUN_LEADS).optional(), listId: z.number().int().positive().optional() })
        .refine((b) => !!b.leadIds !== (b.listId != null), 'Send either leadIds or listId')
        .refine(someWork, NOTHING),
      req.body,
    );
    let ids: number[];
    if (body.listId != null) {
      ctx.db.get('SELECT 1 FROM lead_lists WHERE id = ? AND workspace_id = ?', [body.listId, me.workspace_id]) ?? notFound('List');
      ids = ctx.db.all<{ id: number }>(`SELECT id FROM leads WHERE list_id = ? AND workspace_id = ? ORDER BY id LIMIT ${MAX_RUN_LEADS + 1}`, [body.listId, me.workspace_id]).map((r) => r.id);
      if (ids.length > MAX_RUN_LEADS) throw new HttpError(400, `A run can look up at most ${MAX_RUN_LEADS.toLocaleString('en')} leads; select fewer`);
    } else {
      // Ids from another workspace are silently left out, like every bulk action.
      const asked = [...new Set(body.leadIds!)];
      ids = [];
      for (let i = 0; i < asked.length; i += 500) {
        const chunk = asked.slice(i, i + 500);
        ids.push(...ctx.db.all<{ id: number }>(`SELECT id FROM leads WHERE workspace_id = ? AND id IN (${chunk.map(() => '?').join(',')})`, [me.workspace_id, ...chunk]).map((r) => r.id));
      }
    }
    const { find, verify, company, overwrite } = body;
    return startEnrichmentRun(ctx, me.workspace_id, me.id, ids, { find, verify, company, overwrite });
  });

  app.post('/api/leads/:id/enrich', async (req) => {
    const me = requireWriter(req);
    const { id } = parse(idParam, req.params);
    ctx.db.get('SELECT 1 FROM leads WHERE id = ? AND workspace_id = ?', [id, me.workspace_id]) ?? notFound('Lead');
    const o = parse(options.refine(someWork, NOTHING), req.body ?? {});
    return { jobId: enrichSingleLead(ctx, me.workspace_id, id, o) };
  });

  app.get('/api/enrichment/runs', async (req) => {
    const rows = ctx.db.all<EnrichmentRunRow>('SELECT * FROM enrichment_runs WHERE workspace_id = ? ORDER BY id DESC LIMIT 10', [user(req).workspace_id]);
    return rows.map(serializeRun);
  });

  app.get('/api/enrichment/runs/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const row = ctx.db.get<EnrichmentRunRow>('SELECT * FROM enrichment_runs WHERE id = ? AND workspace_id = ?', [id, user(req).workspace_id]) ?? notFound('Enrichment run');
    return serializeRun(row);
  });

  app.get('/api/settings/enrichment', async (req) => enrichmentSettings(ctx, user(req).workspace_id));

  // Partial updates merge into the saved settings.
  app.put('/api/settings/enrichment', async (req) => {
    const admin = requireAdmin(req);
    const patch = parse(
      z
        .object({ verifyFound: z.boolean(), acceptRisky: z.boolean(), trustFinderStatus: z.boolean(), autoEnrichOnImport: z.boolean(), enrichCompany: z.boolean() })
        .partial()
        .strict(),
      req.body,
    );
    return setSetting(ctx, admin.workspace_id, 'enrichment', EnrichmentSettingsSchema, { ...enrichmentSettings(ctx, admin.workspace_id), ...patch });
  });
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError, idParam, notFound, parse, requireAdmin, requireOwner, user } from '../http.js';
import { BrandingInput, brandingSettings, customDomainProblem, DEFAULT_BRANDING, resolveBranding, saveBranding, workspaceForHost } from '../services/branding.js';
import { agencyOf, directRole, listWorkspaces, resolveSession, roleIn, workspaceRow, type WorkspaceRow } from '../services/memberships.js';
import { agencyOverview, clientsOf, createClientWorkspace, deleteWorkspace } from '../services/workspaces.js';
import { meOf, SESSION_COOKIE } from './auth.js';

const clientName = z.string().trim().min(1, 'Enter a name').max(100);

export function agencyRoutes(app: FastifyInstance, ctx: Ctx) {
  // ---- Workspaces the user can reach, and switching between them ----

  app.get('/api/workspaces', async (req) => {
    const u = user(req);
    return listWorkspaces(ctx, u.id).map((w) => ({ ...w, active: w.id === u.workspace_id }));
  });

  app.post('/api/workspaces/switch', async (req) => {
    const u = user(req);
    const { workspaceId } = parse(z.object({ workspaceId: z.number().int().positive() }), req.body);
    if (!roleIn(ctx, u.id, workspaceId)) notFound('Workspace');
    const home = ctx.db.get<{ workspace_id: number }>('SELECT workspace_id FROM users WHERE id = ?', [u.id])!.workspace_id;
    const t = req.cookies[SESSION_COOKIE]!;
    ctx.db.run('UPDATE sessions SET workspace_id = ? WHERE token = ?', [workspaceId === home ? null : workspaceId, t]);
    return meOf(ctx, resolveSession(ctx, t)!);
  });

  // ---- Agency mode ----

  app.post('/api/agency/enable', async (req) => {
    const u = requireOwner(req);
    const w = workspaceRow(ctx, u.workspace_id)!;
    if (w.kind === 'client') throw new HttpError(409, "A client workspace can't become an agency");
    if (w.kind !== 'agency') ctx.db.run("UPDATE workspaces SET kind = 'agency' WHERE id = ?", [w.id]);
    return meOf(ctx, u);
  });

  // The agency the request acts for (the active workspace or a client's parent); its admins only.
  const requireAgency = (req: FastifyRequest, ownerOnly = false) => {
    const u = user(req);
    const agency = agencyOf(ctx, u);
    if (!agency) {
      const w = workspaceRow(ctx, u.workspace_id);
      const parent = w?.parent_id ? workspaceRow(ctx, w.parent_id) : undefined;
      if (w?.kind === 'agency' || parent?.kind === 'agency') throw new HttpError(403, 'Only agency admins can do this');
      throw new HttpError(409, 'Turn on agency mode first (Settings, Team tab)');
    }
    if (ownerOnly && directRole(ctx, u.id, agency.id) !== 'owner') throw new HttpError(403, 'Only the agency owner can do this');
    return agency;
  };
  const loadClient = (agencyId: number, req: FastifyRequest) => {
    const { id } = parse(idParam, req.params);
    return ctx.db.get<{ id: number; name: string }>("SELECT id, name FROM workspaces WHERE id = ? AND parent_id = ? AND kind = 'client'", [id, agencyId]) ?? notFound('Client');
  };

  app.get('/api/agency/clients', async (req) => {
    const agency = requireAgency(req);
    return clientsOf(ctx, agency.id).map((c) => ({ id: c.id, name: c.name, createdAt: c.created_at }));
  });

  app.post('/api/agency/clients', async (req) => {
    const agency = requireAgency(req);
    const { name } = parse(z.object({ name: clientName }), req.body);
    return { id: createClientWorkspace(ctx, agency.id, name) };
  });

  app.patch('/api/agency/clients/:id', async (req) => {
    const agency = requireAgency(req, true);
    const c = loadClient(agency.id, req);
    const { name } = parse(z.object({ name: clientName }), req.body);
    ctx.db.run('UPDATE workspaces SET name = ? WHERE id = ?', [name, c.id]);
    return { ok: true };
  });

  // Deletes the client workspace and all its data; the body repeats its name so it can't happen by accident.
  app.delete('/api/agency/clients/:id', async (req) => {
    const agency = requireAgency(req, true);
    const c = loadClient(agency.id, req);
    const { confirm } = parse(z.object({ confirm: z.string().trim().max(200).default('') }), req.body);
    if (confirm !== c.name.trim()) throw new HttpError(400, `Type the client's name (${c.name}) to confirm`);
    await deleteWorkspace(ctx, c.id);
    return { ok: true };
  });

  app.get('/api/agency/overview', async (req) => {
    const agency = requireAgency(req);
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    return { agency: { id: agency.id, name: agency.name }, days, clients: agencyOverview(ctx, agency.id, days) };
  });

  // ---- White-label: the agency's branding, or a client's overrides of it ----

  const brandingWorkspace = (req: FastifyRequest) => {
    const u = requireAdmin(req);
    const w = workspaceRow(ctx, u.workspace_id)!;
    if (w.kind === 'standard') throw new HttpError(409, 'Turn on agency mode first (Settings, Team tab)');
    return { u, w };
  };
  // A domain changes what the sign-in page shows for everyone on it, so only the agency's owner picks it
  // (for the agency and for each client), not a client workspace's own admins.
  const canEditDomain = (userId: number, w: WorkspaceRow) => {
    const agencyId = w.kind === 'agency' ? w.id : w.parent_id;
    return !!agencyId && directRole(ctx, userId, agencyId) === 'owner';
  };
  const settingsFor = (userId: number, w: WorkspaceRow) => ({ ...brandingSettings(ctx, w.id), canEditDomain: canEditDomain(userId, w) });

  app.get('/api/agency/branding', async (req) => {
    const { u, w } = brandingWorkspace(req);
    return settingsFor(u.id, w);
  });

  app.put('/api/agency/branding', async (req) => {
    const { u, w } = brandingWorkspace(req);
    const body = parse(BrandingInput, req.body);
    const domain = body.customDomain === undefined ? undefined : body.customDomain || null;
    if (domain !== undefined && domain !== brandingSettings(ctx, w.id).customDomain) {
      if (!canEditDomain(u.id, w)) throw new HttpError(403, 'Only the agency owner can change the custom domain');
      const problem = domain && customDomainProblem(ctx, domain, req.host);
      if (problem) throw new HttpError(400, problem);
    }
    if (saveBranding(ctx, w.id, body) === 'domain_taken') throw new HttpError(409, 'Another workspace already uses that domain');
    return settingsFor(u.id, w);
  });

  // An agency and its clients share a family (the agency's id).
  const familyOf = (ws: number) => {
    const w = workspaceRow(ctx, ws);
    return w?.kind === 'client' && w.parent_id ? w.parent_id : ws;
  };

  // Public (sign-in page): the branding of the custom domain this request came in on, else of the
  // signed-in user's workspace, else the defaults. Only the Host is used here, never for links.
  // A signed-in user from another agency keeps their own branding even on someone else's domain.
  app.get('/api/branding', async (req) => {
    const byHost = workspaceForHost(ctx, req.host);
    const u = resolveSession(ctx, req.cookies[SESSION_COOKIE]);
    if (byHost && (!u || familyOf(u.workspace_id) === familyOf(byHost))) return { ...resolveBranding(ctx, byHost), source: 'domain' };
    if (u) return { ...resolveBranding(ctx, u.workspace_id), source: 'workspace' };
    return { ...DEFAULT_BRANDING, source: 'default' };
  });
}

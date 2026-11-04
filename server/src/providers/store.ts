import { z } from 'zod';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { HttpError } from '../http.js';
import { mask } from '../services/crypto.js';
import { PROVIDER_KINDS, providerDef, SIMULATED_FALLBACK, type KindInstance, type ProviderDef, type ProviderKind } from './registry.js';

export interface IntegrationRow {
  id: number;
  workspace_id: number;
  kind: ProviderKind;
  provider: string;
  label: string;
  credentials_enc: string | null;
  settings: string;
  enabled: number;
  priority: number;
  last_status: 'ok' | 'error' | null;
  last_message: string | null;
  last_checked_at: number | null;
  created_at: number;
  updated_at: number;
}

type Secrets = Record<string, string>;

export function integrationCredentials(ctx: Ctx, row: Pick<IntegrationRow, 'credentials_enc'>): Secrets {
  return json<Secrets>(ctx.sealer.open(row.credentials_enc), {});
}

function sealCredentials(ctx: Ctx, creds: Secrets): string | null {
  const kept = Object.fromEntries(Object.entries(creds).filter(([, v]) => typeof v === 'string' && v !== ''));
  return Object.keys(kept).length ? ctx.sealer.seal(JSON.stringify(kept)) : null;
}

// Settings saved under an older def may no longer parse; fall back to the def's defaults rather than failing.
function parseSettings(def: ProviderDef, raw: string) {
  const r = def.settings.safeParse(json(raw, {}));
  return r.success ? r.data : def.settings.safeParse({}).data ?? {};
}

// API shape. Secrets only ever leave as masks.
export function serializeIntegration(ctx: Ctx, row: IntegrationRow) {
  const def = providerDef(row.kind, row.provider);
  const creds = integrationCredentials(ctx, row);
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    providerLabel: def?.label ?? row.provider,
    simulated: !!def?.simulated,
    label: row.label,
    enabled: !!row.enabled,
    priority: row.priority,
    settings: json<Record<string, unknown>>(row.settings, {}),
    credentials: Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, mask(v)])),
    hasCredentials: Object.keys(creds).length > 0,
    lastStatus: row.last_status,
    lastMessage: row.last_message,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const secretInput = z.record(z.string().max(4000).nullable());

export const integrationCreate = z.object({
  kind: z.enum(PROVIDER_KINDS),
  provider: z.string().min(1).max(60),
  label: z.string().trim().max(100).optional(),
  enabled: z.boolean().optional(),
  settings: z.record(z.unknown()).optional(),
  credentials: secretInput.optional(),
});

export const integrationPatch = z.object({
  label: z.string().trim().max(100).optional(),
  enabled: z.boolean().optional(),
  settings: z.record(z.unknown()).optional(),
  credentials: secretInput.optional(),
});

function zodMessage(e: z.ZodError, prefix: string) {
  const first = e.issues[0];
  return `${prefix}.${first.path.join('.') || 'value'}: ${first.message}`;
}

// A null setting means "back to the default", so it is dropped before validation.
const withoutNulls = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));

function validated(def: ProviderDef, settings: Record<string, unknown>, creds: Secrets) {
  const s = def.settings.safeParse(withoutNulls(settings));
  if (!s.success) throw new HttpError(400, zodMessage(s.error, 'settings'), s.error.issues);
  const c = def.credentials.safeParse(creds);
  if (!c.success) throw new HttpError(400, zodMessage(c.error, 'credentials'), c.error.issues);
  return { settings: s.data, credentials: c.data as Secrets };
}

export function loadIntegration(ctx: Ctx, workspaceId: number, id: number): IntegrationRow | undefined {
  return ctx.db.get<IntegrationRow>('SELECT * FROM integrations WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
}

export function createIntegration(ctx: Ctx, workspaceId: number, input: z.infer<typeof integrationCreate>): IntegrationRow {
  const def = providerDef(input.kind, input.provider);
  if (!def) throw new HttpError(400, `Unknown provider "${input.provider}" for ${input.kind}`);
  // Blank and null secrets mean "not given" on create.
  const given = Object.fromEntries(Object.entries(input.credentials ?? {}).filter((e): e is [string, string] => !!e[1]));
  const { settings, credentials } = validated(def, input.settings ?? {}, given);
  if (ctx.db.get('SELECT 1 FROM integrations WHERE workspace_id = ? AND kind = ? AND provider = ?', [workspaceId, input.kind, input.provider])) {
    throw new HttpError(409, `${def.label} is already set up for this workspace`);
  }
  const now = ctx.clock.now();
  const priority = ctx.db.get<{ p: number | null }>('SELECT MAX(priority) AS p FROM integrations WHERE workspace_id = ? AND kind = ?', [workspaceId, input.kind])?.p;
  const id = ctx.db.insert('integrations', {
    workspace_id: workspaceId,
    kind: input.kind,
    provider: input.provider,
    label: input.label || def.label,
    credentials_enc: sealCredentials(ctx, credentials),
    settings: JSON.stringify(settings),
    enabled: input.enabled === false ? 0 : 1,
    priority: priority == null ? 0 : priority + 1,
    created_at: now,
    updated_at: now,
  });
  return loadIntegration(ctx, workspaceId, id)!;
}

// Omitted or '' secrets keep the saved value; null clears it. Settings merge into the saved ones.
export function updateIntegration(ctx: Ctx, row: IntegrationRow, patch: z.infer<typeof integrationPatch>): IntegrationRow {
  const def = providerDef(row.kind, row.provider);
  if (!def) throw new HttpError(409, `Provider "${row.provider}" is no longer available; remove this integration`);
  const creds = integrationCredentials(ctx, row);
  for (const [k, v] of Object.entries(patch.credentials ?? {})) {
    if (v === null) delete creds[k];
    else if (v !== '') creds[k] = v;
  }
  const { settings, credentials } = validated(def, { ...json<Record<string, unknown>>(row.settings, {}), ...patch.settings }, creds);
  const cols: Record<string, string | number | null> = { settings: JSON.stringify(settings), credentials_enc: sealCredentials(ctx, credentials), updated_at: ctx.clock.now() };
  if (patch.label !== undefined) cols.label = patch.label || def.label;
  if (patch.enabled !== undefined) cols.enabled = patch.enabled ? 1 : 0;
  // New credentials or settings make the old test result meaningless.
  if (patch.credentials || patch.settings) Object.assign(cols, { last_status: null, last_message: null, last_checked_at: null });
  ctx.db.update('integrations', row.id, cols);
  return loadIntegration(ctx, row.workspace_id, row.id)!;
}

export interface KindStatus {
  provider: string | null;
  label: string;
  simulated: boolean;
  integrationId: number | null;
}

// Picks which provider instance serves a workspace for each kind.
export class ProviderResolver {
  constructor(private ctx: Ctx) {}

  private rows(workspaceId: number, kind: ProviderKind) {
    return this.ctx.db.all<IntegrationRow>('SELECT * FROM integrations WHERE workspace_id = ? AND kind = ? AND enabled = 1 ORDER BY priority, id', [workspaceId, kind]);
  }

  instance<K extends ProviderKind>(row: IntegrationRow): KindInstance<K> | null {
    const def = providerDef(row.kind, row.provider);
    if (!def) return null;
    return def.create(this.ctx, { integrationId: row.id, workspaceId: row.workspace_id, credentials: integrationCredentials(this.ctx, row), settings: parseSettings(def, row.settings) }) as KindInstance<K>;
  }

  simulated<K extends ProviderKind>(workspaceId: number, kind: K): KindInstance<K> | null {
    const def = providerDef(kind, 'simulated');
    if (!def) return null;
    return def.create(this.ctx, { integrationId: null, workspaceId, credentials: {}, settings: def.settings.safeParse({}).data ?? {} });
  }

  // First enabled integration by priority, else the simulator (never for crm).
  get<K extends ProviderKind>(workspaceId: number, kind: K): KindInstance<K> | null {
    for (const row of this.rows(workspaceId, kind)) {
      const inst = this.instance<K>(row);
      if (inst) return inst;
    }
    return SIMULATED_FALLBACK[kind] ? this.simulated(workspaceId, kind) : null;
  }

  // Every enabled integration in priority order (for waterfalls), or [simulator] when none.
  list<K extends ProviderKind>(workspaceId: number, kind: K): KindInstance<K>[] {
    const out = this.rows(workspaceId, kind)
      .map((r) => this.instance<K>(r))
      .filter((i): i is KindInstance<K> => !!i);
    if (out.length || !SIMULATED_FALLBACK[kind]) return out;
    const sim = this.simulated(workspaceId, kind);
    return sim ? [sim] : [];
  }

  status(workspaceId: number): Record<ProviderKind, KindStatus> {
    const out = {} as Record<ProviderKind, KindStatus>;
    for (const kind of PROVIDER_KINDS) {
      const row = this.rows(workspaceId, kind).find((r) => providerDef(r.kind, r.provider));
      const def = row ? providerDef(kind, row.provider) : SIMULATED_FALLBACK[kind] ? providerDef(kind, 'simulated') : undefined;
      out[kind] = def
        ? { provider: def.id, label: row?.label || def.label, simulated: !!def.simulated, integrationId: row?.id ?? null }
        : { provider: null, label: 'Not connected', simulated: false, integrationId: null };
    }
    return out;
  }

  // Background failures (bad key, no credits) show on the integration card.
  markStatus(integrationId: number, status: 'ok' | 'error', message: string) {
    this.ctx.db.run('UPDATE integrations SET last_status = ?, last_message = ?, last_checked_at = ? WHERE id = ?', [status, message.slice(0, 300), this.ctx.clock.now(), integrationId]);
  }
}

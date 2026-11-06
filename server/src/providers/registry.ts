import type { z } from 'zod';
import type { Ctx } from '../context.js';
import type { AiProvider } from './ai/types.js';
import type { CrmProvider } from './crm/types.js';
import type { EmailFinder, EmailVerifier, Enricher } from './data/types.js';
import type { SmsProvider } from './sms/types.js';

// A kind is one capability with one interface. Mailboxes and billing are not workspace integrations.
export const PROVIDER_KINDS = ['ai', 'email_finder', 'email_verifier', 'enrichment', 'crm', 'sms'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ProviderKinds {
  ai: AiProvider;
  email_finder: EmailFinder;
  email_verifier: EmailVerifier;
  enrichment: Enricher;
  crm: CrmProvider;
  sms: SmsProvider;
}
export type KindInstance<K extends ProviderKind> = ProviderKinds[K];

// Kinds that fall back to the built-in simulator when nothing is configured. CRM never does:
// syncing every workspace into a fake CRM would only churn jobs.
export const SIMULATED_FALLBACK: Record<ProviderKind, boolean> = { ai: true, email_finder: true, email_verifier: true, enrichment: true, crm: false, sms: true };

export interface BaseProvider {
  readonly providerId: string;
  readonly simulated: boolean;
  // A real provider that costs nothing per call (the Company website enricher): it uses no plan credits.
  readonly free?: boolean;
  test(): Promise<{ ok: boolean; message: string }>;
}

// Drives the generic config form in the UI.
export interface FieldSpec {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'number' | 'select' | 'textarea' | 'toggle';
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

export interface ProviderConfig {
  integrationId: number | null;
  workspaceId: number;
  credentials: any;
  settings: any;
}

export interface ProviderDef<K extends ProviderKind = ProviderKind> {
  id: string;
  kind: K;
  label: string;
  description: string;
  docsUrl?: string;
  simulated?: boolean;
  fields: FieldSpec[];
  credentials: z.ZodTypeAny; // secret fields only (sealed at rest)
  settings: z.ZodTypeAny; // non-secret fields
  // Settings that pick which vendor account the credentials talk to (with the credentials themselves,
  // changing one means "another account": ids saved from the old one are dropped).
  accountSettings?: string[];
  // Settings holding a URL the tenant chose; on a hosted installation their hosts must be public (services/hosts.ts).
  hostSettings?: string[];
  // CRMs: a vendor-specific line under the field mapping (how its property names look).
  mappingHelp?: string;
  create(ctx: Ctx, cfg: ProviderConfig): KindInstance<K>;
}

const defs = new Map<string, ProviderDef<any>>();
const key = (kind: string, id: string) => `${kind}:${id}`;

// One def per (kind, id): `simulated` exists for every kind, and a vendor such as Apollo may serve two kinds.
export function registerProvider<K extends ProviderKind>(def: ProviderDef<K>) {
  defs.set(key(def.kind, def.id), def);
}

export function unregisterProvider(kind: ProviderKind, id: string) {
  defs.delete(key(kind, id));
}

export function providerDef<K extends ProviderKind>(kind: K, id: string): ProviderDef<K> | undefined {
  return defs.get(key(kind, id));
}

export function providerDefs(kind?: ProviderKind): ProviderDef[] {
  const all = [...defs.values()].filter((d) => !kind || d.kind === kind);
  // Simulated first, then vendors by name, so lists read the same everywhere.
  return all.sort((a, b) => PROVIDER_KINDS.indexOf(a.kind) - PROVIDER_KINDS.indexOf(b.kind) || Number(!!b.simulated) - Number(!!a.simulated) || a.label.localeCompare(b.label));
}

export function isProviderKind(v: string): v is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(v);
}

// What every simulated provider's "Test connection" answers.
export const SIMULATOR_TEST = { ok: true, message: 'Built-in simulator: works offline and never contacts anyone.' };

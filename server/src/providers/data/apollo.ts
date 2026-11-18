import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { httpJson, ProviderError, RateLimiter } from '../http.js';
import type { ProviderConfig, ProviderDef } from '../registry.js';
import type { EmailFinder, EmailStatus, Enricher, EnrichResult, LeadFields } from './types.js';

// Apollo.io People Enrichment (https://docs.apollo.io/reference/people-enrichment)
//   Match: POST https://api.apollo.io/api/v1/people/match (header x-api-key; first_name, last_name,
//          organization_name, domain, linkedin_url) → person.email, person.email_status, person.title, person.organization{...}
//   Test:  GET  https://api.apollo.io/api/v1/auth/health → { is_logged_in }
// Uses the customer's own key and plan (matches spend Apollo credits). Follows Apollo's public docs;
// tested only against fakes, never against the live API.

const API = 'https://api.apollo.io/api/v1';
const limiter = new RateLimiter(2);

const credentials = z.object({ apiKey: z.string().trim().min(10).max(200) });
const fields = [{ key: 'apiKey', label: 'API key', type: 'password' as const, secret: true, required: true, help: 'Apollo → Settings → Integrations → API keys. The key needs access to People Enrichment.' }];

// Apollo marks addresses it checked as "verified"; everything else (guessed, unavailable, ...) is unconfirmed.
export function apolloStatus(s: string | null | undefined): EmailStatus {
  return s === 'verified' ? 'valid' : 'unknown';
}

// Apollo puts a placeholder in `email` when the address exists but wasn't revealed on this plan.
const realEmail = (e: unknown) => (typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !/^email_not_unlocked@/i.test(e) ? e.trim().toLowerCase() : null);

interface ApolloPerson {
  email?: string | null;
  email_status?: string | null;
  first_name?: string;
  last_name?: string;
  title?: string;
  headline?: string;
  city?: string;
  state?: string;
  country?: string;
  seniority?: string;
  organization?: {
    name?: string;
    website_url?: string;
    primary_domain?: string;
    estimated_num_employees?: number;
    industry?: string;
    linkedin_url?: string;
    founded_year?: number;
  } | null;
}

function client(ctx: Ctx, cfg: ProviderConfig) {
  const key: string = cfg.credentials.apiKey ?? '';
  const call = <T>(path: string, body?: unknown) => {
    if (!key) throw new ProviderError('AUTH', 'Add the Apollo API key', { integrationId: cfg.integrationId });
    return httpJson<T>(ctx, `${API}${path}`, { method: body ? 'POST' : 'GET', body, headers: { 'x-api-key': key, 'cache-control': 'no-cache' }, secrets: [key], integrationId: cfg.integrationId, limiter, timeoutMs: 20_000 });
  };
  const match = async (p: { firstName: string; lastName: string; company: string; domain?: string; profileUrl: string }): Promise<ApolloPerson | null> => {
    const body: Record<string, unknown> = { first_name: p.firstName || undefined, last_name: p.lastName || undefined, organization_name: p.company || undefined, linkedin_url: p.profileUrl || undefined };
    if (p.domain) body.domain = p.domain;
    try {
      const r = await call<{ person?: ApolloPerson | null }>('/people/match', body);
      return r?.person ?? null;
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return null;
      throw e;
    }
  };
  const test = async () => {
    const r = await call<{ is_logged_in?: boolean; healthy?: boolean }>('/auth/health');
    return r?.is_logged_in === false ? { ok: false, message: 'Apollo did not accept the API key' } : { ok: true, message: 'Connected to Apollo' };
  };
  return { match, test };
}

export function apolloEnrichment(person: ApolloPerson): EnrichResult {
  const org = person.organization ?? {};
  const location = [person.city, person.state, person.country].filter(Boolean).join(', ');
  const f: Partial<LeadFields> = {};
  if (person.first_name) f.firstName = person.first_name;
  if (person.last_name) f.lastName = person.last_name;
  if (person.title) f.title = person.title;
  if (person.headline) f.headline = person.headline;
  if (org.name) f.company = org.name;
  if (location) f.location = location;
  const enrichment = Object.fromEntries(
    Object.entries({ companySize: org.estimated_num_employees, industry: org.industry, website: org.website_url, companyLinkedin: org.linkedin_url, foundedYear: org.founded_year, seniority: person.seniority }).filter(([, v]) => v != null && v !== ''),
  );
  return { fields: f, companyDomain: org.primary_domain?.toLowerCase() || undefined, enrichment, credits: 1 };
}

export const apolloFinder: ProviderDef<'email_finder'> = {
  id: 'apollo',
  kind: 'email_finder',
  label: 'Apollo',
  description: 'Finds work emails by matching the person (name, company, LinkedIn URL) in Apollo’s database, with your own Apollo key.',
  docsUrl: 'https://docs.apollo.io/reference/people-enrichment',
  fields,
  credentials,
  settings: z.object({}),
  create(ctx, cfg): EmailFinder {
    const { match, test } = client(ctx, cfg);
    return {
      providerId: 'apollo',
      simulated: false,
      test,
      async find(p) {
        const person = await match(p);
        const email = realEmail(person?.email);
        if (!email) return null;
        const status = apolloStatus(person?.email_status);
        return { email, status, reason: status === 'valid' ? 'Apollo: verified' : `Apollo: ${person?.email_status ?? 'not verified'}`, credits: 1 };
      },
    };
  },
};

export const apolloEnricher: ProviderDef<'enrichment'> = {
  id: 'apollo',
  kind: 'enrichment',
  label: 'Apollo',
  description: 'Adds title, location, company domain, size, industry and website from Apollo, with your own Apollo key.',
  docsUrl: 'https://docs.apollo.io/reference/people-enrichment',
  fields,
  credentials,
  settings: z.object({}),
  create(ctx, cfg): Enricher {
    const { match, test } = client(ctx, cfg);
    return {
      providerId: 'apollo',
      simulated: false,
      test,
      async enrich(lead) {
        const person = await match(lead);
        return person ? apolloEnrichment(person) : null;
      },
    };
  },
};

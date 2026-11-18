import { z } from 'zod';
import { isReservedAddress } from '../../mail/mailboxes.js';
import { hashUnit, pick, slug } from '../hash.js';
import { SIMULATOR_TEST, type ProviderDef } from '../registry.js';
import type { EmailFinder, EmailStatus, EmailVerifier, Enricher } from './types.js';

const base = {
  id: 'simulated',
  label: 'Built-in simulator',
  simulated: true,
  fields: [],
  credentials: z.object({}),
  settings: z.object({}),
};

const instance = { providerId: 'simulated', simulated: true, test: async () => SIMULATOR_TEST };

// Simulated addresses always use a reserved .example domain, so they can never reach a real inbox.
const exampleDomain = (company: string) => `${slug(company) || 'company'}.example`;

export const simulatedFinder: ProviderDef<'email_finder'> = {
  ...base,
  kind: 'email_finder',
  description: 'Finds an address for about 60% of leads, always at a made-up .example domain. Works offline.',
  create(): EmailFinder {
    return {
      ...instance,
      async find(p) {
        if (!p.firstName || hashUnit('find', p.profileUrl) >= 0.6) return null;
        const local = [slug(p.firstName), slug(p.lastName)].filter(Boolean).join('.');
        return { email: `${local}@${exampleDomain(p.company)}`, confidence: 50 + Math.floor(hashUnit('conf', p.profileUrl) * 50) };
      },
    };
  },
};

export const simulatedVerifier: ProviderDef<'email_verifier'> = {
  ...base,
  kind: 'email_verifier',
  description: 'Marks about 70% of made-up (.example) addresses valid, 20% risky and 10% invalid. Real addresses stay unknown. Works offline.',
  create(): EmailVerifier {
    return {
      ...instance,
      async verify(email) {
        // A made-up verdict on a real address would look like a real check, so only test addresses get one.
        if (!isReservedAddress(email)) return { status: 'unknown', reason: 'Not checked: connect an email verifier to check real addresses' };
        const r = hashUnit('verify', email.toLowerCase());
        const status: EmailStatus = r < 0.7 ? 'valid' : r < 0.9 ? 'risky' : 'invalid';
        return { status, reason: status === 'valid' ? 'Simulated: mailbox exists' : status === 'risky' ? 'Simulated: accept-all domain' : 'Simulated: mailbox not found' };
      },
    };
  },
};

const SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'];
const INDUSTRIES = ['Software', 'Financial services', 'Healthcare', 'Manufacturing', 'Retail', 'Education', 'Marketing'];
const LOCATIONS = ['London, UK', 'Berlin, Germany', 'New York, US', 'Toronto, Canada', 'Austin, US', 'Remote'];

export const simulatedEnricher: ProviderDef<'enrichment'> = {
  ...base,
  kind: 'enrichment',
  description: 'Adds made-up company size, industry and location. Works offline.',
  create(): Enricher {
    return {
      ...instance,
      async enrich(lead) {
        if (!lead.company) return null;
        return {
          fields: { location: pick(LOCATIONS, 'loc', lead.profileUrl) },
          companyDomain: exampleDomain(lead.company),
          enrichment: { companySize: pick(SIZES, 'size', lead.company), industry: pick(INDUSTRIES, 'ind', lead.company), simulated: true },
        };
      },
    };
  },
};

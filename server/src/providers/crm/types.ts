import { z } from 'zod';
import type { BaseProvider } from '../registry.js';

export interface CrmContact {
  email: string | null;
  firstName: string;
  lastName: string;
  company: string;
  title: string;
  phone: string | null;
  profileUrl: string;
  // Added by g5-crm (optional so older callers still compile).
  fullName?: string;
  headline?: string;
  location?: string;
  companyDomain?: string | null;
  stage?: string | null;
}

// Our field name → the CRM's property name. An empty property means "don't sync this field".
export type CrmFieldMapping = Record<string, string>;

export interface CrmProvider extends BaseProvider {
  upsertContact(c: CrmContact, mapping: CrmFieldMapping, existingId?: string | null): Promise<{ id: string; created: boolean }>;
  addNote(contactId: string, note: { body: string; timestamp: number }): Promise<{ id: string }>;
  createDeal(contactId: string, deal: { name: string; stage?: string }): Promise<{ id: string }>;
  // A link to the record in the CRM's web app, when the address is known without another API call.
  recordUrl?(objectType: 'contact' | 'deal', id: string): string | null;
}

// Fields of ours that can be mapped to CRM properties, in display order.
export const CRM_FIELDS = ['firstName', 'lastName', 'fullName', 'email', 'phone', 'company', 'title', 'headline', 'location', 'profileUrl', 'companyDomain', 'stage'] as const;
export type CrmField = (typeof CRM_FIELDS)[number];

export function crmFieldValue(c: CrmContact, field: string): string {
  switch (field as CrmField) {
    case 'fullName':
      return c.fullName ?? `${c.firstName} ${c.lastName}`.trim();
    case 'email':
      return c.email ?? '';
    case 'phone':
      return c.phone ?? '';
    case 'companyDomain':
      return c.companyDomain ?? '';
    case 'stage':
      return c.stage ?? '';
    case 'firstName':
    case 'lastName':
    case 'company':
    case 'title':
    case 'headline':
    case 'location':
    case 'profileUrl':
      return c[field as 'firstName'] ?? '';
    default:
      return '';
  }
}

// Mapped, non-empty values keyed by CRM property. Empty values are left out so a sync never blanks
// a field someone filled in the CRM.
export function mappedProperties(c: CrmContact, mapping: CrmFieldMapping): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, prop] of Object.entries(mapping)) {
    const v = crmFieldValue(c, field).trim();
    if (prop && v) out[prop] = v;
  }
  return out;
}

// Notes are HTML in both HubSpot and Pipedrive: escape the text and keep its line breaks.
export function noteHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return esc.replace(/\r?\n/g, '<br>');
}

export const CRM_EVENTS = ['reply', 'stage', 'finished', 'connected', 'message', 'manual'] as const;
export type CrmEvent = (typeof CRM_EVENTS)[number];

// Property names: HubSpot internal names, Pipedrive keys (custom fields are 40-hex keys), EspoCRM attribute names.
const property = z.string().trim().max(100).regex(/^[A-Za-z0-9_.-]*$/, 'Use the property’s internal name (letters, digits, _ . -)');
const slugs = z.array(z.string().trim().min(1).max(60)).max(30);

// Sync settings shared by every CRM. Each vendor passes its own default field mapping.
export function crmSettingsSchema(defaultMapping: CrmFieldMapping) {
  return z.object({
    triggers: z
      .object({
        onReply: z.boolean().default(true),
        onStageChange: slugs.default(['interested', 'meeting']),
        onCampaignFinished: z.boolean().default(false),
        onConnected: z.boolean().default(false),
        logMessages: z.boolean().default(false),
      })
      .default({}),
    // Stage slugs that create a deal (once per lead) when the lead reaches them.
    createDealOn: slugs.default([]),
    dealNameTemplate: z.string().trim().max(200).default('{{company}} – {{fullName}}'),
    fieldMapping: z
      .record(property)
      .refine((m) => Object.keys(m).every((k) => (CRM_FIELDS as readonly string[]).includes(k)), 'Unknown field in the mapping')
      .default(defaultMapping),
  });
}
export type CrmSettings = z.infer<ReturnType<typeof crmSettingsSchema>>;

export const HUBSPOT_MAPPING: CrmFieldMapping = { firstName: 'firstname', lastName: 'lastname', email: 'email', company: 'company', title: 'jobtitle', phone: 'phone', profileUrl: '' };
export const PIPEDRIVE_MAPPING: CrmFieldMapping = { fullName: 'name', email: 'email', phone: 'phone', profileUrl: '' };
// EspoCRM attribute names (custom fields start with "c", e.g. cLinkedInUrl). No company: contacts get no Account.
// No title either: a Contact's `title` is not stored on the contact but as its role at its Account, so without an
// Account EspoCRM drops it. A custom field (cJobTitle) can hold it.
export const ESPOCRM_MAPPING: CrmFieldMapping = { firstName: 'firstName', lastName: 'lastName', email: 'emailAddress', phone: 'phoneNumber', profileUrl: '' };
export const SIMULATED_MAPPING: CrmFieldMapping = { firstName: 'first_name', lastName: 'last_name', email: 'email', company: 'company', title: 'title', profileUrl: 'linkedin_url' };

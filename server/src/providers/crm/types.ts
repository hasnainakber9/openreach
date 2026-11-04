import type { BaseProvider } from '../registry.js';

export interface CrmContact {
  email: string | null;
  firstName: string;
  lastName: string;
  company: string;
  title: string;
  phone: string | null;
  profileUrl: string;
}

// Our field name → the CRM's property name.
export type CrmFieldMapping = Record<string, string>;

export interface CrmProvider extends BaseProvider {
  upsertContact(c: CrmContact, mapping: CrmFieldMapping, existingId?: string | null): Promise<{ id: string; created: boolean }>;
  addNote(contactId: string, note: { body: string; timestamp: number }): Promise<{ id: string }>;
  createDeal(contactId: string, deal: { name: string; stage?: string }): Promise<{ id: string }>;
}

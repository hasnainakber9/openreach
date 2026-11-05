import type { BaseProvider } from '../registry.js';

export interface FindEmailInput {
  firstName: string;
  lastName: string;
  company: string;
  domain?: string;
  profileUrl: string;
}

export interface FoundEmail {
  email: string;
  confidence?: number; // 0–100 when the vendor gives one
  status?: EmailStatus; // the vendor's own verification, mapped
  reason?: string;
  credits?: number; // what the call cost, for the usage log
}

export type EmailStatus = 'valid' | 'risky' | 'invalid' | 'unknown';

export interface EmailFinder extends BaseProvider {
  find(input: FindEmailInput): Promise<FoundEmail | null>;
}

export interface VerifyResult {
  status: EmailStatus;
  reason: string;
  credits?: number;
}

export interface EmailVerifier extends BaseProvider {
  verify(email: string): Promise<VerifyResult>;
}

// Lead columns an enricher may fill (only blanks are filled; user input is never overwritten).
export interface LeadFields {
  firstName: string;
  lastName: string;
  headline: string;
  title: string;
  company: string;
  location: string;
  email: string;
  phone: string;
}

export interface EnrichInput {
  firstName: string;
  lastName: string;
  company: string;
  title: string;
  email: string | null;
  profileUrl: string;
  domain?: string;
}

export interface EnrichResult {
  fields: Partial<LeadFields>;
  companyDomain?: string;
  enrichment: Record<string, unknown>;
  credits?: number;
}

export interface Enricher extends BaseProvider {
  enrich(lead: EnrichInput): Promise<EnrichResult | null>;
}

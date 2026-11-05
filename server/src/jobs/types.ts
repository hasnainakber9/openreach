import type { EnrichJobPayload } from '../services/enrichment.js';

// Payload of every job type, keyed by type. Each step adds its keys here (and wires the handler
// in handlers.ts), for example:
//   'leads.import': { importId: number }            g1-sources
//   'ai.personalize': { campaignLeadId: number }    g2-ai-writer
//   'ai.classify': { messageId: number }            g2-ai-replies
//   'enrich.lead': EnrichJobPayload                  g4-data
//   'crm.sync': { integrationId: number; leadId: number; event: string; ref: string } g5-crm
// Tests add their own types with `declare module` augmentation.
export interface JobPayloads {
  'leads.import': { importId: number };
  'ai.personalize': { campaignLeadId: number };
  'ai.classify': { messageId: number };
  'email.sync': { mailboxId: number };
  'enrich.lead': EnrichJobPayload;
  // tokenEnc: the invite token sealed with APP_SECRET (only its hash is in the invites table).
  'invite.email': { inviteId: number; tokenEnc: string };
}

export type JobType = keyof JobPayloads & string;

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

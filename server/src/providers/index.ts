import { anthropicAi } from './ai/anthropic.js';
import { openaiCompatAi } from './ai/openai-compat.js';
import { simulatedAi } from './ai/simulated.js';
import { hubspotCrm } from './crm/hubspot.js';
import { pipedriveCrm } from './crm/pipedrive.js';
import { simulatedCrm } from './crm/simulated.js';
import { apolloEnricher, apolloFinder } from './data/apollo.js';
import { hunterFinder, hunterVerifier } from './data/hunter.js';
import { neverBounceVerifier } from './data/neverbounce.js';
import { simulatedFinder, simulatedEnricher, simulatedVerifier } from './data/simulated.js';
import { websiteEnricher } from './data/website.js';
import { zeroBounceVerifier } from './data/zerobounce.js';
import { registerProvider } from './registry.js';
import { simulatedSms } from './sms/simulated.js';
import { twilioSms } from './sms/twilio.js';

// The one place provider definitions are registered. Real vendors are added here by later steps.
export function registerProviders() {
  for (const def of [simulatedAi, anthropicAi, openaiCompatAi, simulatedFinder, hunterFinder, apolloFinder, simulatedVerifier, hunterVerifier, zeroBounceVerifier, neverBounceVerifier, simulatedEnricher, apolloEnricher, websiteEnricher, simulatedCrm, hubspotCrm, pipedriveCrm, simulatedSms, twilioSms]) registerProvider(def as any);
}

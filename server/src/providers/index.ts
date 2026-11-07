import { anthropicAi } from './ai/anthropic.js';
import { openaiCompatAi } from './ai/openai-compat.js';
import { simulatedAi } from './ai/simulated.js';
import { espocrmCrm } from './crm/espocrm.js';
import { hubspotCrm } from './crm/hubspot.js';
import { pipedriveCrm } from './crm/pipedrive.js';
import { simulatedCrm } from './crm/simulated.js';
import { afterShipVerifier } from './data/aftership.js';
import { apolloEnricher, apolloFinder } from './data/apollo.js';
import { hunterFinder, hunterVerifier } from './data/hunter.js';
import { neverBounceVerifier } from './data/neverbounce.js';
import { patternFinder } from './data/pattern.js';
import { simulatedFinder, simulatedEnricher, simulatedVerifier } from './data/simulated.js';
import { websiteEnricher } from './data/website.js';
import { zeroBounceVerifier } from './data/zerobounce.js';
import { registerProvider } from './registry.js';
import { simulatedSms } from './sms/simulated.js';
import { twilioSms } from './sms/twilio.js';

// The one place provider definitions are registered. Real vendors are added here by later steps.
export function registerProviders() {
  for (const def of [simulatedAi, anthropicAi, openaiCompatAi, simulatedFinder, patternFinder, hunterFinder, apolloFinder, simulatedVerifier, hunterVerifier, zeroBounceVerifier, neverBounceVerifier, afterShipVerifier, simulatedEnricher, apolloEnricher, websiteEnricher, simulatedCrm, hubspotCrm, pipedriveCrm, espocrmCrm, simulatedSms, twilioSms]) registerProvider(def as any);
}

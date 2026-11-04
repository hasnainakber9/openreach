import { anthropicAi } from './ai/anthropic.js';
import { openaiCompatAi } from './ai/openai-compat.js';
import { simulatedAi } from './ai/simulated.js';
import { simulatedCrm } from './crm/simulated.js';
import { simulatedFinder, simulatedEnricher, simulatedVerifier } from './data/simulated.js';
import { registerProvider } from './registry.js';
import { simulatedSms } from './sms/simulated.js';

// The one place provider definitions are registered. Real vendors are added here by later steps.
export function registerProviders() {
  for (const def of [simulatedAi, anthropicAi, openaiCompatAi, simulatedFinder, simulatedVerifier, simulatedEnricher, simulatedCrm, simulatedSms]) registerProvider(def as any);
}

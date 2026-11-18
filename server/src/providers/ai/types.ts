import type { BaseProvider } from '../registry.js';

export interface AiRequest {
  purpose: 'write' | 'personalize' | 'classify' | 'reply';
  system: string;
  prompt: string;
  maxTokens: number;
  temperature?: number;
  // Writers get the stronger model; classifiers the cheaper, faster one.
  tier: 'writer' | 'classifier';
}

export interface AiResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AiProvider extends BaseProvider {
  complete(req: AiRequest): Promise<AiResult>;
}

// The longest one AI request may take (the OpenAI-compatible provider's timeout setting tops out here, for
// slow local models on a laptop CPU). AI jobs allow a little more, so a slow answer isn't taken as a stuck run.
export const AI_MAX_TIMEOUT_SECONDS = 600;

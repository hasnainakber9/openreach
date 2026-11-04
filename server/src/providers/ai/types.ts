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

import type { BaseProvider } from '../registry.js';

export interface SmsMessage {
  channel: 'sms' | 'whatsapp';
  to: string; // E.164
  body: string;
  contentSid?: string; // WhatsApp template, outside the 24-hour session window
  contentVariables?: Record<string, string>;
}

export interface SmsProvider extends BaseProvider {
  send(msg: SmsMessage): Promise<{ externalId: string }>;
  // Inbound webhook check. Must be false for anything that can't prove the request's origin.
  verifySignature(url: string, params: Record<string, string>, signature: string): boolean;
}

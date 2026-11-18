import type { BaseProvider } from '../registry.js';

export interface SmsMessage {
  channel: 'sms' | 'whatsapp';
  to: string; // E.164
  body: string;
  contentSid?: string; // WhatsApp template, outside the 24-hour session window
  contentVariables?: Record<string, string>;
}

// When and how much the messaging runner may send through this provider (per workspace, per local day).
export interface SmsPolicy {
  smsDailyLimit: number;
  whatsappDailyLimit: number;
  timezone: string;
  sendStart: string; // "HH:MM"
  sendEnd: string;
  // Turns national numbers (07700 900123) into E.164 with this country code ("44"); unset = international only.
  defaultCountryCode: string | null;
  // Whether each channel can be sent at all (Twilio needs an SMS number or Messaging Service, and a WhatsApp sender).
  sms: boolean;
  whatsapp: boolean;
}

export const DEFAULT_SMS_POLICY: SmsPolicy = {
  smsDailyLimit: 100,
  whatsappDailyLimit: 100,
  timezone: 'UTC',
  sendStart: '09:00',
  sendEnd: '19:00',
  defaultCountryCode: null,
  sms: true,
  whatsapp: true,
};

export interface SmsProvider extends BaseProvider {
  readonly policy: SmsPolicy;
  send(msg: SmsMessage): Promise<{ externalId: string }>;
  // Inbound webhook check. Must be false for anything that can't prove the request's origin.
  verifySignature(url: string, params: Record<string, string>, signature: string): boolean;
}

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { isValidTimezone } from '../../engine/limits.js';
import { normalizePhone } from '../../services/suppression.js';
import { httpJson, ProviderError } from '../http.js';
import type { ProviderDef } from '../registry.js';
import { DEFAULT_SMS_POLICY, type SmsPolicy, type SmsProvider } from './types.js';

// Twilio Programmable Messaging (SMS and WhatsApp).
//   Send: POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json, form-encoded, HTTP Basic auth
//         https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource
//   Test: GET  https://api.twilio.com/2010-04-01/Accounts/{AccountSid}.json
//   Inbound webhook signatures: https://www.twilio.com/docs/usage/security#validating-requests
// Follows Twilio's public docs; tested only against fakes, never against the live API.

const API = 'https://api.twilio.com/2010-04-01';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const e164 = z
  .string()
  .trim()
  .transform((v, c) => {
    const n = normalizePhone(v);
    if (!n) c.addIssue({ code: 'custom', message: 'Use the international format, such as +14155550123' });
    return n ?? '';
  });
const blankToUndefined = (v: unknown) => (typeof v === 'string' && !v.trim() ? undefined : v);

// The account SID goes into the request path, so it must be exactly Twilio's format.
const credentials = z.object({
  accountSid: z.string().trim().regex(/^AC[0-9a-fA-F]{32}$/, 'An Account SID starts with AC followed by 32 hex characters'),
  authToken: z.string().trim().min(16).max(200),
});

const settings = z.object({
  fromNumber: z.preprocess(blankToUndefined, e164.optional()),
  whatsappFrom: z.preprocess(blankToUndefined, e164.optional()),
  messagingServiceSid: z.preprocess(blankToUndefined, z.string().trim().regex(/^MG[0-9a-fA-F]{32}$/, 'A Messaging Service SID starts with MG').optional()),
  defaultCountryCode: z.preprocess(blankToUndefined, z.string().trim().regex(/^\+?[1-9]\d{0,3}$/, 'A country calling code such as 1 or 44').optional()),
  smsDailyLimit: z.coerce.number().int().min(1).max(10000).default(100),
  whatsappDailyLimit: z.coerce.number().int().min(1).max(10000).default(100),
  timezone: z.string().refine(isValidTimezone, 'Unknown time zone').default('UTC'),
  sendStart: hhmm.default('09:00'),
  sendEnd: hhmm.default('19:00'),
});
type Settings = z.infer<typeof settings>;

// Twilio's signature: base64 HMAC-SHA1 over the full URL followed by every POST parameter, sorted by name,
// as name + value. Compared in constant time.
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string): boolean {
  if (!authToken || !signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function twilioPolicy(s: Partial<Settings>): SmsPolicy {
  return {
    smsDailyLimit: s.smsDailyLimit ?? DEFAULT_SMS_POLICY.smsDailyLimit,
    whatsappDailyLimit: s.whatsappDailyLimit ?? DEFAULT_SMS_POLICY.whatsappDailyLimit,
    timezone: s.timezone ?? 'UTC',
    sendStart: s.sendStart ?? DEFAULT_SMS_POLICY.sendStart,
    sendEnd: s.sendEnd ?? DEFAULT_SMS_POLICY.sendEnd,
    defaultCountryCode: s.defaultCountryCode?.replace(/^\+/, '') ?? null,
    sms: !!(s.fromNumber || s.messagingServiceSid),
    // A Messaging Service can hold a WhatsApp sender too.
    whatsapp: !!(s.whatsappFrom || s.messagingServiceSid),
  };
}

export const twilioSms: ProviderDef<'sms'> = {
  id: 'twilio',
  kind: 'sms',
  label: 'Twilio',
  description: 'Sends SMS and WhatsApp messages through your Twilio account and receives replies (including STOP) through a webhook.',
  docsUrl: 'https://www.twilio.com/docs/messaging',
  fields: [
    { key: 'accountSid', label: 'Account SID', type: 'password', secret: true, required: true, placeholder: 'AC…', help: 'Twilio Console → Account info.' },
    { key: 'authToken', label: 'Auth token', type: 'password', secret: true, required: true, help: 'Also used to check that inbound messages really come from Twilio.' },
    { key: 'fromNumber', label: 'SMS from number', type: 'text', placeholder: '+14155550123', help: 'A Twilio number that can send SMS. Leave empty when you use a Messaging Service.' },
    { key: 'messagingServiceSid', label: 'Messaging Service SID', type: 'text', placeholder: 'MG…', help: 'Optional. Used instead of the from numbers.' },
    { key: 'whatsappFrom', label: 'WhatsApp sender', type: 'text', placeholder: '+14155550123', help: 'Your approved WhatsApp sender number. Without it (or a Messaging Service), WhatsApp steps are skipped.' },
    { key: 'defaultCountryCode', label: 'Default country code', type: 'text', placeholder: '1', help: 'Lets numbers saved without a country code (07700 900123) be sent. Numbers in international form always work.' },
    { key: 'smsDailyLimit', label: 'SMS per day', type: 'number', placeholder: '100' },
    { key: 'whatsappDailyLimit', label: 'WhatsApp messages per day', type: 'number', placeholder: '100' },
    { key: 'timezone', label: 'Time zone', type: 'text', placeholder: 'UTC', help: 'For the sending window and daily limits, e.g. Europe/London.' },
    { key: 'sendStart', label: 'Send from', type: 'text', placeholder: '09:00' },
    { key: 'sendEnd', label: 'Send until', type: 'text', placeholder: '19:00' },
  ],
  credentials,
  settings,
  create(ctx, cfg): SmsProvider {
    const sid: string = cfg.credentials.accountSid ?? '';
    const token: string = cfg.credentials.authToken ?? '';
    const s = cfg.settings as Partial<Settings>;
    const auth = `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
    const common = { headers: { authorization: auth }, secrets: [token, auth], integrationId: cfg.integrationId };
    const ready = () => {
      if (!/^AC[0-9a-fA-F]{32}$/.test(sid) || !token) throw new ProviderError('AUTH', 'Add the Twilio Account SID and auth token', { integrationId: cfg.integrationId });
    };
    return {
      providerId: 'twilio',
      simulated: false,
      policy: twilioPolicy(s),
      async test() {
        ready();
        const r = await httpJson<{ friendly_name?: string; status?: string }>(ctx, `${API}/Accounts/${sid}.json`, { ...common, timeoutMs: 10_000 });
        const missing = !s.fromNumber && !s.messagingServiceSid ? ' Add an SMS from number or a Messaging Service SID before sending.' : '';
        return { ok: r?.status !== 'suspended' && r?.status !== 'closed', message: `Connected to Twilio account ${r?.friendly_name ?? sid.slice(0, 6) + '…'} (${r?.status ?? 'unknown status'}).${missing}` };
      },
      async send(msg) {
        ready();
        const wa = msg.channel === 'whatsapp';
        const from = wa ? s.whatsappFrom : s.fromNumber;
        if (!from && !s.messagingServiceSid) {
          throw new ProviderError('BAD_REQUEST', wa ? 'No WhatsApp sender is set up in the Twilio integration' : 'Add an SMS from number or a Messaging Service SID to the Twilio integration', {
            integrationId: cfg.integrationId,
          });
        }
        const form: Record<string, string> = { To: wa ? `whatsapp:${msg.to}` : msg.to };
        if (from) form.From = wa ? `whatsapp:${from}` : from;
        else form.MessagingServiceSid = s.messagingServiceSid!;
        if (wa && msg.contentSid) {
          form.ContentSid = msg.contentSid;
          if (msg.contentVariables && Object.keys(msg.contentVariables).length) form.ContentVariables = JSON.stringify(msg.contentVariables);
        } else form.Body = msg.body;
        const r = await httpJson<{ sid?: string }>(ctx, `${API}/Accounts/${sid}/Messages.json`, { ...common, method: 'POST', form, timeoutMs: 20_000 });
        if (!r?.sid) throw new ProviderError('UNAVAILABLE', 'Twilio did not return a message id', { integrationId: cfg.integrationId });
        return { externalId: r.sid };
      },
      verifySignature: (url, params, signature) => verifyTwilioSignature(token, url, params, signature),
    };
  },
};

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import type { ChannelNodeType } from '../engine/sequence.js';
import { HttpError, parse } from '../http.js';
import { providerDef } from '../providers/registry.js';
import type { SmsProvider } from '../providers/sms/types.js';
import type { IntegrationRow } from '../providers/store.js';
import { handleInboundReply } from '../services/replies.js';
import { normalizePhone, suppressIdentity, suppressLead } from '../services/suppression.js';
import type { LeadRow } from '../types.js';
import { phoneThreadId, recordPhoneMessage } from './runner.js';

// Inbound SMS and WhatsApp from Twilio. The integration id in the path only says which auth token checks the
// X-Twilio-Signature header; the request is trusted only once that signature matches. Signatures are computed over
// PUBLIC_URL + path (never the Host header, which a proxy or attacker controls).

// Carrier-standard opt-out and opt-in keywords (Twilio handles the same words for SMS on its side too).
export const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
export const START_WORDS = ['START', 'UNSTOP'];

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export const twilioWebhookPath = (integrationId: number) => `/api/public/twilio/${integrationId}/inbound`;

export function twilioWebhookUrl(ctx: Ctx, integrationId: number): string | null {
  return ctx.config.publicUrl ? ctx.config.publicUrl + twilioWebhookPath(integrationId) : null;
}

const keyword = (body: string) => body.trim().toUpperCase().replace(/[^A-Z]/g, '');

// Leads keep phone numbers as free text, so both sides are normalized here. A lead already in this thread wins;
// otherwise the most recently added lead with that number.
function findLead(ctx: Ctx, workspaceId: number, channel: ChannelNodeType, phone: string, countryCode: string | null): LeadRow | null {
  const conv = ctx.db.get<{ lead_id: number | null }>('SELECT lead_id FROM conversations WHERE workspace_id = ? AND channel = ? AND thread_id = ? AND account_id IS NULL AND mailbox_id IS NULL', [
    workspaceId,
    channel,
    phoneThreadId(channel, phone),
  ]);
  if (conv?.lead_id) {
    const lead = ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [conv.lead_id, workspaceId]);
    if (lead) return lead;
  }
  const candidates = ctx.db.all<LeadRow>("SELECT * FROM leads WHERE workspace_id = ? AND phone IS NOT NULL AND phone <> '' ORDER BY id DESC", [workspaceId]);
  return candidates.find((l) => normalizePhone(l.phone, countryCode) === phone) ?? null;
}

export interface InboundResult {
  status: 'stored' | 'duplicate' | 'stopped' | 'started' | 'ignored';
  leadId: number | null;
}

// A verified inbound message: opt-out/opt-in keywords change suppression, anything else is a reply.
export function processTwilioInbound(ctx: Ctx, integration: IntegrationRow, provider: SmsProvider, params: Record<string, string>): InboundResult {
  const ws = integration.workspace_id;
  const sid = params.MessageSid || params.SmsMessageSid || '';
  const rawFrom = params.From ?? '';
  const channel: ChannelNodeType = /^whatsapp:/i.test(rawFrom) ? 'whatsapp' : 'sms';
  const phone = normalizePhone(rawFrom, provider.policy.defaultCountryCode);
  if (!sid || !phone) return { status: 'ignored', leadId: null };
  // Twilio retries webhooks it thinks failed; each message is stored once.
  const dup = ctx.db.get(
    "SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.workspace_id = ? AND c.channel IN ('sms', 'whatsapp') AND m.external_id = ?",
    [ws, sid],
  );
  if (dup) return { status: 'duplicate', leadId: null };

  const body = (params.Body ?? '').slice(0, 8000);
  const lead = findLead(ctx, ws, channel, phone, provider.policy.defaultCountryCode);
  const word = keyword(body);
  const stored = ctx.db.tx(() => recordPhoneMessage(ctx, { workspaceId: ws, channel, phone, lead, direction: 'in', externalId: sid, body }));

  if (STOP_WORDS.includes(word)) {
    // "Suppress the lead": every channel stops, not just SMS. The number itself is kept too, in case the
    // lead's phone is written in a national form the suppression list can't normalize.
    ctx.db.tx(() => {
      suppressIdentity(ctx, ws, 'phone', phone, 'sms_stop', 'twilio', lead?.id ?? null);
      if (lead) suppressLead(ctx, lead, 'sms_stop', 'twilio');
    });
    return { status: 'stopped', leadId: lead?.id ?? null };
  }
  if (START_WORDS.includes(word)) {
    // Every row the STOP created goes (all kinds), so nothing stays half-suppressed. Stopped campaign leads stay stopped.
    ctx.db.run("DELETE FROM suppressions WHERE workspace_id = ? AND reason = 'sms_stop' AND ((kind = 'phone' AND value = ?) OR lead_id = ?)", [ws, phone, lead?.id ?? -1]);
    return { status: 'started', leadId: lead?.id ?? null };
  }
  if (lead) handleInboundReply(ctx, { lead, channel, conversationId: stored.conversationId, messageId: stored.messageId, body });
  return { status: 'stored', leadId: lead?.id ?? null };
}

export function twilioRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/api/public/twilio/:integrationId/inbound', async (req, reply) => {
    const { integrationId } = parse(z.object({ integrationId: z.coerce.number().int().positive() }), req.params);
    const row = ctx.db.get<IntegrationRow>("SELECT * FROM integrations WHERE id = ? AND kind = 'sms' AND provider = 'twilio'", [integrationId]);
    if (!row || !providerDef('sms', 'twilio')) throw new HttpError(404, 'Not found');
    if (!ctx.config.publicUrl) {
      ctx.providers.markStatus(row.id, 'error', 'Set PUBLIC_URL on the server so inbound Twilio messages can be verified');
      throw new HttpError(503, 'Inbound messages need PUBLIC_URL');
    }
    const provider = ctx.providers.instance<'sms'>(row);
    if (!provider) throw new HttpError(404, 'Not found');
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const params = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v ?? '')]));
    const signature = String(req.headers['x-twilio-signature'] ?? '');
    if (!provider.verifySignature(ctx.config.publicUrl + req.url, params, signature)) throw new HttpError(403, 'Invalid signature');
    processTwilioInbound(ctx, row, provider, params);
    return reply.header('content-type', 'text/xml').send(EMPTY_TWIML);
  });
}

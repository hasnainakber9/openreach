import type { Database } from '../db/database.js';
import { json } from '../db/db.js';
import { sign } from './crypto.js';

export const WEBHOOK_EVENTS = [
  'lead.connected',
  'lead.replied',
  'lead.finished',
  'lead.failed',
  'action.performed',
  'account.needs_login',
  'lead.suppressed',
  'lead.classified',
  'mailbox.needs_attention',
  'lead.email_bounced',
  'task.created',
  'task.completed',
  'lead.enriched',
  'lead.stage_changed',
  // Many leads moved at once (bulk edit, a deleted stage): { count, leadIds (first 1000), from, to, source, reason }.
  'leads.stage_changed',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export type EventSubscriber = (workspaceId: number, event: WebhookEvent, data: Record<string, unknown>) => void;

interface HookRow {
  id: number;
  url: string;
  events: string;
  secret: string;
}

// Outgoing events for CRMs, Zapier/Make/n8n and the like. Each delivery is signed with
// HMAC-SHA256 over the raw body in the X-OpenReach-Signature header.
export class Webhooks {
  sent: { url: string; event: string; body: unknown }[] = [];
  deliver = true;
  private subscribers: EventSubscriber[] = [];

  constructor(private db: Database) {}

  // In-process listeners (for example CRM sync). They should only enqueue jobs, never do slow work inline.
  subscribe(fn: EventSubscriber) {
    this.subscribers.push(fn);
    return () => void (this.subscribers = this.subscribers.filter((s) => s !== fn));
  }

  // `internal` goes to in-process subscribers only, never into a delivery (for example every row of a bulk change).
  emit(workspaceId: number, event: WebhookEvent, data: Record<string, unknown>, internal?: Record<string, unknown>) {
    for (const fn of this.subscribers) {
      try {
        fn(workspaceId, event, internal ? { ...data, ...internal } : data);
      } catch (e) {
        console.error(`[webhooks] subscriber failed on ${event}`, e);
      }
    }
    const hooks = this.db.all<HookRow>('SELECT id, url, events, secret FROM webhooks WHERE workspace_id = ? AND active = 1', [workspaceId]);
    for (const h of hooks) {
      const events = json<string[]>(h.events, []);
      // Hooks for single stage moves hear about bulk ones too, so a bulk edit is never missed.
      const also = event === 'leads.stage_changed' && events.includes('lead.stage_changed');
      if (!events.includes(event) && !events.includes('*') && !also) continue;
      void this.send(h, { event, occurredAt: new Date().toISOString(), data });
    }
  }

  async send(h: HookRow, payload: { event: string; occurredAt: string; data: unknown }): Promise<string> {
    const body = JSON.stringify(payload);
    this.sent.push({ url: h.url, event: payload.event, body: payload });
    if (!this.deliver) return 'skipped';
    let status = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(h.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-openreach-event': payload.event, 'x-openreach-signature': sign(h.secret, body) },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        status = `${res.status}`;
        if (res.ok) break;
      } catch (e) {
        status = `error: ${(e as Error).message}`;
      }
      await new Promise((r) => setTimeout(r, 2000 * 4 ** attempt));
    }
    this.db.run('UPDATE webhooks SET last_status = ? WHERE id = ?', [`${status} at ${new Date().toISOString()}`, h.id]);
    return status;
  }
}

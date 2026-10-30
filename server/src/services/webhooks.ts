import type { DB } from '../db/db.js';
import { json } from '../db/db.js';
import { sign } from './crypto.js';

export const WEBHOOK_EVENTS = [
  'lead.connected',
  'lead.replied',
  'lead.finished',
  'lead.failed',
  'action.performed',
  'account.needs_login',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

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

  constructor(private db: DB) {}

  emit(workspaceId: number, event: WebhookEvent, data: Record<string, unknown>) {
    const hooks = this.db.all<HookRow>('SELECT id, url, events, secret FROM webhooks WHERE workspace_id = ? AND active = 1', [workspaceId]);
    for (const h of hooks) {
      const events = json<string[]>(h.events, []);
      if (!events.includes(event) && !events.includes('*')) continue;
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

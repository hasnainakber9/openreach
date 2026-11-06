import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { sign } from './crypto.js';
import { checkHost, HostCheckError, urlHost } from './hosts.js';

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

  // ctx is read lazily (db, fetch, dns), so tests can swap them after the context is built.
  constructor(private ctx: Ctx) {}

  private get db() {
    return this.ctx.db;
  }

  // In-process listeners (for example CRM sync). They should only enqueue jobs, never do slow work inline.
  subscribe(fn: EventSubscriber) {
    this.subscribers.push(fn);
    return () => void (this.subscribers = this.subscribers.filter((s) => s !== fn));
  }

  emit(workspaceId: number, event: WebhookEvent, data: Record<string, unknown>) {
    for (const fn of this.subscribers) {
      try {
        fn(workspaceId, event, data);
      } catch (e) {
        console.error(`[webhooks] subscriber failed on ${event}`, e);
      }
    }
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
        // Hosted installs: the URL is the tenant's, so its host must be public (checked when saved, and again
        // here since DNS can change). fetch resolves the name once more on its own, as for AI base URLs.
        await checkHost(this.ctx, urlHost(h.url) ?? '');
        // No redirects: a public URL must not bounce the request to an internal one.
        const res = await this.ctx.fetch(h.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-openreach-event': payload.event, 'x-openreach-signature': sign(h.secret, body) },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        status = `${res.status}`;
        if (res.ok) break;
      } catch (e) {
        status = `error: ${(e as Error).message}`;
        // A private host stays private: retrying only delays the answer.
        if (e instanceof HostCheckError && e.code === 'BLOCKED') break;
      }
      await new Promise((r) => setTimeout(r, 2000 * 4 ** attempt));
    }
    this.db.run('UPDATE webhooks SET last_status = ? WHERE id = ?', [`${status} at ${new Date().toISOString()}`, h.id]);
    return status;
  }
}

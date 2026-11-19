import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { applyCategory } from '../src/ai/classify.js';
import { DAY } from '../src/clock.js';
import { defaultSequence } from '../src/engine/sequence.js';
import { signToken } from '../src/mail/tracking.js';
import { unsubscribeByToken } from '../src/mail/unsubscribe.js';
import { getSetting, setSetting } from '../src/services/settings.js';
import { normalizePhone, suppressIdentity, suppressionReason, suppressLead } from '../src/services/suppression.js';
import type { LeadRow } from '../src/types.js';
import { addLeads, makeCampaign, makeWorld, runFor } from './helpers.js';

const lead = (w: ReturnType<typeof makeWorld>, id: number) => w.ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [id])!;

describe('suppression', () => {
  it('suppresses every identity of a lead, stops its campaigns and emits lead.suppressed', () => {
    const w = makeWorld();
    const [id] = addLeads(w, 1);
    w.ctx.db.update('leads', id, { email: 'Ann@Acme.com', phone: '+44 20 7946 0958' });
    const { id: campaignId } = makeCampaign(w, defaultSequence(), {}, [id]);
    const events: { ws: number; event: string; data: any }[] = [];
    w.ctx.webhooks.subscribe((ws, event, data) => events.push({ ws, event, data }));
    suppressLead(w.ctx, lead(w, id), 'unsubscribe', 'email link');

    expect(w.ctx.db.all('SELECT kind, value, reason FROM suppressions ORDER BY kind')).toEqual([
      { kind: 'email', value: 'ann@acme.com', reason: 'unsubscribe' },
      { kind: 'linkedin', value: 'lead-0', reason: 'unsubscribe' },
      { kind: 'phone', value: '+442079460958', reason: 'unsubscribe' },
    ]);
    expect(w.ctx.db.get('SELECT state, last_error FROM campaign_leads WHERE campaign_id = ?', [campaignId])).toEqual({ state: 'skipped', last_error: 'Suppressed: unsubscribe' });
    expect(events).toEqual([{ ws: w.workspaceId, event: 'lead.suppressed', data: { lead: expect.objectContaining({ id }), reason: 'unsubscribe', source: 'email link' } }]);
    // Suppressing twice is harmless.
    suppressLead(w.ctx, lead(w, id), 'manual', null);
    expect(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM suppressions')!.n).toBe(3);
  });

  it('records an explicit opt-out on every identity when one is already suppressed', () => {
    const w = makeWorld();
    const [a, b] = addLeads(w, 2);
    w.ctx.db.update('leads', a, { email: 'ann@acme.com' });
    w.ctx.db.update('leads', b, { email: 'bob@acme.com' });
    const events: string[] = [];
    w.ctx.webhooks.subscribe((_ws, e) => events.push(e));
    // Hand-added rows for their addresses only: neither lead is in a running campaign.
    suppressIdentity(w.ctx, w.workspaceId, 'email', 'ann@acme.com', 'manual', 'added by Admin');
    suppressIdentity(w.ctx, w.workspaceId, 'email', 'bob@acme.com', 'manual', 'added by Admin');
    // Ann's reply marked Unsubscribe in the inbox; Bob clicks the unsubscribe link.
    const conv = w.ctx.db.insert('conversations', { workspace_id: w.workspaceId, account_id: w.accountId, lead_id: a, thread_id: 't-a', participant_name: 'Ann', last_message_at: w.ctx.clock.now() });
    applyCategory(w.ctx, { workspaceId: w.workspaceId, conversationId: conv, messageId: null, category: 'unsubscribe', confidence: 1, source: 'manual' });
    expect(unsubscribeByToken(w.ctx, signToken(w.ctx, 'u', { workspaceId: w.workspaceId, leadId: b, emailMessageId: 1 }))).toEqual({ ok: true, already: false });
    expect(w.ctx.db.all('SELECT kind, value, reason FROM suppressions WHERE kind = ? ORDER BY value', ['linkedin'])).toEqual([
      { kind: 'linkedin', value: 'lead-0', reason: 'unsubscribe' },
      { kind: 'linkedin', value: 'lead-1', reason: 'unsubscribe' },
    ]);
    expect(events.filter((e) => e === 'lead.suppressed')).toHaveLength(2);
    // Once every identity is on the list, suppressing again changes nothing and emits nothing.
    applyCategory(w.ctx, { workspaceId: w.workspaceId, conversationId: conv, messageId: null, category: 'unsubscribe', confidence: 1, source: 'manual' });
    expect(unsubscribeByToken(w.ctx, signToken(w.ctx, 'u', { workspaceId: w.workspaceId, leadId: b, emailMessageId: 1 }))).toEqual({ ok: true, already: true });
    expect(events.filter((e) => e === 'lead.suppressed')).toHaveLength(2);
    // Taking the hand-added rows off the list leaves the opt-outs in place.
    w.ctx.db.run("DELETE FROM suppressions WHERE kind = 'email'");
    expect(suppressionReason(w.ctx, lead(w, a))).toBe('Suppressed: unsubscribe');
    expect(suppressionReason(w.ctx, lead(w, b))).toBe('Suppressed: unsubscribe');
  });

  it('matches leads by any identity, in their own workspace only', () => {
    const w = makeWorld();
    const [a, b] = addLeads(w, 2);
    w.ctx.db.update('leads', b, { email: 'b@corp.com' });
    suppressIdentity(w.ctx, w.workspaceId, 'email', 'B@CORP.com', 'bounce', 'test');
    expect(suppressionReason(w.ctx, lead(w, a))).toBeNull();
    expect(suppressionReason(w.ctx, lead(w, b))).toBe('Suppressed: bounce');
    const other = w.ctx.db.insert('workspaces', { name: 'Other', created_at: 0 });
    suppressIdentity(w.ctx, other, 'linkedin', 'lead-0', 'manual', 'test');
    expect(suppressionReason(w.ctx, lead(w, a))).toBeNull();
    expect(normalizePhone('0044 (20) 7946-0958')).toBe('+442079460958');
    expect(normalizePhone('020 7946 0958')).toBeNull();
  });

  it('skips suppressed leads when they are added to a campaign', () => {
    const w = makeWorld();
    const ids = addLeads(w, 3);
    suppressIdentity(w.ctx, w.workspaceId, 'linkedin', 'lead-1', 'not_interested', 'test');
    const { added } = makeCampaign(w, defaultSequence(), {}, ids);
    expect(added).toMatchObject({ added: 2, suppressed: 1 });
  });

  it('stops a lead suppressed mid-campaign before its next action', async () => {
    const w = makeWorld();
    const ids = addLeads(w, 2);
    const { id: campaignId } = makeCampaign(w, defaultSequence(), {}, ids);
    suppressIdentity(w.ctx, w.workspaceId, 'linkedin', 'lead-1', 'manual', 'test');
    await runFor(w, DAY);
    const row = w.ctx.db.get<{ state: string; last_error: string }>('SELECT state, last_error FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?', [campaignId, ids[1]])!;
    expect(row).toEqual({ state: 'skipped', last_error: 'Suppressed: manual' });
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE lead_id = ? AND status = 'ok'", [ids[1]])!.n).toBe(0);
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE lead_id = ? AND status = 'ok'", [ids[0]])!.n).toBeGreaterThan(0);
  });
});

describe('workspace settings', () => {
  it('stores validated JSON per workspace and falls back to defaults', () => {
    const w = makeWorld();
    const schema = z.object({ autoEnrich: z.boolean().default(false), limit: z.number().int().default(10) }).default({});
    expect(getSetting(w.ctx, w.workspaceId, 'enrichment', schema)).toEqual({ autoEnrich: false, limit: 10 });
    setSetting(w.ctx, w.workspaceId, 'enrichment', schema, { autoEnrich: true });
    setSetting(w.ctx, w.workspaceId, 'enrichment', schema, { autoEnrich: true, limit: 3 });
    expect(getSetting(w.ctx, w.workspaceId, 'enrichment', schema)).toEqual({ autoEnrich: true, limit: 3 });
    w.ctx.db.run("UPDATE workspace_settings SET value = '{\"limit\":\"lots\"}'");
    expect(getSetting(w.ctx, w.workspaceId, 'enrichment', schema)).toEqual({ autoEnrich: false, limit: 10 });
  });
});

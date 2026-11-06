import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DAY } from '../src/clock.js';
import { defaultSequence } from '../src/engine/sequence.js';
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

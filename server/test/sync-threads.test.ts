import { describe, expect, it } from 'vitest';
import type { InboxThread } from '../src/drivers/types.js';
import { recordOutbound } from '../src/engine/engine.js';
import { storeThread } from '../src/engine/sync.js';
import type { LeadRow } from '../src/types.js';
import { addLeads, makeWorld, type World } from './helpers.js';

// LinkedIn's 2026 inbox threads may not show the participant's profile link, so a thread can arrive
// with publicId null. It is then tied to a lead only when that is certain.
const lead = (w: World, id: number) => w.ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [id])!;
const thread = (threadId: string, name: string, messages: [dir: 'in' | 'out', body: string][]): InboxThread => ({
  threadId,
  participant: { name, publicId: null, profileUrl: '' },
  lastMessageAt: 0,
  unread: true,
  messages: messages.map(([direction, body], i) => ({ externalId: `${threadId}:${body}`, direction, body, sentAt: 1000 + i })),
});
const convOf = (w: World, threadId: string) => w.ctx.db.get<{ id: number; lead_id: number | null }>('SELECT id, lead_id FROM conversations WHERE thread_id = ?', [threadId]);

describe('inbox threads without a profile link', () => {
  it('ties the thread to the one lead this account wrote that message to, by name', () => {
    const w = makeWorld();
    const [a, b] = addLeads(w, 2);
    recordOutbound(w.ctx, w.account(), lead(w, a), 'Hello First0');
    recordOutbound(w.ctx, w.account(), lead(w, b), 'Hello First1');

    expect(storeThread(w.ctx, w.account(), thread('2-x', ' first0  last ', [['out', 'Hello First0'], ['in', 'Thanks, tell me more']]))).toBe(1);
    // The campaign's conversation now carries LinkedIn's thread, and the reply counts for the lead.
    expect(convOf(w, '2-x')).toMatchObject({ lead_id: a });
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out'")!.n).toBe(2);
    expect(lead(w, a).replied_at).toBeTruthy();
    expect(lead(w, b).replied_at).toBeFalsy();

    // Later syncs keep the thread's lead.
    expect(storeThread(w.ctx, w.account(), thread('2-x', 'First0 Last', [['in', 'Any news?']]))).toBe(1);
    expect(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')!.n).toBe(2);
  });

  it('leaves the thread without a lead when the name or message does not settle it', () => {
    const w = makeWorld();
    const [a, b] = addLeads(w, 2);
    recordOutbound(w.ctx, w.account(), lead(w, a), 'Hello there');
    recordOutbound(w.ctx, w.account(), lead(w, b), 'Hello there');
    // Same name on both leads, and the same message: two fit, so neither is chosen.
    w.ctx.db.run("UPDATE conversations SET participant_name = 'Sam Same'");
    storeThread(w.ctx, w.account(), thread('2-a', 'Sam Same', [['out', 'Hello there'], ['in', 'Hi']]));
    expect(convOf(w, '2-a')).toMatchObject({ lead_id: null });

    // Someone with a lead's name who never got our message is not that lead.
    const w2 = makeWorld();
    const [c] = addLeads(w2, 1);
    recordOutbound(w2.ctx, w2.account(), lead(w2, c), 'Hello First0');
    storeThread(w2.ctx, w2.account(), thread('2-b', 'First0 Last', [['in', 'Hi, we have not met']]));
    expect(convOf(w2, '2-b')).toMatchObject({ lead_id: null });
    expect(lead(w2, c).replied_at).toBeFalsy();
  });
});

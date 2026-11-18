import { describe, expect, it } from 'vitest';
import { DB } from '../src/db/db.js';

describe('migrations', () => {
  const db0 = new DB(':memory:', { migrateTo: 1 });
  it.skipIf(db0.dialect !== 'sqlite')('rebuilds conversations without losing rows or breaking foreign keys', () => {
    const db = new DB(':memory:', { migrateTo: 1 });
    const ws = db.insert('workspaces', { name: 'W', created_at: 1 });
    const acc = db.insert('accounts', { workspace_id: ws, name: 'Seat', created_at: 1 });
    const lead = db.insert('leads', { workspace_id: ws, public_id: 'jane', profile_url: 'https://www.linkedin.com/in/jane/', created_at: 1 });
    const conv = db.insert('conversations', { workspace_id: ws, account_id: acc, lead_id: lead, thread_id: 't1', participant_name: 'Jane', last_message_at: 5, unread: 1 });
    db.insert('messages', { conversation_id: conv, external_id: 'm1', direction: 'out', body: 'Hi', sent_at: 4 });
    db.insert('messages', { conversation_id: conv, external_id: 'm2', direction: 'in', body: 'Hello', sent_at: 5 });

    db.migrate();

    expect(db.get('SELECT id, workspace_id, channel, account_id, lead_id, thread_id, participant_name, unread FROM conversations')).toEqual({
      id: conv,
      workspace_id: ws,
      channel: 'linkedin',
      account_id: acc,
      lead_id: lead,
      thread_id: 't1',
      participant_name: 'Jane',
      unread: 1,
    });
    expect(db.all('SELECT external_id, body FROM messages ORDER BY id')).toEqual([
      { external_id: 'm1', body: 'Hi' },
      { external_id: 'm2', body: 'Hello' },
    ]);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(db.all<{ table: string }>('PRAGMA foreign_key_list(messages)').map((f) => f.table)).toEqual(['conversations']);

    // Email/SMS threads have no LinkedIn account.
    db.insert('conversations', { workspace_id: ws, channel: 'email', account_id: null, thread_id: 'e1' });
    // Cascades still work through the renamed table.
    db.run('DELETE FROM conversations WHERE id = ?', [conv]);
    expect(db.all('SELECT * FROM messages')).toEqual([]);
    db.run('DELETE FROM accounts WHERE id = ?', [acc]);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')!.n).toBe(1);
  });
});

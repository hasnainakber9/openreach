import { useEffect, useRef, useState } from 'react';
import { api, useApi, type Account } from '../api';
import { Button, Empty, useAction } from '../components/ui';
import { dateTime, timeAgo } from '../format';

interface Conversation {
  id: number;
  accountId: number;
  accountName: string;
  leadId: number | null;
  name: string;
  profileUrl: string;
  lastMessageAt: number;
  unread: number;
  headline: string | null;
  company: string | null;
  lastMessage: string | null;
  lastDirection: 'in' | 'out' | null;
  campaignName: string | null;
}

export default function Inbox() {
  const accounts = useApi<Account[]>('/api/accounts');
  const [accountId, setAccountId] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [q, setQ] = useState('');
  const params = new URLSearchParams();
  if (accountId) params.set('accountId', accountId);
  if (unreadOnly) params.set('unread', 'true');
  if (q) params.set('q', q);
  const list = useApi<Conversation[]>(`/api/inbox?${params}`, 10_000);
  const [openId, setOpenId] = useState<number | null>(null);
  const { busy, run } = useAction();

  const syncAll = () =>
    run(
      'sync',
      async () => {
        for (const a of accounts.data ?? []) if (a.status === 'active') await api(`/api/accounts/${a.id}/sync`, { body: {} });
        await list.reload();
      },
      'Inbox synced',
    );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Inbox</h1>
          <p>Conversations from every connected LinkedIn account in one place.</p>
        </div>
        <Button busy={busy === 'sync'} onClick={syncAll}>
          Sync now
        </Button>
      </div>
      <div className="card card-flush">
        <div className="inbox">
          <div className="inbox-list">
            <div className="stack" style={{ padding: 12, gap: 8, borderBottom: '1px solid var(--line)' }}>
              <input type="search" placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search conversations" />
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <select value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Account">
                  <option value="">All accounts</option>
                  {accounts.data?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <label className="row" style={{ gap: 4, whiteSpace: 'nowrap', fontSize: 13, flexWrap: 'nowrap', flex: 'none' }}>
                  <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread
                </label>
              </div>
            </div>
            {list.data && !list.data.length && <p className="muted" style={{ padding: 16 }}>No conversations yet. Messages your campaigns send, and replies, show up here.</p>}
            {list.data?.map((c) => (
              <button key={c.id} className={`inbox-item ${openId === c.id ? 'active' : ''} ${c.unread ? 'unread' : ''}`} onClick={() => setOpenId(c.id)}>
                <div className="spread">
                  <span className="cell-title">{c.name || 'Unknown'}</span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {timeAgo(c.lastMessageAt)}
                  </span>
                </div>
                <div className="cell-sub">
                  {c.lastDirection === 'out' && 'You: '}
                  {c.lastMessage}
                </div>
                <div className="cell-sub" style={{ fontSize: 11.5 }}>
                  {c.accountName}
                  {c.campaignName && ` · ${c.campaignName}`}
                </div>
              </button>
            ))}
          </div>
          {openId ? <Thread key={openId} id={openId} onRead={() => list.reload()} /> : <Empty title="Pick a conversation">Replies are detected automatically and stop the lead's campaign.</Empty>}
        </div>
      </div>
    </>
  );
}

function Thread({ id, onRead }: { id: number; onRead: () => void }) {
  const t = useApi<{ id: number; name: string; profileUrl: string; messages: { id: number; direction: 'in' | 'out'; body: string; sentAt: number }[] }>(`/api/inbox/${id}`, 15_000);
  const [text, setText] = useState('');
  const { busy, run } = useAction();
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (t.data) onRead();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!t.data]);
  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [t.data?.messages.length]);

  const send = () =>
    run('send', async () => {
      await api(`/api/inbox/${id}/reply`, { body: { text } });
      setText('');
      await t.reload();
      onRead();
    });

  if (!t.data) return <div />;
  return (
    <div className="thread">
      <div className="thread-head spread">
        <strong>{t.data.name}</strong>
        {t.data.profileUrl && (
          <a href={t.data.profileUrl} target="_blank" rel="noreferrer">
            View profile
          </a>
        )}
      </div>
      <div className="messages">
        {t.data.messages.map((m) => (
          <div key={m.id} className={`bubble bubble-${m.direction}`}>
            {m.body}
            <div className="bubble-time">{dateTime(m.sentAt)}</div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div className="composer">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write a reply… (Ctrl+Enter to send)"
          rows={2}
          onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() && send()}
        />
        <Button variant="primary" disabled={!text.trim()} busy={busy === 'send'} onClick={send}>
          Send
        </Button>
      </div>
    </div>
  );
}

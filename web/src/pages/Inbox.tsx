import { useEffect, useRef, useState } from 'react';
import { api, REPLY_CATEGORIES, useApi, type Account, type Conversation, type ReplyCategory, type Thread as ThreadData } from '../api';
import { Button, Empty, Pill, ProviderBadge, useAction } from '../components/ui';
import { CATEGORY_LABELS, dateTime, STAGE_LABELS, timeAgo } from '../format';

export default function Inbox() {
  const accounts = useApi<Account[]>('/api/accounts');
  const [accountId, setAccountId] = useState('');
  const [category, setCategory] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [q, setQ] = useState('');
  const params = new URLSearchParams();
  if (accountId) params.set('accountId', accountId);
  if (category) params.set('category', category);
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
          <p>Conversations from every connected LinkedIn account in one place. Replies are sorted by what they mean.</p>
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
                <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Reply category">
                  <option value="">All replies</option>
                  {REPLY_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
                  <option value="none">Not classified</option>
                </select>
              </div>
              <label className="row" style={{ gap: 4, whiteSpace: 'nowrap', fontSize: 13, flexWrap: 'nowrap' }}>
                <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only
              </label>
            </div>
            {list.data && !list.data.length && (
              <p className="muted" style={{ padding: 16 }}>
                {category || unreadOnly || q || accountId ? 'No conversations match these filters.' : 'No conversations yet. Messages your campaigns send, and replies, show up here.'}
              </p>
            )}
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
                <div className="spread" style={{ marginTop: 4 }}>
                  <span className="cell-sub" style={{ fontSize: 11.5 }}>
                    {c.accountName}
                    {c.campaignName && ` · ${c.campaignName}`}
                  </span>
                  {c.category && <Pill status={c.category}>{CATEGORY_LABELS[c.category]}</Pill>}
                </div>
              </button>
            ))}
          </div>
          {openId ? (
            <Thread key={openId} id={openId} onChange={() => list.reload()} />
          ) : (
            <Empty title="Pick a conversation">Replies are detected and classified automatically, and stop the lead's campaign unless its settings say to keep going.</Empty>
          )}
        </div>
      </div>
    </>
  );
}

function Thread({ id, onChange }: { id: number; onChange: () => void }) {
  const t = useApi<ThreadData>(`/api/inbox/${id}`, 15_000);
  const [text, setText] = useState('');
  const [suggest, setSuggest] = useState<{ suggestions: string[]; simulated: boolean } | null>(null);
  const [instruction, setInstruction] = useState('');
  const { busy, run } = useAction();
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (t.data) onChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!t.data]);
  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [t.data?.messages.length]);

  const send = () =>
    run('send', async () => {
      await api(`/api/inbox/${id}/reply`, { body: { text } });
      setText('');
      setSuggest(null);
      await t.reload();
      onChange();
    });

  // Drafts only: a suggestion goes into the reply box, and nothing is sent until Send.
  const draft = () =>
    run('suggest', async () => {
      setSuggest(await api(`/api/inbox/${id}/suggest`, { body: { count: 3, ...(instruction.trim() ? { instruction: instruction.trim() } : {}) } }));
    });

  const setCategory = (category: ReplyCategory) =>
    run(
      'category',
      async () => {
        t.setData(await api<ThreadData>(`/api/inbox/${id}/category`, { method: 'PATCH', body: { category } }));
        onChange();
      },
      category === 'unsubscribe' || category === 'not_interested' ? 'Category saved. This person is now on the do-not-contact list.' : 'Category saved',
    );

  if (!t.data) return <div />;
  const c = t.data;
  return (
    <div className="thread">
      <div className="thread-head stack" style={{ gap: 8 }}>
        <div className="spread">
          <strong>{c.name}</strong>
          {c.profileUrl && (
            <a href={c.profileUrl} target="_blank" rel="noreferrer">
              View profile
            </a>
          )}
        </div>
        <div className="row thread-meta">
          {c.category ? (
            <Pill status={c.category}>{CATEGORY_LABELS[c.category]}</Pill>
          ) : (
            <span className="muted">{c.messages.some((m) => m.direction === 'in') ? 'Not classified yet' : 'No reply yet'}</span>
          )}
          {c.category && <span className="muted">{c.categorySource === 'manual' ? 'set by hand' : c.categoryConfidence != null ? `AI, ${Math.round(c.categoryConfidence * 100)}% sure` : ''}</span>}
          <select value={c.category ?? ''} onChange={(e) => e.target.value && setCategory(e.target.value as ReplyCategory)} aria-label="Change reply category" disabled={busy === 'category'}>
            <option value="" disabled>
              Set category…
            </option>
            {REPLY_CATEGORIES.map((k) => (
              <option key={k} value={k}>
                {CATEGORY_LABELS[k]}
              </option>
            ))}
          </select>
          {c.suggestedStage && (
            <span className="muted" title="A hint from the reply's category. Pipeline stages are not built yet.">
              Suggested stage: <strong>{STAGE_LABELS[c.suggestedStage]}</strong>
            </span>
          )}
        </div>
      </div>
      <div className="messages">
        {c.messages.map((m) => (
          <div key={m.id} className={`bubble bubble-${m.direction}`}>
            {m.body}
            <div className="bubble-time">
              {dateTime(m.sentAt)}
              {m.category && ` · ${CATEGORY_LABELS[m.category]}`}
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      {suggest && (
        <div className="suggestions" role="group" aria-label="Suggested replies">
          <div className="spread">
            <span className="row" style={{ gap: 6 }}>
              <strong>Suggested replies</strong>
              <ProviderBadge simulated={suggest.simulated} />
            </span>
            <button className="icon-btn" onClick={() => setSuggest(null)} aria-label="Close suggestions">
              ×
            </button>
          </div>
          {suggest.suggestions.map((s, i) => (
            <button key={i} className="suggestion" onClick={() => setText(s)} title="Put this in the reply box to edit it">
              {s}
            </button>
          ))}
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Steer the drafts, e.g. offer a call next week" aria-label="Instruction for suggested replies" maxLength={500} />
            <Button size="sm" busy={busy === 'suggest'} onClick={draft}>
              Try again
            </Button>
          </div>
          <span className="field-hint">Pick one to edit it in the reply box. Nothing is sent until you press Send.</span>
        </div>
      )}
      <div className="composer">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write a reply… (Ctrl+Enter to send)"
          aria-label="Reply"
          rows={2}
          onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() && send()}
        />
        <div className="stack" style={{ gap: 6 }}>
          {!suggest && (
            <Button busy={busy === 'suggest'} onClick={draft} title="Draft replies with AI from this conversation">
              Suggest reply
            </Button>
          )}
          <Button variant="primary" disabled={!text.trim()} busy={busy === 'send'} onClick={send}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

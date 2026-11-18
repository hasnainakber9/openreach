import { useEffect, useRef, useState } from 'react';
import { api, REPLY_CATEGORIES, useApi, type Account, type Conversation, type Mailbox, type ReplyCategory, type Stage, type Thread as ThreadData } from '../api';
import { Icon } from '../components/Icon';
import { Button, Empty, Pill, ProviderBadge, useAction } from '../components/ui';
import { CATEGORY_LABELS, CHANNEL_LABELS, dateTime, timeAgo } from '../format';
import { canWrite, type Me } from '../session';

export default function Inbox({ me }: { me: Me }) {
  // Clients read conversations only: no replies, categories, stage moves or syncing.
  const writer = canWrite(me);
  const accounts = useApi<Account[]>(writer ? '/api/accounts' : null);
  const mailboxes = useApi<Mailbox[]>(writer ? '/api/mailboxes' : null);
  // "a12" = LinkedIn account 12, "m3" = mailbox 3, "c:sms" = every SMS (or WhatsApp) thread.
  const [source, setSource] = useState('');
  const [category, setCategory] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [q, setQ] = useState('');
  const params = new URLSearchParams();
  if (source.startsWith('a')) params.set('accountId', source.slice(1));
  if (source.startsWith('m')) params.set('mailboxId', source.slice(1));
  if (source.startsWith('c:')) params.set('channel', source.slice(2));
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
        // Mailboxes are read in the background; this only asks for it now.
        for (const m of mailboxes.data ?? []) if (m.status !== 'needs_attention' && (m.simulated || m.hasImap)) await api(`/api/mailboxes/${m.id}/sync`, { body: {} });
        await list.reload();
      },
      'Inbox synced',
    );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Inbox</h1>
          <p>Conversations from every LinkedIn account and mailbox in one place. Replies are sorted by what they mean.</p>
        </div>
        {writer && (
          <Button busy={busy === 'sync'} onClick={syncAll}>
            Sync now
          </Button>
        )}
      </div>
      <div className="card card-flush">
        <div className="inbox">
          <div className="inbox-list">
            {/* One filter per line: side by side, the 340px column cut the select texts short. */}
            <div className="stack inbox-filters">
              <input type="search" placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search conversations" />
              <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Account or mailbox">
                <option value="">All accounts and mailboxes</option>
                {accounts.data?.map((a) => (
                  <option key={`a${a.id}`} value={`a${a.id}`}>
                    {a.name}
                  </option>
                ))}
                {mailboxes.data?.map((m) => (
                  <option key={`m${m.id}`} value={`m${m.id}`}>
                    {m.name} (email)
                  </option>
                ))}
                <option value="c:sms">SMS</option>
                <option value="c:whatsapp">WhatsApp</option>
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
              <label className="row" style={{ gap: 4, whiteSpace: 'nowrap', fontSize: 13, flexWrap: 'nowrap' }}>
                <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only
              </label>
            </div>
            <div className="inbox-items">
              {list.data && !list.data.length && (
                <p className="muted" style={{ padding: 16 }}>
                  {category || unreadOnly || q || source ? 'No conversations match these filters.' : 'No conversations yet. Messages your campaigns send, and replies, show up here.'}
                </p>
              )}
              {list.data?.map((c) => (
                <button key={c.id} className={`inbox-item ${openId === c.id ? 'active' : ''} ${c.unread ? 'unread' : ''}`} onClick={() => setOpenId(c.id)}>
                  <div className="spread">
                    <span className="cell-title row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                      <span className="muted" title={CHANNEL_LABELS[c.channel] ?? 'LinkedIn'} aria-label={CHANNEL_LABELS[c.channel] ?? 'LinkedIn'}>
                        <Icon name={c.channel === 'linkedin' ? 'message' : c.channel} size={12} />
                      </span>
                      {c.name || c.participantAddress || 'Unknown'}
                    </span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {timeAgo(c.lastMessageAt)}
                    </span>
                  </div>
                  {c.subject && <div className="cell-sub" style={{ fontWeight: 600 }}>{c.subject}</div>}
                  <div className="cell-sub">
                    {c.lastDirection === 'out' && 'You: '}
                    {c.lastMessage}
                  </div>
                  <div className="spread" style={{ marginTop: 4 }}>
                    <span className="cell-sub" style={{ fontSize: 11.5 }}>
                      {c.accountName ?? c.mailboxName}
                      {c.campaignName && ` · ${c.campaignName}`}
                    </span>
                    {c.category && <Pill status={c.category}>{CATEGORY_LABELS[c.category]}</Pill>}
                  </div>
                </button>
              ))}
            </div>
          </div>
          {openId ? (
            <Thread key={openId} id={openId} onChange={() => list.reload()} writer={writer} />
          ) : (
            <div className="inbox-empty">
              <Empty title="Pick a conversation">Replies are detected and classified automatically, and stop the lead's campaign unless its settings say to keep going.</Empty>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Thread({ id, onChange, writer }: { id: number; onChange: () => void; writer: boolean }) {
  const t = useApi<ThreadData>(`/api/inbox/${id}`, 15_000);
  const stages = useApi<Stage[]>('/api/pipeline/stages');
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

  // Classification already moves the stage forward; this is for moving it by hand.
  const moveTo = (stageId: number) =>
    run(
      'stage',
      async () => {
        await api(`/api/leads/${t.data!.leadId}/stage`, { body: { stageId } });
        await t.reload();
      },
      'Stage changed',
    );

  if (!t.data) return <div />;
  const c = t.data;
  return (
    <div className="thread">
      <div className="thread-head stack" style={{ gap: 8 }}>
        <div className="spread">
          <div>
            <strong>{c.name || c.participantAddress}</strong>
            {c.channel === 'email' && (
              <div className="cell-sub">
                {c.subject && <>{c.subject} · </>}
                {c.participantAddress} via {c.mailboxName ?? 'a removed mailbox'}
              </div>
            )}
            {(c.channel === 'sms' || c.channel === 'whatsapp') && (
              <div className="cell-sub">
                {CHANNEL_LABELS[c.channel]} · {c.participantAddress}
              </div>
            )}
          </div>
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
          {c.category && <span className="muted">{c.categorySource === 'manual' ? 'set by hand' : c.categorySource === 'rules' ? 'keyword rules' : c.categoryConfidence != null ? `AI, ${Math.round(c.categoryConfidence * 100)}% sure` : ''}</span>}
          {writer && (
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
          )}
          {c.leadId && c.stage && !writer && <span className="muted">Stage: {c.stage.name}</span>}
          {writer && c.leadId && c.stage && (
            <select value={c.stage.id} onChange={(e) => moveTo(Number(e.target.value))} aria-label="Pipeline stage" disabled={busy === 'stage' || !stages.data}>
              {(stages.data ?? [c.stage]).map((s) => (
                <option key={s.id} value={s.id}>
                  Stage: {s.name}
                </option>
              ))}
            </select>
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
      {writer && suggest && (
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
      {writer && (
        <div className="composer">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={c.channel === 'email' ? 'Write an email reply, sent in this thread… (Ctrl+Enter to send)' : 'Write a reply… (Ctrl+Enter to send)'}
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
      )}
    </div>
  );
}

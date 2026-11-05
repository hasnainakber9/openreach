import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi, type BoardCard, type BoardColumn, type Campaign, type Tag, type TeamMember } from '../api';
import type { Me } from '../App';
import LeadDrawer from '../components/LeadDrawer';
import { Button, ColorTag, Empty, ErrorNote, Pill, useAction } from '../components/ui';
import { CATEGORY_LABELS, timeAgo } from '../format';

const PER_STAGE = 50;

// Kanban view of the pipeline: one column per stage. Cards move by drag and drop, or with each card's
// "Move to" menu for keyboard and screen-reader users.
export default function Pipeline({ me }: { me: Me }) {
  const campaigns = useApi<Campaign[]>('/api/campaigns');
  const team = useApi<TeamMember[]>('/api/team');
  const tags = useApi<Tag[]>('/api/tags');
  const [campaignId, setCampaignId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [tag, setTag] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [openLead, setOpenLead] = useState<number | null>(null);
  // Cards fetched with "Load more", per stage, on top of the first page.
  const [extra, setExtra] = useState<Record<number, BoardCard[]>>({});
  const [dragOver, setDragOver] = useState<number | null>(null);
  const { busy, run } = useAction();
  const canWrite = me.role !== 'client';

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const params = new URLSearchParams({ perStage: String(PER_STAGE) });
  if (campaignId) params.set('campaignId', campaignId);
  if (ownerId) params.set('ownerId', ownerId);
  if (tag) params.set('tag', tag);
  if (query) params.set('q', query);
  const board = useApi<{ stages: BoardColumn[] }>(`/api/pipeline/board?${params}`, 60_000);
  const filterKey = params.toString();
  useEffect(() => setExtra({}), [filterKey]);

  const columns = board.data?.stages ?? [];
  const shown = new Set(columns.flatMap((c) => c.leads.map((l) => l.id)));
  const cardsOf = (c: BoardColumn) => [...c.leads, ...(extra[c.id] ?? []).filter((l) => !shown.has(l.id))];
  const tagColor = (t: string) => tags.data?.find((x) => x.name.toLowerCase() === t.toLowerCase())?.color ?? '#64748b';
  const total = columns.reduce((n, c) => n + c.total, 0);
  const filtered = !!(campaignId || ownerId || tag || query);

  const move = (leadId: number, stageId: number) =>
    run(`move-${leadId}`, async () => {
      await api(`/api/leads/${leadId}/stage`, { body: { stageId } });
      setExtra((cur) => Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, v.filter((l) => l.id !== leadId)])));
      await board.reload();
    });

  const loadMore = (c: BoardColumn) =>
    run(`more-${c.id}`, async () => {
      const have = cardsOf(c).length;
      const r = await api<{ stages: BoardColumn[] }>(`/api/pipeline/board?${params}&stageId=${c.id}&offset=${have}`);
      setExtra((cur) => ({ ...cur, [c.id]: [...(cur[c.id] ?? []), ...(r.stages[0]?.leads ?? [])] }));
    });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Pipeline</h1>
          <p>Every lead by stage. Leads move forward on their own when they are first contacted, reply, or show interest; move them yourself by dragging a card or with its menu.</p>
        </div>
        {(me.role === 'owner' || me.role === 'admin') && (
          <Link className="btn" to="/settings?tab=pipeline">
            Edit stages
          </Link>
        )}
      </div>

      <div className="card" style={{ padding: 12, marginBottom: 16 }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input type="search" placeholder="Search name, company, headline, email" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 300 }} aria-label="Search leads" />
          <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} style={{ width: 180 }} aria-label="Campaign">
            <option value="">All campaigns</option>
            {campaigns.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} style={{ width: 150 }} aria-label="Owner">
            <option value="">Any owner</option>
            <option value="me">Mine</option>
            <option value="none">No owner</option>
            {team.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <select value={tag} onChange={(e) => setTag(e.target.value)} style={{ width: 150 }} aria-label="Tag">
            <option value="">Any tag</option>
            {tags.data?.map((t) => (
              <option key={t.id} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
          <span className="muted" style={{ marginLeft: 'auto' }}>
            {board.data ? `${total} lead${total === 1 ? '' : 's'}` : ''}
          </span>
        </div>
      </div>

      <ErrorNote error={board.error} />
      {board.data && !total && !filtered ? (
        <div className="card">
          <Empty title="No leads yet" action={<Link className="btn btn-primary" to="/leads">Go to leads</Link>}>
            Import leads and add them to a campaign. They show up here and move through the stages as they are contacted and reply.
          </Empty>
        </div>
      ) : (
        <div className="board" aria-label="Pipeline board">
          {columns.map((c) => {
            const cards = cardsOf(c);
            return (
              <section
                key={c.id}
                className={`board-col ${dragOver === c.id ? 'drag-over' : ''}`}
                aria-labelledby={`stage-${c.id}`}
                onDragOver={(e) => {
                  if (!canWrite) return;
                  e.preventDefault();
                  setDragOver(c.id);
                }}
                onDragLeave={(e) => e.currentTarget === e.target && setDragOver(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(null);
                  const id = Number(e.dataTransfer.getData('text/plain'));
                  const from = columns.find((col) => cardsOf(col).some((l) => l.id === id));
                  if (id && from && from.id !== c.id) void move(id, c.id);
                }}
              >
                <header className="board-col-head">
                  <span id={`stage-${c.id}`}>
                    <ColorTag color={c.color}>{c.name}</ColorTag>
                  </span>
                  <span className="muted num">{c.total}</span>
                </header>
                <div className="board-cards">
                  {cards.map((l) => (
                    <article
                      key={l.id}
                      className="board-card"
                      draggable={canWrite}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', String(l.id));
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      aria-busy={busy === `move-${l.id}`}
                    >
                      <button type="button" className="board-card-name" onClick={() => setOpenLead(l.id)}>
                        {l.name}
                      </button>
                      {(l.title || l.company) && <div className="cell-sub">{[l.title, l.company].filter(Boolean).join(' · ')}</div>}
                      {!!l.tags.length && (
                        <div className="row tag-row">
                          {l.tags.map((t) => (
                            <ColorTag key={t} color={tagColor(t)}>
                              {t}
                            </ColorTag>
                          ))}
                        </div>
                      )}
                      <div className="spread board-card-meta">
                        <span>
                          {l.replyCategory && l.replyCategory !== 'other' && <Pill status={l.replyCategory}>{CATEGORY_LABELS[l.replyCategory]}</Pill>}
                          {l.ownerName && <span className="muted"> {l.ownerName}</span>}
                        </span>
                        <span className="muted" title="Last activity">
                          {l.lastActivityAt ? timeAgo(l.lastActivityAt) : ''}
                        </span>
                      </div>
                      {canWrite && (
                        <select
                          className="board-card-move"
                          value={c.id}
                          onChange={(e) => move(l.id, Number(e.target.value))}
                          disabled={busy === `move-${l.id}`}
                          aria-label={`Move ${l.name} to stage`}
                        >
                          {columns.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.id === c.id ? `In ${s.name}` : `Move to ${s.name}`}
                            </option>
                          ))}
                        </select>
                      )}
                    </article>
                  ))}
                  {!cards.length && <p className="muted board-empty">No leads</p>}
                </div>
                {cards.length < c.total && (
                  <Button size="sm" variant="ghost" busy={busy === `more-${c.id}`} onClick={() => loadMore(c)}>
                    Load more ({c.total - cards.length})
                  </Button>
                )}
              </section>
            );
          })}
        </div>
      )}
      {openLead && <LeadDrawer id={openLead} onClose={() => setOpenLead(null)} onChanged={() => void board.reload()} />}
    </>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, assignable, useApi, type CrmLeadInfo, type EnrichOptions, type Lead, type Note, type Stage, type Tag, type TeamMember, type TimelineItem } from '../api';
import { ACTION_LABELS, CATEGORY_LABELS, CHANNEL_LABELS, dateTime, EMAIL_STATUS_LABELS, emailSourceLabel, ENRICHMENT_STATUS_LABELS, fullName, OUTCOME_LABELS, TASK_KIND_LABELS, timeAgo } from '../format';
import { Button, ColorTag, Field, Modal, Pill, ProviderBadge, useAction } from './ui';

// Company facts an enrichment provider may add, in display order.
const COMPANY_FACTS: Record<string, string> = { industry: 'Industry', companySize: 'Employees', website: 'Website', companyLinkedin: 'Company LinkedIn', foundedYear: 'Founded', seniority: 'Seniority' };

type LeadDetail = Lead & { owner: { id: number; name: string } | null; campaigns: any[] };

// Everything about one lead: profile, pipeline stage and owner, tags, notes, campaigns and one timeline.
// Used by the Leads page and the Pipeline board.
export default function LeadDrawer({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  // Polls while a lookup started here is running.
  const [watching, setWatching] = useState(false);
  const lead = useApi<LeadDetail>(`/api/leads/${id}`, watching ? 2000 : undefined);
  const stages = useApi<Stage[]>('/api/pipeline/stages');
  const team = useApi<TeamMember[]>('/api/team');
  const [edit, setEdit] = useState<Partial<Lead> | null>(null);
  // Bumped after changes that add timeline entries (stage moves, notes).
  const [version, setVersion] = useState(0);
  const { busy, run } = useAction();
  const l = lead.data;
  const looking = l?.enrichmentStatus === 'queued';
  useEffect(() => {
    if (watching && l && !looking) {
      setWatching(false);
      onChanged();
    }
    // onChanged is a new function on every render of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, looking, l]);
  if (!l) return null;
  const changed = async () => {
    await lead.reload();
    setVersion((v) => v + 1);
    onChanged();
  };
  const enrich = (key: string, o: Partial<EnrichOptions>) =>
    run(key, async () => {
      await api(`/api/leads/${id}/enrich`, { body: { find: false, verify: false, company: false, ...o } });
      await lead.reload();
      setWatching(true);
    });
  const save = () =>
    run(
      'save',
      async () => {
        await api(`/api/leads/${id}`, { method: 'PATCH', body: edit });
        setEdit(null);
        await changed();
      },
      'Lead updated',
    );
  const moveTo = (stageId: number) =>
    run('stage', async () => {
      await api(`/api/leads/${id}/stage`, { body: { stageId } });
      await changed();
    });
  const setOwner = (ownerId: number | null) =>
    run('owner', async () => {
      await api(`/api/leads/${id}`, { method: 'PATCH', body: { ownerId } });
      await changed();
    });
  const set = (k: keyof Lead) => (e: React.ChangeEvent<HTMLInputElement>) => setEdit({ ...edit, [k]: e.target.value });
  return (
    <Modal
      title={fullName(l)}
      wide
      onClose={onClose}
      footer={
        edit ? (
          <>
            <Button onClick={() => setEdit(null)}>Cancel</Button>
            <Button variant="primary" busy={busy === 'save'} onClick={save}>
              Save
            </Button>
          </>
        ) : (
          <Button onClick={() => setEdit({ firstName: l.firstName, lastName: l.lastName, company: l.company, title: l.title, email: l.email ?? '', location: l.location })}>Edit details</Button>
        )
      }
    >
      <div className="spread">
        <a href={l.profileUrl} target="_blank" rel="noreferrer">
          {l.profileUrl}
        </a>
        <span className="row" style={{ gap: 6 }}>
          {l.openProfile && <Pill status="open_profile">Open profile</Pill>}
          <Pill status={l.connectionStatus} />
        </span>
      </div>

      <div className="grid grid-2 lead-pipeline">
        <Field label="Stage" hint={l.stageChangedAt ? `Since ${dateTime(l.stageChangedAt)}${l.stageManual ? ', set by hand' : ''}` : undefined}>
          <select value={l.stage?.id ?? ''} onChange={(e) => moveTo(Number(e.target.value))} disabled={busy === 'stage' || !stages.data}>
            {stages.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Owner">
          <select value={l.ownerId ?? ''} onChange={(e) => setOwner(e.target.value ? Number(e.target.value) : null)} disabled={busy === 'owner'}>
            <option value="">Nobody</option>
            {assignable(team.data).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <TagEditor lead={l} onChanged={changed} />

      {edit ? (
        <div className="grid grid-2">
          {(['firstName', 'lastName', 'company', 'title', 'email', 'location'] as const).map((k) => (
            <Field key={k} label={k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}>
              <input type="text" value={(edit[k] as string) ?? ''} onChange={set(k)} />
            </Field>
          ))}
        </div>
      ) : (
        <div className="grid grid-2" style={{ fontSize: 13.5 }}>
          <div>
            <div className="muted">Headline</div>
            {l.headline || '—'}
          </div>
          <div>
            <div className="muted">Company / title</div>
            {[l.company, l.title].filter(Boolean).join(' · ') || '—'}
          </div>
          <div>
            <div className="muted">Email</div>
            {l.email || '—'}
          </div>
          <div>
            <div className="muted">Location</div>
            {l.location || '—'}
          </div>
          {Object.entries(l.custom).map(([k, v]) => (
            <div key={k}>
              <div className="muted">
                <code>{`{{${k}}}`}</code>
              </div>
              {v}
            </div>
          ))}
        </div>
      )}
      {!edit && (
        <section aria-labelledby="lead-enrichment">
          <div className="spread" style={{ marginBottom: 6 }}>
            <h3 id="lead-enrichment" style={{ margin: 0 }}>
              Email and company data
            </h3>
            {looking ? (
              <Pill status="queued">{ENRICHMENT_STATUS_LABELS.queued}</Pill>
            ) : (
              l.enrichmentStatus && (
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {ENRICHMENT_STATUS_LABELS[l.enrichmentStatus]} {timeAgo(l.enrichedAt)}
                </span>
              )
            )}
          </div>
          <dl className="facts">
            <div>
              <dt>Email status</dt>
              <dd>{l.email ? <Pill status={l.emailStatus ?? 'unknown'}>{EMAIL_STATUS_LABELS[l.emailStatus ?? 'unknown']}</Pill> : '—'}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{l.email ? emailSourceLabel(l.emailSource) : '—'}</dd>
            </div>
            <div>
              <dt>Checked</dt>
              <dd>{l.emailStatusAt ? dateTime(l.emailStatusAt) : 'Not yet'}</dd>
            </div>
            <div>
              <dt>Company domain</dt>
              <dd>{l.companyDomain ?? '—'}</dd>
            </div>
            {Object.entries(COMPANY_FACTS).map(([k, label]) =>
              l.enrichment[k] != null && l.enrichment[k] !== '' ? (
                <div key={k}>
                  <dt>{label}</dt>
                  <dd>{String(l.enrichment[k])}</dd>
                </div>
              ) : null,
            )}
          </dl>
          {l.emailStatusReason && (
            <p className="field-hint" style={{ margin: '6px 0 0' }}>
              {l.emailStatusReason}
            </p>
          )}
          {!!l.enrichment.simulated && <div className="note note-warning" style={{ marginTop: 6 }}>These company facts were made up by the built-in simulator. They are only shown here and never used in messages.</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <Button size="sm" busy={busy === 'find'} disabled={looking} onClick={() => enrich('find', { find: true, verify: true })}>
              {l.email ? 'Verify email' : 'Find email'}
            </Button>
            {!!l.email && (
              <Button size="sm" busy={busy === 'replace'} disabled={looking} onClick={() => confirm('Look for a verified work email and replace the current address if one is found?') && enrich('replace', { find: true, verify: true, overwrite: true })}>
                Find a better email
              </Button>
            )}
            <Button size="sm" busy={busy === 'company'} disabled={looking} onClick={() => enrich('company', { company: true })}>
              Add company data
            </Button>
          </div>
        </section>
      )}
      {!edit && <CrmPanel leadId={id} />}
      {!!l.campaigns.length && (
        <div>
          <h3 style={{ marginBottom: 6 }}>Campaigns</h3>
          {l.campaigns.map((c: any) => (
            <div key={c.id} className="spread" style={{ padding: '4px 0' }}>
              <Link to={`/campaigns/${c.id}`}>{c.name}</Link>
              <span className="row">
                {c.lastError && <span className="field-error">{c.lastError}</span>}
                <Pill status={c.state === 'active' ? 'running' : c.state}>{c.state === 'active' ? 'In progress' : undefined}</Pill>
              </span>
            </div>
          ))}
        </div>
      )}
      <Notes leadId={id} onChanged={() => setVersion((v) => v + 1)} />
      <Timeline leadId={id} version={version} />
    </Modal>
  );
}

// The lead's tags with remove buttons, and a box that adds an existing tag or creates a new one.
function TagEditor({ lead, onChanged }: { lead: Lead; onChanged: () => Promise<void> }) {
  const tags = useApi<Tag[]>('/api/tags');
  const [name, setName] = useState('');
  const { busy, run } = useAction();
  const color = (t: string) => tags.data?.find((x) => x.name.toLowerCase() === t.toLowerCase())?.color ?? '#64748b';
  const save = (next: string[]) =>
    run('tags', async () => {
      await api(`/api/leads/${lead.id}`, { method: 'PATCH', body: { tags: next } });
      setName('');
      await Promise.all([onChanged(), tags.reload()]);
    });
  const add = () => {
    const t = name.trim();
    if (t && !lead.tags.some((x) => x.toLowerCase() === t.toLowerCase())) void save([...lead.tags, t]);
    else setName('');
  };
  const listId = `tag-options-${lead.id}`;
  return (
    <div className="field">
      <span className="field-label" id={`${listId}-label`}>
        Tags
      </span>
      <div className="row tag-row" role="group" aria-labelledby={`${listId}-label`}>
        {lead.tags.map((t) => (
          <ColorTag key={t} color={color(t)} onRemove={() => save(lead.tags.filter((x) => x !== t))} removeLabel={`Remove tag ${t}`}>
            {t}
          </ColorTag>
        ))}
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
          list={listId}
          placeholder="Add a tag"
          aria-label="Add a tag"
          maxLength={50}
          style={{ width: 160 }}
        />
        <datalist id={listId}>
          {tags.data
            ?.filter((t) => !lead.tags.some((x) => x.toLowerCase() === t.name.toLowerCase()))
            .map((t) => <option key={t.id} value={t.name} />)}
        </datalist>
        <Button size="sm" disabled={!name.trim()} busy={busy === 'tags'} onClick={add}>
          Add
        </Button>
      </div>
    </div>
  );
}

function Notes({ leadId, onChanged }: { leadId: number; onChanged: () => void }) {
  const notes = useApi<Note[]>(`/api/leads/${leadId}/notes`);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const { busy, run } = useAction();
  const after = async () => {
    await notes.reload();
    onChanged();
  };
  const add = () =>
    run('add', async () => {
      await api(`/api/leads/${leadId}/notes`, { body: { body: text } });
      setText('');
      await after();
    });
  const save = () =>
    run('save', async () => {
      await api(`/api/notes/${editing!.id}`, { method: 'PATCH', body: { body: editing!.body } });
      setEditing(null);
      await after();
    });
  const remove = (n: Note) =>
    confirm('Delete this note?') &&
    run(`del-${n.id}`, async () => {
      await api(`/api/notes/${n.id}`, { method: 'DELETE' });
      await after();
    });
  return (
    <section aria-labelledby="lead-notes">
      <h3 id="lead-notes" style={{ marginBottom: 6 }}>
        Notes
      </h3>
      <div className="stack" style={{ gap: 6 }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={10_000} placeholder="Add a note for your team…" aria-label="New note" />
        <div>
          <Button size="sm" disabled={!text.trim()} busy={busy === 'add'} onClick={add}>
            Add note
          </Button>
        </div>
      </div>
      {notes.data?.map((n) => (
        <div key={n.id} className="note-item">
          <div className="spread">
            <span className="muted" style={{ fontSize: 12.5 }}>
              {n.authorName ?? 'Removed user'} · {dateTime(n.createdAt)}
              {n.updatedAt > n.createdAt && ' · edited'}
            </span>
            {n.canEdit && editing?.id !== n.id && (
              <span className="row" style={{ gap: 4 }}>
                <Button size="sm" variant="ghost" onClick={() => setEditing({ id: n.id, body: n.body })}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" busy={busy === `del-${n.id}`} onClick={() => remove(n)}>
                  Delete
                </Button>
              </span>
            )}
          </div>
          {editing?.id === n.id ? (
            <div className="stack" style={{ gap: 6 }}>
              <textarea value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} rows={3} maxLength={10_000} aria-label="Edit note" />
              <div className="row">
                <Button size="sm" variant="primary" disabled={!editing.body.trim()} busy={busy === 'save'} onClick={save}>
                  Save
                </Button>
                <Button size="sm" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{n.body}</div>
          )}
        </div>
      ))}
    </section>
  );
}

const PAGE = 30;

// Activity, replies, notes, stage changes and tasks in one newest-first list, loaded a page at a time.
function Timeline({ leadId, version }: { leadId: number; version: number }) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = async (before: string | null) => {
    setLoading(true);
    try {
      const r = await api<{ items: TimelineItem[]; nextBefore: string | null }>(`/api/leads/${leadId}/timeline?limit=${PAGE}${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      setItems((cur) => (before ? [...cur, ...r.items] : r.items));
      setNext(r.nextBefore);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load(null).catch(() => {});
    // Reload from the top when the lead changes or something new was added here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId, version]);
  return (
    <section aria-labelledby="lead-timeline">
      <h3 id="lead-timeline" style={{ marginBottom: 6 }}>
        Timeline
      </h3>
      {!loading && !items.length && <p className="muted">Nothing yet.</p>}
      {items.map((i) => (
        <TimelineRow key={`${i.kind}-${i.id}`} item={i} />
      ))}
      {next && (
        <Button size="sm" busy={loading} onClick={() => void load(next)}>
          Load older
        </Button>
      )}
    </section>
  );
}

function TimelineRow({ item: i }: { item: TimelineItem }) {
  let title: React.ReactNode;
  let body: React.ReactNode = null;
  let dot = 'ok';
  switch (i.kind) {
    case 'activity':
      title = (
        <>
          {ACTION_LABELS[i.type as keyof typeof ACTION_LABELS] ?? i.type}
          {i.variant && <span className="muted"> · variant {i.variant}</span>}
          {i.status !== 'ok' && <span className="muted"> ({i.status})</span>}
          {i.campaignName && <span className="muted"> · {i.campaignName}</span>}
        </>
      );
      body = i.detail;
      dot = i.status;
      break;
    case 'message':
      title = (
        <>
          Replied on {CHANNEL_LABELS[i.channel] ?? i.channel}
          {i.category && (
            <span style={{ marginLeft: 6 }}>
              <Pill status={i.category}>{CATEGORY_LABELS[i.category]}</Pill>
            </span>
          )}
        </>
      );
      body = i.body;
      break;
    case 'note':
      title = <>Note by {i.authorName ?? 'a removed user'}</>;
      body = i.body;
      dot = 'kind-note';
      break;
    case 'stage':
      title = (
        <>
          Stage: {i.fromName ?? 'deleted stage'} → {i.toName ?? 'deleted stage'}
          <span className="muted"> · {i.source === 'auto' ? 'automatic' : i.userName ? `by ${i.userName}` : 'by hand'}</span>
        </>
      );
      body = i.reason;
      dot = 'kind-stage';
      break;
    case 'task':
      title = (
        <>
          {TASK_KIND_LABELS[i.taskKind] ?? 'Task'}: {i.title}
          <span className="muted">
            {' '}
            · {i.status === 'open' ? `due ${dateTime(i.dueAt)}` : i.status}
            {i.outcome && ` · ${OUTCOME_LABELS[i.outcome] ?? i.outcome}`}
            {i.assigneeName && ` · ${i.assigneeName}`}
          </span>
        </>
      );
      break;
  }
  return (
    <div className="feed-item">
      <span className={`feed-dot ${dot}`} aria-hidden />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="spread">
          <strong>{title}</strong>
          <span className="muted" style={{ fontSize: 12.5, flex: 'none' }}>
            {dateTime(i.at)}
          </span>
        </div>
        {body && <div style={{ whiteSpace: 'pre-wrap', color: 'var(--ink-2)', fontSize: 13 }}>{body}</div>}
      </div>
    </div>
  );
}

// The lead's records in each connected CRM, and a button to send it there now. Hidden without a CRM.
function CrmPanel({ leadId }: { leadId: number }) {
  const info = useApi<CrmLeadInfo>(`/api/crm/leads/${leadId}`);
  const [pushed, setPushed] = useState<number[]>([]);
  const { busy, run } = useAction();
  const d = info.data;
  if (!d || (!d.crms.length && !d.links.length)) return null;
  const push = (crm: CrmLeadInfo['crms'][number]) =>
    run(
      `crm${crm.id}`,
      async () => {
        await api('/api/crm/push', { body: { integrationId: crm.id, leadIds: [leadId] } });
        setPushed((p) => [...p, crm.id]);
        // The sync runs in the background; look again shortly for the new record.
        setTimeout(() => void info.reload(), 3000);
      },
      `Sending to ${crm.label}`,
    );
  return (
    <section aria-labelledby="lead-crm">
      <h3 id="lead-crm" style={{ marginBottom: 6 }}>
        CRM
      </h3>
      {d.links.length ? (
        <dl className="facts">
          {d.links.map((k) => (
            <div key={`${k.integrationId}:${k.objectType}`}>
              <dt>
                {k.integration} {k.objectType}
              </dt>
              <dd>
                {k.url ? (
                  <a href={k.url} target="_blank" rel="noreferrer">
                    {k.externalId}
                  </a>
                ) : (
                  k.externalId
                )}{' '}
                <span className="muted">· synced {timeAgo(k.syncedAt)}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          Not in a CRM yet.
        </p>
      )}
      {!!d.crms.length && (
        <div className="row" style={{ marginTop: 8 }}>
          {d.crms.map((c) => (
            <Button key={c.id} size="sm" busy={busy === `crm${c.id}`} disabled={pushed.includes(c.id)} onClick={() => push(c)}>
              {pushed.includes(c.id) ? `Sent to ${c.label}` : `Push to ${c.label}`}
              <ProviderBadge simulated={c.simulated} />
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}

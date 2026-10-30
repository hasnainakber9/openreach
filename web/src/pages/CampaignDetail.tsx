import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, useApi, type Account, type Campaign, type LeadList, type Sequence } from '../api';
import { Funnel, LineChart } from '../components/LineChart';
import { SequenceBuilder, summary } from '../components/SequenceBuilder';
import { Button, Empty, Field, Pager, Pill, Stat, Tabs, Toggle, useAction } from '../components/ui';
import { ACTION_LABELS, CONDITION_LABELS, fullName, pct, timeAgo } from '../format';

type Tab = 'sequence' | 'leads' | 'results' | 'settings';

export default function CampaignDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const campaign = useApi<Campaign>(`/api/campaigns/${id}`, 15_000);
  const [tab, setTab] = useState<Tab>('sequence');
  const [draft, setDraft] = useState<Sequence | null>(null);
  const { busy, run } = useAction();
  const c = campaign.data;

  useEffect(() => {
    if (c?.sequence && !draft) setDraft(c.sequence);
  }, [c, draft]);

  if (campaign.error) return <Empty title="Campaign not found" action={<Link to="/campaigns">Back to campaigns</Link>} />;
  if (!c || !draft) return null;

  const dirty = JSON.stringify(draft) !== JSON.stringify(c.sequence);
  const save = () =>
    run(
      'save',
      async () => {
        const updated = await api<Campaign>(`/api/campaigns/${c.id}`, { method: 'PATCH', body: { sequence: draft } });
        campaign.setData(updated);
        setDraft(updated.sequence!);
      },
      'Sequence saved',
    );
  const toggle = () =>
    run('toggle', async () => {
      if (dirty) await api(`/api/campaigns/${c.id}`, { method: 'PATCH', body: { sequence: draft } });
      await api(`/api/campaigns/${c.id}/${c.status === 'active' ? 'pause' : 'start'}`, { body: {} });
      await campaign.reload();
    });

  return (
    <>
      <div className="page-head">
        <div>
          <div className="row">
            <Link to="/campaigns" className="muted">
              Campaigns
            </Link>
            <span className="muted">/</span>
          </div>
          <div className="row" style={{ marginTop: 4 }}>
            <h1>{c.name}</h1>
            <Pill status={c.status} />
          </div>
          <p>
            {c.account ? (
              <>
                Runs from <strong>{c.account.name}</strong>
                {c.account.status !== 'active' && <> · account is {c.account.status.replace('_', ' ')}</>}
              </>
            ) : (
              'No LinkedIn account selected'
            )}
            {' · '}
            {c.stats.total} leads
          </p>
        </div>
        <div className="row">
          {dirty && (
            <Button busy={busy === 'save'} onClick={save}>
              Save changes
            </Button>
          )}
          <Button variant={c.status === 'active' ? 'default' : 'primary'} busy={busy === 'toggle'} onClick={toggle}>
            {c.status === 'active' ? 'Pause campaign' : c.status === 'draft' ? 'Launch campaign' : 'Resume campaign'}
          </Button>
        </div>
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'sequence', label: `Sequence${dirty ? ' •' : ''}` },
          { id: 'leads', label: `Leads (${c.stats.total})` },
          { id: 'results', label: 'Results' },
          { id: 'settings', label: 'Settings' },
        ]}
      />

      {tab === 'sequence' && (
        <div className="stack">
          {!!c.problems?.length && !dirty && (
            <div className="note note-error">
              {c.problems.map((p) => (
                <div key={p}>{p}</div>
              ))}
            </div>
          )}
          {!!c.warnings?.length && !dirty && (
            <div className="note note-warning">
              {c.warnings.map((p) => (
                <div key={p}>{p}</div>
              ))}
            </div>
          )}
          <SequenceBuilder value={draft} onChange={setDraft} counts={c.stats.atNode} />
        </div>
      )}
      {tab === 'leads' && <CampaignLeads campaign={c} onChange={campaign.reload} />}
      {tab === 'results' && <Results campaign={c} />}
      {tab === 'settings' && <CampaignSettingsTab campaign={c} onSaved={campaign.reload} onDeleted={() => nav('/campaigns')} />}
    </>
  );
}

function stepLabel(seq: Sequence | undefined, nodeId: string | null) {
  const n = nodeId && seq?.nodes[nodeId];
  if (!n) return '—';
  return n.type === 'condition' ? CONDITION_LABELS[n.kind] + '?' : n.type === 'wait' ? `Wait ${summary(n)}` : ACTION_LABELS[n.type];
}

function CampaignLeads({ campaign, onChange }: { campaign: Campaign; onChange: () => void }) {
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const leads = useApi<{ total: number; items: any[] }>(`/api/campaigns/${campaign.id}/leads?page=${page}&pageSize=50${state ? `&state=${state}` : ''}`, 15_000);
  const lists = useApi<LeadList[]>('/api/lists');
  const [listId, setListId] = useState<number | ''>('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const { busy, run } = useAction();

  const add = () =>
    run('add', async () => {
      const r = await api(`/api/campaigns/${campaign.id}/leads`, { body: { listId: Number(listId) } });
      const skipped = [
        r.alreadyInCampaign && `${r.alreadyInCampaign} already here`,
        r.inOtherCampaign && `${r.inOtherCampaign} in another campaign`,
        r.blacklisted && `${r.blacklisted} blacklisted`,
        r.alreadyConnected && `${r.alreadyConnected} already connected`,
      ].filter(Boolean);
      alert(`Added ${r.added} lead${r.added === 1 ? '' : 's'}.${skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''}`);
      await leads.reload();
      onChange();
    });

  const remove = () =>
    run('remove', async () => {
      await api(`/api/campaigns/${campaign.id}/leads/remove`, { body: { leadIds: [...selected] } });
      setSelected(new Set());
      await leads.reload();
      onChange();
    });

  return (
    <div className="stack">
      <div className="card">
        <div className="spread" style={{ flexWrap: 'wrap' }}>
          <div className="row">
            <select value={listId} onChange={(e) => setListId(e.target.value ? Number(e.target.value) : '')} style={{ width: 260 }} aria-label="Lead list">
              <option value="">Choose a lead list…</option>
              {lists.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.leads})
                </option>
              ))}
            </select>
            <Button variant="primary" disabled={!listId} busy={busy === 'add'} onClick={add}>
              Add leads
            </Button>
            <Link to="/leads" className="muted">
              Import leads
            </Link>
          </div>
          <div className="row">
            {!!selected.size && (
              <Button variant="danger" busy={busy === 'remove'} onClick={remove}>
                Remove {selected.size}
              </Button>
            )}
            <select value={state} onChange={(e) => (setState(e.target.value), setPage(1))} style={{ width: 160 }} aria-label="Filter by state">
              <option value="">All states</option>
              <option value="active">In progress</option>
              <option value="done">Finished</option>
              <option value="replied">Replied</option>
              <option value="failed">Failed</option>
              <option value="skipped">Skipped</option>
            </select>
          </div>
        </div>
      </div>
      <div className="card card-flush">
        {leads.data && !leads.data.total ? (
          <Empty title="No leads in this campaign">Pick a lead list above to add people. Duplicates, blacklisted people and leads busy in other campaigns are skipped automatically.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 32 }} />
                  <th>Lead</th>
                  <th>State</th>
                  <th>Current step</th>
                  <th>Next</th>
                  <th>Connection</th>
                </tr>
              </thead>
              <tbody>
                {leads.data?.items.map((r) => (
                  <tr key={r.lead.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${fullName(r.lead)}`}
                        checked={selected.has(r.lead.id)}
                        onChange={(e) => {
                          const s = new Set(selected);
                          e.target.checked ? s.add(r.lead.id) : s.delete(r.lead.id);
                          setSelected(s);
                        }}
                      />
                    </td>
                    <td>
                      <a href={r.lead.profileUrl} target="_blank" rel="noreferrer" className="cell-title">
                        {fullName(r.lead)}
                      </a>
                      <div className="cell-sub">{r.lead.headline || r.lead.company}</div>
                    </td>
                    <td>
                      <Pill status={r.state === 'active' ? 'running' : r.state}>{r.state === 'active' ? 'In progress' : undefined}</Pill>
                    </td>
                    <td>
                      {r.state === 'active' ? stepLabel(campaign.sequence, r.nodeId) : '—'}
                      {r.lastError && <div className="cell-sub" style={{ color: 'var(--critical-text)' }}>{r.lastError}</div>}
                    </td>
                    <td className="muted">{r.state === 'active' ? timeAgo(r.nextRunAt) : '—'}</td>
                    <td>
                      <Pill status={r.lead.connectionStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {leads.data && <Pager page={page} pageSize={50} total={leads.data.total} onPage={setPage} />}
      </div>
    </div>
  );
}

function Results({ campaign }: { campaign: Campaign }) {
  const analytics = useApi<any>(`/api/analytics?days=30&campaignId=${campaign.id}`, 20_000);
  const feed = useApi<any[]>(`/api/activity?limit=40&campaignId=${campaign.id}`, 10_000);
  const s = campaign.stats;
  return (
    <div className="stack">
      <div className="grid grid-4">
        <Stat label="Leads" value={s.total} sub={`${s.active} in progress`} />
        <Stat label="Invites sent" value={s.funnel.invited} sub={`${s.funnel.viewed} profiles viewed`} />
        <Stat label="Acceptance rate" value={pct(s.acceptanceRate)} sub={`${s.funnel.accepted} accepted`} />
        <Stat label="Reply rate" value={pct(s.replyRate)} sub={`${s.funnel.replied} replied`} />
      </div>
      <div className="grid grid-main-side">
        <div className="card">
          <h2 style={{ marginBottom: 12 }}>Last 30 days</h2>
          {analytics.data && (
            <LineChart
              data={analytics.data.series}
              xKey="day"
              series={[
                { key: 'connect', label: 'Invites sent', color: 'var(--series-1)' },
                { key: 'accepted', label: 'Accepted', color: 'var(--series-2)' },
                { key: 'message', label: 'Messages', color: 'var(--series-3)' },
                { key: 'replied', label: 'Replies', color: 'var(--series-4)' },
              ]}
              formatX={(d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            />
          )}
        </div>
        <div className="card">
          <h2 style={{ marginBottom: 12 }}>Funnel</h2>
          <Funnel
            stages={[
              { label: 'Leads', value: s.total },
              { label: 'Invited', value: s.funnel.invited },
              { label: 'Accepted', value: s.funnel.accepted, note: pct(s.acceptanceRate) },
              { label: 'Messaged', value: s.funnel.messaged },
              { label: 'Replied', value: s.funnel.replied, note: pct(s.replyRate) },
            ]}
          />
        </div>
      </div>
      <div className="card">
        <h2 style={{ marginBottom: 8 }}>Activity</h2>
        {!feed.data?.length && <p className="muted">Nothing has happened in this campaign yet.</p>}
        {feed.data?.map((f) => (
          <div className="feed-item" key={f.id}>
            <span className={`feed-dot ${f.status}`} aria-hidden />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="spread">
                <span>
                  <strong>{ACTION_LABELS[f.type as keyof typeof ACTION_LABELS] ?? f.type}</strong> · {f.leadName}
                  {f.status !== 'ok' && <span className="muted"> ({f.status})</span>}
                </span>
                <span className="muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                  {timeAgo(f.createdAt)}
                </span>
              </div>
              {f.detail && <div className="cell-sub" style={{ maxWidth: '100%' }}>{f.detail}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CampaignSettingsTab({ campaign, onSaved, onDeleted }: { campaign: Campaign; onSaved: () => void; onDeleted: () => void }) {
  const accounts = useApi<Account[]>('/api/accounts');
  const [form, setForm] = useState({ name: campaign.name, accountId: campaign.accountId, ...campaign.settings });
  const { busy, run } = useAction();
  const nav = useNavigate();

  const save = () =>
    run(
      'save',
      async () => {
        const { name, accountId, ...settings } = form;
        await api(`/api/campaigns/${campaign.id}`, { method: 'PATCH', body: { name, accountId, settings } });
        onSaved();
      },
      'Settings saved',
    );

  return (
    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <div className="card stack">
        <Field label="Campaign name">
          <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="LinkedIn account" hint={campaign.status === 'active' ? 'Pause the campaign to switch accounts.' : undefined}>
          <select value={form.accountId ?? ''} disabled={campaign.status === 'active'} onChange={(e) => setForm({ ...form, accountId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">None</option>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Toggle checked={form.stopOnReply} onChange={(v) => setForm({ ...form, stopOnReply: v })} label="Stop when a lead replies" hint="Recommended. Replies are picked up from the LinkedIn inbox." />
        <Toggle checked={form.skipIfInOtherCampaign} onChange={(v) => setForm({ ...form, skipIfInOtherCampaign: v })} label="Skip leads already running in another campaign" />
        <Toggle checked={form.skipAlreadyConnected} onChange={(v) => setForm({ ...form, skipAlreadyConnected: v })} label="Skip people you're already connected to" />
        <Field label="Invitation note limit" hint="300 for most accounts. Use 200 for free accounts that get cut off.">
          <select value={form.noteLimit} onChange={(e) => setForm({ ...form, noteLimit: Number(e.target.value) })}>
            <option value={300}>300 characters</option>
            <option value={200}>200 characters</option>
          </select>
        </Field>
        <div>
          <Button variant="primary" busy={busy === 'save'} onClick={save}>
            Save settings
          </Button>
        </div>
      </div>
      <div className="card stack">
        <h2>Manage</h2>
        <div className="row">
          <Button
            busy={busy === 'dup'}
            onClick={() =>
              run('dup', async () => {
                const r = await api(`/api/campaigns/${campaign.id}/duplicate`, { body: {} });
                nav(`/campaigns/${r.id}`);
              })
            }
          >
            Duplicate campaign
          </Button>
          <a className="btn" href={`/api/leads/export.csv?campaignId=${campaign.id}`}>
            Export leads (CSV)
          </a>
        </div>
        <hr style={{ border: 'none', borderTop: '1px solid var(--line)', width: '100%' }} />
        <p className="muted" style={{ margin: 0 }}>
          Deleting removes the campaign and its progress. Leads and the activity history stay.
        </p>
        <div>
          <Button
            variant="danger"
            busy={busy === 'del'}
            onClick={() =>
              confirm(`Delete "${campaign.name}"?`) &&
              run('del', async () => {
                await api(`/api/campaigns/${campaign.id}`, { method: 'DELETE' });
                onDeleted();
              })
            }
          >
            Delete campaign
          </Button>
        </div>
      </div>
    </div>
  );
}

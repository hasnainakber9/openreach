import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi, type Account, type Campaign, type Lead, type LeadList } from '../api';
import { Button, Empty, ErrorNote, Field, Modal, Pager, Pill, Tabs, useAction, useToast } from '../components/ui';
import { ACTION_LABELS, dateTime, fullName, timeAgo } from '../format';

export default function Leads() {
  const lists = useApi<LeadList[]>('/api/lists', 15_000);
  const [listId, setListId] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [newList, setNewList] = useState(false);
  const [toCampaign, setToCampaign] = useState(false);
  const [openLead, setOpenLead] = useState<number | null>(null);
  const { busy, run } = useAction();

  useEffect(() => {
    const t = setTimeout(() => (setQuery(q), setPage(1)), 300);
    return () => clearTimeout(t);
  }, [q]);

  const params = new URLSearchParams({ page: String(page), pageSize: '50' });
  if (listId) params.set('listId', String(listId));
  if (query) params.set('q', query);
  if (status) params.set('status', status);
  const leads = useApi<{ total: number; items: Lead[] }>(`/api/leads?${params}`, 20_000);
  const current = lists.data?.find((l) => l.id === listId);

  const remove = () =>
    confirm(`Delete ${selected.size} lead${selected.size === 1 ? '' : 's'}? This also removes them from campaigns.`) &&
    run('del', async () => {
      await api('/api/leads/delete', { body: { ids: [...selected] } });
      setSelected(new Set());
      await Promise.all([leads.reload(), lists.reload()]);
    });

  const allOnPage = !!leads.data?.items.length && leads.data.items.every((l) => selected.has(l.id));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <p>People to reach, organised in lists. Import from CSV or straight from a LinkedIn search.</p>
        </div>
        <div className="row">
          <a className="btn" href={`/api/leads/export.csv?${listId ? `listId=${listId}` : ''}`}>
            Export CSV
          </a>
          <Button variant="primary" onClick={() => setImporting(true)}>
            Import leads
          </Button>
        </div>
      </div>

      <div className="grid grid-side-main">
        <div className="card" style={{ padding: 8 }}>
          <nav className="nav">
            <a href="#" className={listId === null ? 'active' : ''} onClick={(e) => (e.preventDefault(), setListId(null), setPage(1))}>
              All leads
            </a>
            {lists.data?.map((l) => (
              <a key={l.id} href="#" className={listId === l.id ? 'active' : ''} onClick={(e) => (e.preventDefault(), setListId(l.id), setPage(1))}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
                <span className="muted num" style={{ marginLeft: 'auto', fontSize: 12 }}>
                  {l.leads}
                </span>
              </a>
            ))}
          </nav>
          <Button size="sm" variant="ghost" onClick={() => setNewList(true)} style={{ marginTop: 6 }}>
            + New list
          </Button>
        </div>

        <div className="stack">
          <div className="card" style={{ padding: 12 }}>
            <div className="spread" style={{ flexWrap: 'wrap' }}>
              <div className="row" style={{ flex: 1 }}>
                <input type="search" placeholder="Search name, company, headline, email" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} aria-label="Search leads" />
                <select value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))} style={{ width: 170 }} aria-label="Connection status">
                  <option value="">Any connection</option>
                  <option value="connected">Connected</option>
                  <option value="pending">Invite pending</option>
                  <option value="none">Not connected</option>
                </select>
              </div>
              <div className="row">
                {!!selected.size && (
                  <>
                    <span className="muted">{selected.size} selected</span>
                    <Button size="sm" onClick={() => setToCampaign(true)}>
                      Add to campaign
                    </Button>
                    <Button size="sm" variant="danger" busy={busy === 'del'} onClick={remove}>
                      Delete
                    </Button>
                  </>
                )}
                {current && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      confirm(`Delete the list "${current.name}" and its ${current.leads} leads?`) &&
                      run('dl', async () => {
                        await api(`/api/lists/${current.id}`, { method: 'DELETE' });
                        setListId(null);
                        await Promise.all([lists.reload(), leads.reload()]);
                      })
                    }
                  >
                    Delete list
                  </Button>
                )}
              </div>
            </div>
          </div>

          <div className="card card-flush">
            {leads.data && !leads.data.total ? (
              <Empty title={query || status ? 'No matching leads' : 'No leads yet'} action={!query && !status && <Button variant="primary" onClick={() => setImporting(true)}>Import leads</Button>}>
                {!query && !status && 'Upload a CSV with LinkedIn profile URLs, or paste a LinkedIn / Sales Navigator search to collect people automatically.'}
              </Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}>
                        <input
                          type="checkbox"
                          aria-label="Select all on this page"
                          checked={allOnPage}
                          onChange={(e) => {
                            const s = new Set(selected);
                            leads.data?.items.forEach((l) => (e.target.checked ? s.add(l.id) : s.delete(l.id)));
                            setSelected(s);
                          }}
                        />
                      </th>
                      <th>Name</th>
                      <th>Company</th>
                      <th>Connection</th>
                      <th>Campaign</th>
                      <th>Added</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.data?.items.map((l) => (
                      <tr key={l.id} className="clickable" onClick={() => setOpenLead(l.id)}>
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${fullName(l)}`}
                            checked={selected.has(l.id)}
                            onChange={(e) => {
                              const s = new Set(selected);
                              e.target.checked ? s.add(l.id) : s.delete(l.id);
                              setSelected(s);
                            }}
                          />
                        </td>
                        <td>
                          <div className="cell-title">{fullName(l)}</div>
                          <div className="cell-sub">{l.headline || l.title || l.profileUrl}</div>
                        </td>
                        <td>
                          {l.company || <span className="muted">—</span>}
                          {l.email && <div className="cell-sub">{l.email}</div>}
                        </td>
                        <td>
                          <Pill status={l.connectionStatus} />
                          {l.repliedAt && (
                            <span style={{ marginLeft: 6 }}>
                              <Pill status="replied" />
                            </span>
                          )}
                        </td>
                        <td>{l.campaigns?.length ? l.campaigns.map((c) => c.name).join(', ') : <span className="muted">—</span>}</td>
                        <td className="muted">{timeAgo(l.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {leads.data && <Pager page={page} pageSize={50} total={leads.data.total} onPage={setPage} />}
          </div>
        </div>
      </div>

      {importing && (
        <ImportModal
          lists={lists.data ?? []}
          defaultListId={listId}
          onClose={() => setImporting(false)}
          onDone={(id) => {
            setImporting(false);
            setListId(id);
            void lists.reload();
            void leads.reload();
          }}
        />
      )}
      {newList && (
        <NewListModal
          onClose={() => setNewList(false)}
          onCreated={(id) => {
            setNewList(false);
            setListId(id);
            void lists.reload();
          }}
        />
      )}
      {toCampaign && <AddToCampaign leadIds={[...selected]} onClose={() => setToCampaign(false)} onDone={() => (setToCampaign(false), setSelected(new Set()), leads.reload())} />}
      {openLead && <LeadDrawer id={openLead} onClose={() => setOpenLead(null)} onChanged={() => leads.reload()} />}
    </>
  );
}

function NewListModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [name, setName] = useState('');
  const { busy, run } = useAction();
  const create = () => run('c', async () => onCreated((await api('/api/lists', { body: { name } })).id));
  return (
    <Modal title="New lead list" onClose={onClose} footer={<Button variant="primary" disabled={!name.trim()} busy={busy === 'c'} onClick={create}>Create list</Button>}>
      <Field label="Name">
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && name.trim() && create()} />
      </Field>
    </Modal>
  );
}

function ImportModal({ lists, defaultListId, onClose, onDone }: { lists: LeadList[]; defaultListId: number | null; onClose: () => void; onDone: (listId: number) => void }) {
  const [tab, setTab] = useState<'csv' | 'search' | 'single'>('csv');
  const accounts = useApi<Account[]>('/api/accounts');
  const imports = useApi<any[]>('/api/imports', 3000);
  const [listId, setListId] = useState<number | 'new'>(defaultListId ?? lists[0]?.id ?? 'new');
  const [listName, setListName] = useState('');
  const [file, setFile] = useState<{ name: string; text: string; rows: number } | null>(null);
  const [url, setUrl] = useState('');
  const [limit, setLimit] = useState(100);
  const [accountId, setAccountId] = useState<number | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [single, setSingle] = useState({ profileUrl: '', firstName: '', lastName: '', company: '', email: '' });
  const toast = useToast();
  const { busy, run } = useAction();
  const acc = accountId || accounts.data?.find((a) => a.status === 'active')?.id || accounts.data?.[0]?.id || '';

  const targetList = async () => {
    if (listId !== 'new') return listId;
    const name = listName.trim() || (tab === 'csv' && file ? file.name.replace(/\.csv$/i, '') : `Import ${new Date().toLocaleDateString()}`);
    return (await api('/api/lists', { body: { name } })).id as number;
  };

  const submit = () =>
    run('go', async () => {
      setError(null);
      try {
        const id = await targetList();
        if (tab === 'csv') {
          const r = await api('/api/leads/import/csv', { body: { listId: id, csv: file!.text } });
          toast(`Imported ${r.added} of ${r.rows} rows${r.duplicates ? ` · ${r.duplicates} already in your leads` : ''}${r.invalid ? ` · ${r.invalid} without a LinkedIn URL` : ''}`);
          onDone(id);
        } else if (tab === 'search') {
          await api('/api/leads/import/search', { body: { listId: id, accountId: Number(acc), url, limit } });
          toast('Collecting leads in the background. Progress is shown below.');
          await imports.reload();
          setListId(id);
        } else {
          await api('/api/leads', { body: { listId: id, ...single, email: single.email || null } });
          toast('Lead added');
          onDone(id);
        }
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const ready = tab === 'csv' ? !!file : tab === 'search' ? !!url && !!acc : !!single.profileUrl;

  return (
    <Modal
      title="Import leads"
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" disabled={!ready} busy={busy === 'go'} onClick={submit}>
            {tab === 'search' ? 'Start collecting' : 'Import'}
          </Button>
        </>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'csv', label: 'CSV file' },
          { id: 'search', label: 'LinkedIn search' },
          { id: 'single', label: 'Single profile' },
        ]}
      />
      <div className="grid grid-2">
        <Field label="Add to list">
          <select value={listId} onChange={(e) => setListId(e.target.value === 'new' ? 'new' : Number(e.target.value))}>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
            <option value="new">+ New list</option>
          </select>
        </Field>
        {listId === 'new' && (
          <Field label="New list name">
            <input type="text" value={listName} onChange={(e) => setListName(e.target.value)} placeholder="Optional" />
          </Field>
        )}
      </div>

      {tab === 'csv' && (
        <>
          <Field label="CSV file" hint="Needs a column with LinkedIn profile URLs. Columns like First Name, Last Name, Company, Title, Email are recognised; any other column becomes a custom variable for your messages.">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return setFile(null);
                const text = await f.text();
                setFile({ name: f.name, text, rows: Math.max(0, text.trim().split(/\r?\n/).length - 1) });
              }}
            />
          </Field>
          {file && <div className="note">{file.name}: about {file.rows} rows</div>}
        </>
      )}

      {tab === 'search' && (
        <>
          <Field label="Search URL" hint="Run a people search on LinkedIn or Sales Navigator with your filters, then copy the address bar here.">
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.linkedin.com/search/results/people/?keywords=…" />
          </Field>
          <div className="grid grid-2">
            <Field label="Use account">
              <select value={acc} onChange={(e) => setAccountId(Number(e.target.value))}>
                {accounts.data?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Maximum leads" hint="LinkedIn shows up to 1,000 results per search.">
              <input type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
            </Field>
          </div>
          {!!imports.data?.length && (
            <div>
              <div className="field-label" style={{ marginBottom: 6 }}>
                Recent search imports
              </div>
              {imports.data.slice(0, 5).map((i) => (
                <div key={i.id} className="spread" style={{ fontSize: 13, padding: '4px 0' }}>
                  <span className="cell-sub" style={{ maxWidth: 420 }}>
                    {i.listName} · {i.source}
                  </span>
                  <span>
                    <Pill status={i.status === 'done' ? 'done' : i.status === 'failed' ? 'failed' : 'running'}>{i.status === 'running' ? `${i.found} found…` : i.status === 'done' ? `${i.added} added` : 'Failed'}</Pill>
                  </span>
                </div>
              ))}
              {imports.data.find((i) => i.status === 'failed')?.error && <div className="field-error">{imports.data.find((i) => i.status === 'failed').error}</div>}
            </div>
          )}
        </>
      )}

      {tab === 'single' && (
        <div className="grid grid-2">
          <Field label="LinkedIn profile URL">
            <input type="url" value={single.profileUrl} onChange={(e) => setSingle({ ...single, profileUrl: e.target.value })} placeholder="https://www.linkedin.com/in/…" />
          </Field>
          <Field label="Email (optional)">
            <input type="email" value={single.email} onChange={(e) => setSingle({ ...single, email: e.target.value })} />
          </Field>
          <Field label="First name">
            <input type="text" value={single.firstName} onChange={(e) => setSingle({ ...single, firstName: e.target.value })} />
          </Field>
          <Field label="Last name">
            <input type="text" value={single.lastName} onChange={(e) => setSingle({ ...single, lastName: e.target.value })} />
          </Field>
          <Field label="Company">
            <input type="text" value={single.company} onChange={(e) => setSingle({ ...single, company: e.target.value })} />
          </Field>
        </div>
      )}
      <ErrorNote error={error} />
    </Modal>
  );
}

function AddToCampaign({ leadIds, onClose, onDone }: { leadIds: number[]; onClose: () => void; onDone: () => void }) {
  const campaigns = useApi<Campaign[]>('/api/campaigns');
  const [cid, setCid] = useState<number | ''>('');
  const toast = useToast();
  const { busy, run } = useAction();
  const chosen = cid || campaigns.data?.[0]?.id || '';
  const add = () =>
    run('add', async () => {
      const r = await api(`/api/campaigns/${chosen}/leads`, { body: { leadIds } });
      toast(`Added ${r.added}; skipped ${leadIds.length - r.added}`);
      onDone();
    });
  return (
    <Modal title={`Add ${leadIds.length} lead${leadIds.length === 1 ? '' : 's'} to a campaign`} onClose={onClose} footer={<Button variant="primary" disabled={!chosen} busy={busy === 'add'} onClick={add}>Add</Button>}>
      {campaigns.data && !campaigns.data.length ? (
        <p>
          No campaigns yet. <Link to="/campaigns">Create one first.</Link>
        </p>
      ) : (
        <Field label="Campaign">
          <select value={chosen} onChange={(e) => setCid(Number(e.target.value))}>
            {campaigns.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
    </Modal>
  );
}

function LeadDrawer({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const lead = useApi<Lead & { activity: any[]; campaigns: any[] }>(`/api/leads/${id}`);
  const [edit, setEdit] = useState<Partial<Lead> | null>(null);
  const { busy, run } = useAction();
  const l = lead.data;
  if (!l) return null;
  const save = () =>
    run(
      'save',
      async () => {
        await api(`/api/leads/${id}`, { method: 'PATCH', body: edit });
        setEdit(null);
        await lead.reload();
        onChanged();
      },
      'Lead updated',
    );
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
        <Pill status={l.connectionStatus} />
      </div>
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
      <div>
        <h3 style={{ marginBottom: 6 }}>Timeline</h3>
        {!l.activity.length && <p className="muted">No activity yet.</p>}
        {l.activity.map((a: any) => (
          <div className="feed-item" key={a.id}>
            <span className={`feed-dot ${a.status}`} aria-hidden />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="spread">
                <strong>
                  {ACTION_LABELS[a.type as keyof typeof ACTION_LABELS] ?? a.type}
                  {a.status !== 'ok' && <span className="muted"> ({a.status})</span>}
                </strong>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {dateTime(a.createdAt)}
                </span>
              </div>
              {a.detail && <div style={{ whiteSpace: 'pre-wrap', color: 'var(--ink-2)', fontSize: 13 }}>{a.detail}</div>}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi, type Account, type Campaign, type EnrichmentRun, type EnrichmentSettings, type EnrichOptions, type ImportKind, type KindStatus, type Lead, type LeadImport, type LeadList, type ProviderKind } from '../api';
import { Button, Empty, ErrorNote, Field, Modal, Pager, Pill, ProgressBar, Tabs, Toggle, useAction, useToast } from '../components/ui';
import { ACTION_LABELS, dateTime, EMAIL_STATUS_LABELS, emailSourceLabel, ENRICHMENT_STATUS_LABELS, fullName, IMPORT_KIND_LABELS, timeAgo } from '../format';

export default function Leads() {
  const lists = useApi<LeadList[]>('/api/lists', 15_000);
  const [listId, setListId] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [emailStatus, setEmailStatus] = useState('');
  const [enrichment, setEnrichment] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [newList, setNewList] = useState(false);
  const [toCampaign, setToCampaign] = useState(false);
  const [enriching, setEnriching] = useState<EnrichTarget | null>(null);
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
  if (emailStatus) params.set('emailStatus', emailStatus);
  if (enrichment) params.set('enrichment', enrichment);
  const filtered = !!(query || status || emailStatus || enrichment);
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
          <p>People to reach, organised in lists. Import from CSV or straight from LinkedIn: searches, post reactions and comments, events and groups.</p>
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
                <select value={emailStatus} onChange={(e) => (setEmailStatus(e.target.value), setPage(1))} style={{ width: 150 }} aria-label="Email status">
                  <option value="">Any email</option>
                  <option value="valid">Valid email</option>
                  <option value="risky">Risky email</option>
                  <option value="unknown">Unverified email</option>
                  <option value="invalid">Invalid email</option>
                  <option value="missing">No email</option>
                </select>
                <select value={enrichment} onChange={(e) => (setEnrichment(e.target.value), setPage(1))} style={{ width: 160 }} aria-label="Email lookup">
                  <option value="">Any lookup</option>
                  <option value="none">Not looked up</option>
                  <option value="queued">Looking up</option>
                  <option value="done">Enriched</option>
                  <option value="not_found">Nothing found</option>
                  <option value="failed">Lookup failed</option>
                </select>
              </div>
              <div className="row">
                {!!selected.size && (
                  <>
                    <span className="muted">{selected.size} selected</span>
                    <Button size="sm" onClick={() => setToCampaign(true)}>
                      Add to campaign
                    </Button>
                    <Button size="sm" onClick={() => setEnriching({ leadIds: [...selected] })}>
                      Find & verify emails
                    </Button>
                    <Button size="sm" variant="danger" busy={busy === 'del'} onClick={remove}>
                      Delete
                    </Button>
                  </>
                )}
                {current && !selected.size && !!current.leads && (
                  <Button size="sm" onClick={() => setEnriching({ listId: current.id, name: current.name, count: current.leads })}>
                    Find & verify list emails
                  </Button>
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
              <Empty title={filtered ? 'No matching leads' : 'No leads yet'} action={!filtered && <Button variant="primary" onClick={() => setImporting(true)}>Import leads</Button>}>
                {!filtered && 'Upload a CSV with LinkedIn profile URLs, or paste a LinkedIn / Sales Navigator search to collect people automatically.'}
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
                      <th>Email</th>
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
                          {l.companyDomain && <div className="cell-sub">{l.companyDomain}</div>}
                        </td>
                        <td>
                          <EmailCell lead={l} />
                        </td>
                        <td>
                          <Pill status={l.connectionStatus} />
                          {l.repliedAt && (
                            <span style={{ marginLeft: 6 }}>
                              {/* What the latest reply meant, once classified. */}
                              <Pill status={l.replyCategory && l.replyCategory !== 'other' ? l.replyCategory : 'replied'} />
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
      {enriching && (
        <EnrichModal
          target={enriching}
          onClose={() => setEnriching(null)}
          onFinished={() => {
            setSelected(new Set());
            void leads.reload();
          }}
        />
      )}
      {toCampaign && <AddToCampaign leadIds={[...selected]} onClose={() => setToCampaign(false)} onDone={() => (setToCampaign(false), setSelected(new Set()), leads.reload())} />}
      {openLead && <LeadDrawer id={openLead} onClose={() => setOpenLead(null)} onChanged={() => leads.reload()} />}
    </>
  );
}

// The lead's email with its verification status; where it came from and the verifier's reason show on hover.
function EmailCell({ lead: l }: { lead: Lead }) {
  const queued = l.enrichmentStatus === 'queued' && <Pill status="queued">{ENRICHMENT_STATUS_LABELS.queued}</Pill>;
  if (!l.email) return queued || <span className="muted">{l.enrichmentStatus === 'not_found' ? 'Not found' : '—'}</span>;
  const tip = [emailSourceLabel(l.emailSource), l.emailStatusReason].filter(Boolean).join(' · ');
  return (
    <div title={tip}>
      <div style={{ fontSize: 13 }}>{l.email}</div>
      {queued || <Pill status={l.emailStatus ?? 'unknown'}>{EMAIL_STATUS_LABELS[l.emailStatus ?? 'unknown']}</Pill>}
    </div>
  );
}

// Company facts an enrichment provider may add, in display order.
const COMPANY_FACTS: Record<string, string> = { industry: 'Industry', companySize: 'Employees', website: 'Website', companyLinkedin: 'Company LinkedIn', foundedYear: 'Founded', seniority: 'Seniority' };

type EnrichTarget ={ leadIds: number[] } | { listId: number; name: string; count: number };

// Kinds whose built-in simulator is in use, so the modal can say what that means.
function useSimulatedData() {
  const status = useApi<Record<ProviderKind, KindStatus>>('/api/integrations/status');
  return (['email_finder', 'email_verifier'] as const).filter((k) => status.data?.[k]?.simulated);
}

// Bulk "Find & verify emails": options first, then the background run's live progress.
function EnrichModal({ target, onClose, onFinished }: { target: EnrichTarget; onClose: () => void; onFinished: () => void }) {
  const [opts, setOpts] = useState<EnrichOptions>({ find: true, verify: true, company: false, overwrite: false });
  const [runId, setRunId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const simulated = useSimulatedData();
  const progress = useApi<EnrichmentRun>(runId ? `/api/enrichment/runs/${runId}` : null, 2000);
  const { busy, run } = useAction();
  const r = progress.data;
  const finished = r?.status === 'done';
  useEffect(() => {
    if (finished) onFinished();
    // Only when the run finishes; onFinished is a new function on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);
  const count = 'leadIds' in target ? target.leadIds.length : target.count;
  const what = 'leadIds' in target ? `${count} selected lead${count === 1 ? '' : 's'}` : `the ${count} leads in “${target.name}”`;
  const set = (k: keyof EnrichOptions) => (v: boolean) => setOpts({ ...opts, [k]: v });
  const start = () =>
    run('go', async () => {
      setError(null);
      try {
        const body = 'leadIds' in target ? { leadIds: target.leadIds, ...opts } : { listId: target.listId, ...opts };
        setRunId((await api<{ runId: number; total: number }>('/api/leads/enrich', { body })).runId);
      } catch (e) {
        setError((e as Error).message);
      }
    });

  return (
    <Modal
      title="Find & verify emails"
      onClose={onClose}
      footer={
        runId ? (
          <Button variant="primary" onClick={onClose}>
            {finished ? 'Done' : 'Close (keeps running)'}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" busy={busy === 'go'} disabled={!opts.find && !opts.verify && !opts.company} onClick={start}>
              Start
            </Button>
          </>
        )
      }
    >
      {!runId ? (
        <>
          <p style={{ margin: 0 }}>Looks up {what} in the background, with the providers under Settings → Integrations in their order.</p>
          <Toggle checked={opts.find} onChange={set('find')} label="Find missing emails" hint="Tries each email finder in turn until one returns an address that passes verification." />
          <Toggle checked={opts.verify} onChange={set('verify')} label="Verify emails" hint="Checks found addresses, and existing ones that haven't been checked yet." />
          <Toggle checked={opts.company} onChange={set('company')} label="Add company data" hint="Company domain, size, industry and website from your enrichment provider. Only blank fields are filled." />
          <Toggle
            checked={opts.overwrite}
            onChange={set('overwrite')}
            label="Replace addresses people entered"
            hint="Off: emails from CSV files, LinkedIn or typed in by hand are kept and only verified. On: a verified address from a finder replaces them."
          />
          {!!simulated.length && (
            <div className="note note-warning">
              {simulated.length === 2 ? 'Finding and verifying use' : simulated[0] === 'email_finder' ? 'Finding uses' : 'Verifying uses'} the built-in simulator: found addresses are made up (.example) and never emailed
              from a real mailbox, and real addresses stay unverified. Add providers under Settings → Integrations.
            </div>
          )}
          <span className="field-hint">Lookups use credits from your own provider accounts; Settings → Integrations shows usage per month.</span>
        </>
      ) : (
        <div className="run-progress" aria-live="polite">
          <div className="spread">
            <strong>{finished ? 'Finished' : 'Looking up…'}</strong>
            <span className="num muted">
              {r?.done ?? 0} / {r?.total ?? count}
            </span>
          </div>
          <ProgressBar done={r?.done ?? 0} total={r?.total ?? count} label="Email lookup progress" />
          {r && (
            <div className="muted" style={{ fontSize: 13 }}>
              {r.found} with an email · {r.verified} verified valid{r.failed ? ` · ${r.failed} failed` : ''}
            </div>
          )}
          {!finished && <span className="field-hint">You can close this window: the lookup carries on, and the table updates as leads are done.</span>}
        </div>
      )}
      <ErrorNote error={error ?? progress.error} />
    </Modal>
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

// Where people come from on LinkedIn, with what the URL looks like and how many the source usually has.
const SOURCES: Record<ImportKind, { label: string; url: string; placeholder: string; hint: string; max: string }> = {
  search: {
    label: 'People search',
    url: 'Search URL',
    placeholder: 'https://www.linkedin.com/search/results/people/?keywords=…',
    hint: 'Run a people search on LinkedIn or Sales Navigator with your filters, then copy the address bar here.',
    max: 'LinkedIn shows up to 1,000 results per search.',
  },
  post: {
    label: 'Post reactions and comments',
    url: 'Post URL',
    placeholder: 'https://www.linkedin.com/feed/update/urn:li:activity:…',
    hint: 'Open the post, use "Copy link to post" from its menu, and paste it here.',
    max: 'People who engaged with a post are often the warmest leads.',
  },
  event: {
    label: 'Event attendees',
    url: 'Event URL',
    placeholder: 'https://www.linkedin.com/events/…',
    hint: 'LinkedIn only shows attendees to people attending the event, so the account must be attending too.',
    max: 'Collects the people shown on the event’s attendee list.',
  },
  group: {
    label: 'Group members',
    url: 'Group URL',
    placeholder: 'https://www.linkedin.com/groups/1234567/',
    hint: 'The account must be a member of the group to see its member list.',
    max: 'Large groups can have far more members than one import collects.',
  },
};

function ImportModal({ lists, defaultListId, onClose, onDone }: { lists: LeadList[]; defaultListId: number | null; onClose: () => void; onDone: (listId: number) => void }) {
  const [tab, setTab] = useState<'csv' | 'linkedin' | 'single'>('csv');
  const accounts = useApi<Account[]>('/api/accounts');
  const imports = useApi<LeadImport[]>('/api/imports', 3000);
  const [listId, setListId] = useState<number | 'new'>(defaultListId ?? lists[0]?.id ?? 'new');
  const [listName, setListName] = useState('');
  const [file, setFile] = useState<{ name: string; text: string; rows: number } | null>(null);
  const [source, setSource] = useState<ImportKind>('search');
  const [url, setUrl] = useState('');
  const [likers, setLikers] = useState(true);
  const [commenters, setCommenters] = useState(true);
  const [limit, setLimit] = useState(100);
  const [accountId, setAccountId] = useState<number | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [single, setSingle] = useState({ profileUrl: '', firstName: '', lastName: '', company: '', email: '' });
  // Starts from the workspace's "auto-enrich imports" setting; choosing here applies to this import only.
  const enrichDefaults = useApi<EnrichmentSettings>('/api/settings/enrichment');
  const [autoEnrich, setAutoEnrich] = useState<boolean | null>(null);
  const enrichAfter = autoEnrich ?? enrichDefaults.data?.autoEnrichOnImport ?? false;
  const toast = useToast();
  const { busy, run } = useAction();
  const acc = accountId || accounts.data?.find((a) => a.status === 'active')?.id || accounts.data?.[0]?.id || '';
  const info = SOURCES[source];

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
          const r = await api('/api/leads/import/csv', { body: { listId: id, csv: file!.text, autoEnrich: enrichAfter } });
          toast(
            `Imported ${r.added} of ${r.rows} rows${r.duplicates ? ` · ${r.duplicates} already in your leads` : ''}${r.invalid ? ` · ${r.invalid} without a LinkedIn URL` : ''}${r.enrichRunId ? ' · finding emails in the background' : ''}`,
          );
          onDone(id);
        } else if (tab === 'linkedin') {
          await api('/api/leads/import/linkedin', { body: { listId: id, accountId: Number(acc), source, url, limit, autoEnrich: enrichAfter, ...(source === 'post' ? { likers, commenters } : {}) } });
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

  const ready = tab === 'csv' ? !!file : tab === 'linkedin' ? !!url && !!acc && (source !== 'post' || likers || commenters) : !!single.profileUrl;

  return (
    <Modal
      title="Import leads"
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" disabled={!ready} busy={busy === 'go'} onClick={submit}>
            {tab === 'linkedin' ? 'Start collecting' : 'Import'}
          </Button>
        </>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'csv', label: 'CSV file' },
          { id: 'linkedin', label: 'From LinkedIn' },
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
          <Toggle checked={enrichAfter} onChange={setAutoEnrich} label="Find and verify emails after importing" hint="Looks up emails for the new leads in the background. Addresses in the file are kept and only verified." />
        </>
      )}

      {tab === 'linkedin' && (
        <>
          <Field label="Collect">
            <select value={source} onChange={(e) => setSource(e.target.value as ImportKind)}>
              {(Object.keys(SOURCES) as ImportKind[]).map((k) => (
                <option key={k} value={k}>
                  {SOURCES[k].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={info.url} hint={info.hint}>
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={info.placeholder} />
          </Field>
          {source === 'post' && (
            <fieldset className="checklist">
              <legend className="field-label">People who</legend>
              <div className="grid grid-2" style={{ gap: 8 }}>
                <label className="checklist-item">
                  <input type="checkbox" checked={likers} onChange={(e) => setLikers(e.target.checked)} />
                  Reacted to the post
                </label>
                <label className="checklist-item">
                  <input type="checkbox" checked={commenters} onChange={(e) => setCommenters(e.target.checked)} />
                  Commented on it
                </label>
              </div>
              {!likers && !commenters && <div className="field-error">Choose at least one.</div>}
            </fieldset>
          )}
          <div className="grid grid-2">
            <Field label="Use account" hint="Collecting runs in this account's working hours, between its actions.">
              <select value={acc} onChange={(e) => setAccountId(Number(e.target.value))}>
                {accounts.data?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Maximum leads" hint={`${info.max} Each account collects at most its daily import limit (set on the account).`}>
              <input type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
            </Field>
          </div>
          <Toggle checked={enrichAfter} onChange={setAutoEnrich} label="Find and verify emails after collecting" hint="Looks up emails for the new leads in the background once the import is done." />
          <div className="note">People on your blacklist or suppression list are left out, and people already in your leads are not added twice.</div>
          {!!imports.data?.length && <ImportList imports={imports.data.slice(0, 5)} />}
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

// Recent LinkedIn imports with live progress, results and why one is waiting or stopped.
function ImportList({ imports }: { imports: LeadImport[] }) {
  return (
    <div className="import-list">
      <div className="field-label">Recent LinkedIn imports</div>
      {imports.map((i) => (
        <div key={i.id} className="import-row">
          <div className="spread">
            <span className="cell-sub" title={i.source}>
              {IMPORT_KIND_LABELS[i.kind]} · {i.listName ?? 'Deleted list'}
              {i.accountName ? ` · ${i.accountName}` : ''}
            </span>
            {i.status === 'running' ? (
              <span className="row" style={{ gap: 8 }}>
                <span className="num cell-sub">
                  {i.found}
                  {i.progress.total ? ` / ${i.progress.total}` : ''}
                </span>
                <ProgressBar done={i.progress.done} total={i.progress.total} label={`Import ${i.id} progress`} />
              </span>
            ) : (
              <Pill status={i.status === 'done' ? 'done' : 'failed'}>{i.status === 'done' ? `${i.added} added` : 'Failed'}</Pill>
            )}
          </div>
          {i.status === 'done' && (i.duplicates > 0 || i.blacklisted > 0) && (
            <div className="field-hint">
              {i.found} found
              {i.duplicates ? ` · ${i.duplicates} already in your leads` : ''}
              {i.blacklisted ? ` · ${i.blacklisted} blacklisted or suppressed` : ''}
            </div>
          )}
          {i.note && <div className="field-hint">{i.note}</div>}
          {i.status === 'failed' && i.error && <div className="field-error">{i.error}</div>}
        </div>
      ))}
    </div>
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
  // Polls while a lookup started here is running.
  const [watching, setWatching] = useState(false);
  const lead = useApi<Lead & { activity: any[]; campaigns: any[] }>(`/api/leads/${id}`, watching ? 2000 : undefined);
  const [edit, setEdit] = useState<Partial<Lead> | null>(null);
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
        <span className="row" style={{ gap: 6 }}>
          {l.openProfile && <Pill status="open_profile">Open profile</Pill>}
          <Pill status={l.connectionStatus} />
        </span>
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
                  {a.variant && <span className="muted"> · variant {a.variant}</span>}
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

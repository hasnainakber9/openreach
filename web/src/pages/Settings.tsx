import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, useApi, type Invite, type InviteRole, type Role, type Suppression, type SuppressionKind, type TeamMember } from '../api';
import { Button, ConfirmButton, Field, Modal, Pager, Pill, Tabs, useAction, useToast } from '../components/ui';
import { timeAgo } from '../format';
import { isAdminRole, type Me } from '../session';
import Integrations from './Integrations';
import PipelineSettings from './PipelineSettings';

type Tab = 'team' | 'pipeline' | 'blacklist' | 'integrations' | 'profile';
const TABS: Tab[] = ['team', 'pipeline', 'blacklist', 'integrations', 'profile'];

export default function Settings({ me, onMe }: { me: Me; onMe: (me: Me) => void }) {
  // ?tab= opens a tab directly (the Pipeline page links to its stages).
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>(TABS.find((t) => t === params.get('tab')) ?? 'team');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>{me.workspace_name}</p>
        </div>
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'team', label: 'Team' },
          { id: 'pipeline', label: 'Pipeline' },
          { id: 'blacklist', label: 'Blacklist' },
          { id: 'integrations', label: 'Integrations' },
          { id: 'profile', label: 'Your profile' },
        ]}
      />
      {tab === 'team' && (
        <div className="stack">
          <Team me={me} />
          {isAdminRole(me) && <Invites />}
          {me.role === 'owner' && me.workspace_kind === 'standard' && <AgencyMode onMe={onMe} />}
        </div>
      )}
      {tab === 'pipeline' && <PipelineSettings me={me} />}
      {tab === 'blacklist' && (
        <div className="stack">
          <Blacklist />
          <DoNotContact me={me} />
        </div>
      )}
      {tab === 'integrations' && (
        <div className="stack">
          <Integrations me={me} />
          <Webhooks />
        </div>
      )}
      {tab === 'profile' && <Profile email={me.email} />}
    </>
  );
}

const ROLE_HELP: Record<Role, string> = {
  owner: 'Owner: everything, including owners and the agency',
  admin: 'Admin: also manage team, invites, mailboxes and integrations',
  member: 'Member: run campaigns and manage leads',
  client: 'Client: read-only view of results, inbox and pipeline',
};

function Team({ me }: { me: Me }) {
  const team = useApi<TeamMember[]>('/api/team');
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', email: '', password: '', role: 'member' });
  const { busy, run } = useAction();
  const admin = isAdminRole(me);
  // Only owners hand out (or take away) the owner role.
  // Agency owners/admins listed in a client are managed in the agency, so they get no controls here.
  const editable = (u: TeamMember) => admin && !u.inherited && u.id !== me.id && (u.role !== 'owner' || me.role === 'owner');
  const rolesFor = (u: TeamMember): Role[] => (me.role === 'owner' || u.role === 'owner' ? ['owner', 'admin', 'member', 'client'] : ['admin', 'member', 'client']);
  const setRole = (u: TeamMember, role: Role) =>
    run(`r${u.id}`, async () => (await api(`/api/team/${u.id}`, { method: 'PATCH', body: { role } }), team.reload()), `${u.name} is now ${role === 'admin' ? 'an' : 'a'} ${role}`);
  return (
    <div className="card card-flush">
      <div className="spread" style={{ padding: 16 }}>
        <div>
          <h2>Members</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Everyone in the workspace shares accounts, leads and campaigns. Clients only see results.
          </p>
        </div>
        {admin && <Button onClick={() => setAdding(true)}>Add member</Button>}
      </div>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {team.data?.map((u) => (
            <tr key={u.id}>
              <td className="cell-title">{u.name}</td>
              <td>{u.email}</td>
              <td>
                {editable(u) ? (
                  <select value={u.role} onChange={(e) => setRole(u, e.target.value as Role)} aria-label={`Role of ${u.name}`} disabled={busy === `r${u.id}`} style={{ width: 'auto' }}>
                    {rolesFor(u).map((r) => (
                      <option key={r} value={r}>
                        {r[0].toUpperCase() + r.slice(1)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <>
                    <span style={{ textTransform: 'capitalize' }}>{u.role}</span>
                    {u.inherited && <span className="muted"> (via {me.parent_name ?? 'the agency'})</span>}
                  </>
                )}
              </td>
              <td className="num">
                {editable(u) && (
                  <Button size="sm" variant="danger" busy={busy === `d${u.id}`} onClick={() => confirm(`Remove ${u.name} from this workspace?`) && run(`d${u.id}`, async () => (await api(`/api/team/${u.id}`, { method: 'DELETE' }), team.reload()))}>
                    Remove
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {adding && (
        <Modal
          title="Add team member"
          onClose={() => setAdding(false)}
          footer={
            <Button
              variant="primary"
              busy={busy === 'add'}
              onClick={() =>
                run(
                  'add',
                  async () => {
                    await api('/api/team', { body: f });
                    setAdding(false);
                    setF({ name: '', email: '', password: '', role: 'member' });
                    await team.reload();
                  },
                  'Member added. Share the password with them securely.',
                )
              }
            >
              Add member
            </Button>
          }
        >
          <p className="muted" style={{ margin: 0 }}>
            Prefer an invite (below) so people choose their own password.
          </p>
          <Field label="Name">
            <input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Email">
            <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
          <Field label="Temporary password" hint="At least 8 characters. They can change it under Your profile.">
            <input type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Role">
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              {(['member', 'admin', 'client'] as const).map((r) => (
                <option key={r} value={r}>
                  {ROLE_HELP[r]}
                </option>
              ))}
            </select>
          </Field>
        </Modal>
      )}
    </div>
  );
}

// Invite links: the link is shown once (only a hash is stored) and emailed when the server has SMTP_URL.
function Invites() {
  const invites = useApi<{ items: Invite[]; emailEnabled: boolean }>('/api/invites');
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<{ email: string; role: InviteRole }>({ email: '', role: 'member' });
  const [created, setCreated] = useState<{ email: string; link: string; emailed: boolean } | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const close = () => (setOpen(false), setCreated(null), setF({ email: '', role: 'member' }));
  const send = () =>
    run('invite', async () => {
      const r = await api<{ link: string; emailed: boolean }>('/api/invites', { body: f });
      // Without PUBLIC_URL the server returns a path; make it a full link for copying.
      setCreated({ email: f.email, link: new URL(r.link, window.location.origin).href, emailed: r.emailed });
      await invites.reload();
    });
  const copy = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copied');
    } catch {
      toast('Select the link and copy it', 'error');
    }
  };
  return (
    <div className="card card-flush">
      <div className="spread" style={{ padding: 16 }}>
        <div>
          <h2>Invites</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            {invites.data?.emailEnabled ? 'Invites are emailed, and you can copy the link too.' : 'Copy the link and send it yourself (set SMTP_URL on the server to email invites).'} Links work once and expire after 7 days.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>Invite people</Button>
      </div>
      {!!invites.data?.items.length && (
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Invited</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invites.data.items.map((i) => (
              <tr key={i.id}>
                <td className="cell-title">{i.email}</td>
                <td style={{ textTransform: 'capitalize' }}>{i.role}</td>
                <td className="muted">
                  {timeAgo(i.createdAt)}
                  {i.invitedBy && ` by ${i.invitedBy}`}
                </td>
                <td>{i.expired ? <Pill status="failed">Expired</Pill> : <span className="muted">Expires {timeAgo(i.expiresAt)}</span>}</td>
                <td className="num">
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <Button size="sm" onClick={() => (setF({ email: i.email, role: i.role }), setOpen(true))}>
                      New link
                    </Button>
                    <Button size="sm" variant="danger" busy={busy === `x${i.id}`} onClick={() => run(`x${i.id}`, async () => (await api(`/api/invites/${i.id}`, { method: 'DELETE' }), invites.reload()), 'Invite revoked')}>
                      Revoke
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && (
        <Modal
          title={created ? 'Invite ready' : 'Invite people'}
          onClose={close}
          footer={
            created ? (
              <Button variant="primary" onClick={close}>
                Done
              </Button>
            ) : (
              <Button variant="primary" busy={busy === 'invite'} disabled={!f.email.trim()} onClick={send}>
                Create invite
              </Button>
            )
          }
        >
          {created ? (
            <>
              <p style={{ margin: 0 }}>{created.emailed ? `We're emailing ${created.email} the link below.` : `Send ${created.email} this link. It is shown only now; make a new one if it gets lost.`}</p>
              <Field label="Invite link">
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <input type="text" readOnly value={created.link} onFocus={(e) => e.target.select()} />
                  <Button onClick={() => void copy(created.link)}>Copy</Button>
                </div>
              </Field>
            </>
          ) : (
            <>
              <p className="muted" style={{ margin: 0 }}>
                Inviting an address again replaces its earlier link.
              </p>
              <Field label="Email">
                <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoFocus />
              </Field>
              <Field label="Role">
                <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as InviteRole })}>
                  {(['member', 'admin', 'client'] as const).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_HELP[r]}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

// Owners of a standard workspace can turn it into an agency that runs client workspaces.
function AgencyMode({ onMe }: { onMe: (me: Me) => void }) {
  const { busy, run } = useAction();
  const navigate = useNavigate();
  const enable = () =>
    run('agency', async () => {
      const r = await api<{ user: Me }>('/api/agency/enable', { body: {} });
      onMe(r.user);
      navigate('/agency');
    });
  return (
    <div className="card stack">
      <h2>Agency mode</h2>
      <p className="muted" style={{ margin: 0 }}>
        Run outreach for your clients from here. Each client gets its own workspace with separate accounts, leads, campaigns and inbox; your owners and
        admins can open every client, and each client can get a read-only login to follow results. You can also put your own name, logo, color and domain
        on the app.
      </p>
      <div>
        <ConfirmButton busy={busy === 'agency'} onConfirm={enable} confirmLabel="Click again to turn on agency mode">
          Turn on agency mode
        </ConfirmButton>
      </div>
    </div>
  );
}

const KIND_HELP: Record<string, string> = {
  profile: 'LinkedIn profile URLs, one per line',
  company: 'Company names (exact match, any case)',
  keyword: 'Words in a headline, title or company',
  email_domain: 'Email domains, e.g. competitor.com',
};

function Blacklist() {
  const items = useApi<any[]>('/api/blacklist');
  const [kind, setKind] = useState('company');
  const [values, setValues] = useState('');
  const toast = useToast();
  const { busy, run } = useAction();
  const add = () =>
    run('add', async () => {
      const r = await api('/api/blacklist', { body: { kind, values: values.split('\n').map((v) => v.trim()).filter(Boolean) } });
      toast(`Added ${r.added}`);
      setValues('');
      await items.reload();
    });
  return (
    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <div className="card stack">
        <h2>Never contact</h2>
        <p className="muted" style={{ margin: 0 }}>
          Blacklisted people are skipped when added to a campaign, and also mid-sequence if you blacklist them later. Use it for customers, colleagues and competitors.
        </p>
        <Field label="Type">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="company">Company</option>
            <option value="profile">LinkedIn profile</option>
            <option value="keyword">Keyword</option>
            <option value="email_domain">Email domain</option>
          </select>
        </Field>
        <Field label="Values" hint={KIND_HELP[kind]}>
          <textarea value={values} onChange={(e) => setValues(e.target.value)} rows={5} />
        </Field>
        <div>
          <Button variant="primary" disabled={!values.trim()} busy={busy === 'add'} onClick={add}>
            Add to blacklist
          </Button>
        </div>
      </div>
      <div className="card card-flush">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Value</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {!items.data?.length && (
              <tr>
                <td colSpan={3} className="muted">
                  Nothing blacklisted yet.
                </td>
              </tr>
            )}
            {items.data?.map((b) => (
              <tr key={b.id}>
                <td className="muted">{b.kind.replace('_', ' ')}</td>
                <td>{b.value}</td>
                <td className="num">
                  <Button size="sm" variant="ghost" onClick={() => run(`d${b.id}`, async () => (await api(`/api/blacklist/${b.id}`, { method: 'DELETE' }), items.reload()))}>
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const SUPPRESSION_KINDS: Record<SuppressionKind, string> = { linkedin: 'LinkedIn profile', email: 'Email', phone: 'Phone' };
const REASONS: Record<string, string> = {
  unsubscribe: 'Unsubscribed',
  not_interested: 'Not interested',
  sms_stop: 'Texted STOP',
  bounce: 'Bounced',
  manual: 'Added by hand',
};

// People who asked not to be contacted. Replies classified as unsubscribe or (confidently) not interested
// land here on their own; the AI can be wrong, so admins can take people off again.
function DoNotContact({ me }: { me: Me }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({ page: String(page) });
  if (q.trim()) params.set('q', q.trim());
  if (kind) params.set('kind', kind);
  const list = useApi<{ total: number; page: number; pageSize: number; items: Suppression[] }>(`/api/suppressions?${params}`);
  const [form, setForm] = useState<{ kind: SuppressionKind; value: string }>({ kind: 'email', value: '' });
  const admin = me.role === 'owner' || me.role === 'admin';
  const toast = useToast();
  const { busy, run } = useAction();
  const add = () =>
    run('add', async () => {
      const r = await api<{ added: boolean; stopped: number }>('/api/suppressions', { body: form });
      toast(r.added ? `Added${r.stopped ? `, and stopped ${r.stopped} running campaign lead${r.stopped === 1 ? '' : 's'}` : ''}` : 'Already on the list');
      setForm({ ...form, value: '' });
      await list.reload();
    });
  return (
    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <div className="card stack">
        <h2>Do not contact</h2>
        <p className="muted" style={{ margin: 0 }}>
          People who opted out. Unsubscribe replies, and replies the AI is sure mean “not interested”, are added automatically, and the person stops in every campaign. Removing someone does not restart their campaigns.
        </p>
        <Field label="Type">
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as SuppressionKind })}>
            {Object.entries(SUPPRESSION_KINDS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Value" hint={form.kind === 'phone' ? 'International form, like +44 20 7946 0958' : form.kind === 'linkedin' ? 'Profile URL or slug' : undefined}>
          <input type="text" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} maxLength={300} />
        </Field>
        <div>
          <Button variant="primary" disabled={!form.value.trim()} busy={busy === 'add'} onClick={add}>
            Add to do-not-contact
          </Button>
        </div>
      </div>
      <div className="card card-flush">
        <div className="row" style={{ padding: 12, flexWrap: 'nowrap' }}>
          <input type="search" placeholder="Search" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} aria-label="Search do-not-contact list" />
          <select value={kind} onChange={(e) => (setKind(e.target.value), setPage(1))} aria-label="Type">
            <option value="">All types</option>
            {Object.entries(SUPPRESSION_KINDS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="table-wrap">
          <table className="table-cards">
            <thead>
              <tr>
                <th>Who</th>
                <th>Why</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data && !list.data.items.length && (
                <tr>
                  <td colSpan={3} className="muted">
                    {q || kind ? 'Nobody matches.' : 'Nobody has opted out yet.'}
                  </td>
                </tr>
              )}
              {list.data?.items.map((s) => (
                <tr key={s.id}>
                  <td className="cell-primary">
                    <div className="cell-title">{s.leadName?.trim() || s.value}</div>
                    <div className="cell-sub">
                      {SUPPRESSION_KINDS[s.kind] ?? s.kind}: {s.value}
                    </div>
                  </td>
                  <td data-label="Why">
                    {REASONS[s.reason] ?? s.reason}
                    <div className="cell-sub">
                      {s.source ? `${s.source} · ` : ''}
                      {timeAgo(s.createdAt)}
                    </div>
                  </td>
                  <td className="num cell-action">
                    {admin && (
                      <ConfirmButton size="sm" variant="ghost" onConfirm={() => run(`d${s.id}`, async () => (await api(`/api/suppressions/${s.id}`, { method: 'DELETE' }), list.reload()), 'Removed from the list')}>
                        Remove
                      </ConfirmButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.data && <Pager page={page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />}
      </div>
    </div>
  );
}

function Webhooks() {
  const hooks = useApi<any[]>('/api/webhooks');
  const events = useApi<string[]>('/api/webhooks/events');
  const [url, setUrl] = useState('');
  const [chosen, setChosen] = useState<string[]>(['lead.connected', 'lead.replied']);
  const toast = useToast();
  const { busy, run } = useAction();
  return (
    <div className="stack">
      <div className="card stack">
        <h2>Webhooks</h2>
        <p className="muted" style={{ margin: 0 }}>
          OpenReach POSTs JSON to your URL when things happen. Use it with HubSpot, Pipedrive or Salesforce through Zapier, Make or n8n, or your own endpoint. Each request carries an <code>X-OpenReach-Signature</code> header: HMAC-SHA256 of the body with the webhook's secret.
        </p>
        <Field label="Endpoint URL">
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.zapier.com/hooks/catch/…" />
        </Field>
        <div className="row">
          {events.data?.map((e) => (
            <label key={e} className="row" style={{ gap: 4, fontSize: 13 }}>
              <input type="checkbox" checked={chosen.includes(e)} onChange={(ev) => setChosen(ev.target.checked ? [...chosen, e] : chosen.filter((x) => x !== e))} />
              <code>{e}</code>
            </label>
          ))}
        </div>
        <div>
          <Button
            variant="primary"
            disabled={!url || !chosen.length}
            busy={busy === 'add'}
            onClick={() =>
              run('add', async () => {
                await api('/api/webhooks', { body: { url, events: chosen } });
                setUrl('');
                await hooks.reload();
              })
            }
          >
            Add webhook
          </Button>
        </div>
      </div>
      {hooks.data?.map((h) => (
        <div className="card stack" key={h.id}>
          <div className="spread">
            <strong style={{ wordBreak: 'break-all' }}>{h.url}</strong>
            <div className="row">
              <Button size="sm" busy={busy === `t${h.id}`} onClick={() => run(`t${h.id}`, async () => toast(`Test delivery: ${(await api(`/api/webhooks/${h.id}/test`, { body: {} })).status}`))}>
                Send test
              </Button>
              <Button size="sm" variant="danger" onClick={() => confirm('Delete this webhook?') && run(`d${h.id}`, async () => (await api(`/api/webhooks/${h.id}`, { method: 'DELETE' }), hooks.reload()))}>
                Delete
              </Button>
            </div>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {h.events.map((e: string) => (
              <code key={e}>{e}</code>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            {h.secret && <>Secret: <code>{h.secret}</code> · </>}Last delivery: {h.lastStatus ?? 'none yet'} · added {timeAgo(h.createdAt)}
          </div>
        </div>
      ))}
    </div>
  );
}

function Profile({ email }: { email: string }) {
  const [f, setF] = useState({ current: '', next: '' });
  const { busy, run } = useAction();
  // A real form, so browsers and password managers treat these as password fields and Enter submits.
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (f.next.length >= 8) void run('pw', async () => (await api('/api/auth/password', { body: f }), setF({ current: '', next: '' })), 'Password changed. Your other sessions are signed out.');
  };
  return (
    <form className="card stack" style={{ maxWidth: 420 }} onSubmit={submit}>
      <h2>Change password</h2>
      {/* Tells password managers which account the new password belongs to. */}
      <input type="email" value={email} autoComplete="username" readOnly hidden />
      <Field label="Current password">
        <input type="password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required autoComplete="current-password" />
      </Field>
      <Field label="New password" hint="At least 8 characters">
        <input type="password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} required minLength={8} autoComplete="new-password" />
      </Field>
      <div>
        <Button variant="primary" type="submit" busy={busy === 'pw'} disabled={f.next.length < 8}>
          Update password
        </Button>
      </div>
    </form>
  );
}

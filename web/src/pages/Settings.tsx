import { useState } from 'react';
import { api, useApi } from '../api';
import type { Me } from '../App';
import { Button, Field, Modal, Tabs, useAction, useToast } from '../components/ui';
import { timeAgo } from '../format';

type Tab = 'team' | 'blacklist' | 'webhooks' | 'profile';

export default function Settings({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>('team');
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
          { id: 'blacklist', label: 'Blacklist' },
          { id: 'webhooks', label: 'Webhooks & CRM' },
          { id: 'profile', label: 'Your profile' },
        ]}
      />
      {tab === 'team' && <Team me={me} />}
      {tab === 'blacklist' && <Blacklist />}
      {tab === 'webhooks' && <Webhooks />}
      {tab === 'profile' && <Profile />}
    </>
  );
}

function Team({ me }: { me: Me }) {
  const team = useApi<any[]>('/api/team');
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', email: '', password: '', role: 'member' });
  const { busy, run } = useAction();
  const admin = me.role !== 'member';
  return (
    <div className="card card-flush">
      <div className="spread" style={{ padding: 16 }}>
        <div>
          <h2>Members</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Everyone in the workspace shares accounts, leads and campaigns.
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
              <td style={{ textTransform: 'capitalize' }}>{u.role}</td>
              <td className="num">
                {admin && u.id !== me.id && u.role !== 'owner' && (
                  <Button size="sm" variant="danger" busy={busy === `d${u.id}`} onClick={() => confirm(`Remove ${u.name}?`) && run(`d${u.id}`, async () => (await api(`/api/team/${u.id}`, { method: 'DELETE' }), team.reload()))}>
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
              <option value="member">Member: run campaigns and manage leads</option>
              <option value="admin">Admin: also manage team and webhooks</option>
            </select>
          </Field>
        </Modal>
      )}
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
        <h2>Send events to your CRM</h2>
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

function Profile() {
  const [f, setF] = useState({ current: '', next: '' });
  const { busy, run } = useAction();
  return (
    <div className="card stack" style={{ maxWidth: 420 }}>
      <h2>Change password</h2>
      <Field label="Current password">
        <input type="password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} autoComplete="current-password" />
      </Field>
      <Field label="New password" hint="At least 8 characters">
        <input type="password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} autoComplete="new-password" />
      </Field>
      <div>
        <Button variant="primary" busy={busy === 'pw'} disabled={f.next.length < 8} onClick={() => run('pw', async () => (await api('/api/auth/password', { body: f }), setF({ current: '', next: '' })), 'Password changed')}>
          Update password
        </Button>
      </div>
    </div>
  );
}

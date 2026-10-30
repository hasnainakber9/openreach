import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, useApi, type Account, type Campaign } from '../api';
import { Button, Empty, Field, Modal, Pill, useAction } from '../components/ui';
import { pct } from '../format';

export default function Campaigns() {
  const campaigns = useApi<Campaign[]>('/api/campaigns', 15_000);
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();
  const { busy, run } = useAction();

  const toggle = (c: Campaign) =>
    run(`t${c.id}`, async () => {
      await api(`/api/campaigns/${c.id}/${c.status === 'active' ? 'pause' : 'start'}`, { body: {} });
      await campaigns.reload();
    });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Campaigns</h1>
          <p>Each campaign runs one sequence from one LinkedIn account.</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          New campaign
        </Button>
      </div>

      <div className="card card-flush">
        {campaigns.data && !campaigns.data.length ? (
          <Empty title="No campaigns yet" action={<Button variant="primary" onClick={() => setCreating(true)}>Create your first campaign</Button>}>
            A campaign walks each lead through a sequence of steps, like viewing their profile, inviting them, and following up once they accept.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th className="num">Leads</th>
                  <th className="num">Invited</th>
                  <th className="num">Accepted</th>
                  <th className="num">Replied</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {campaigns.data?.map((c) => {
                  const s = c.stats;
                  const finished = s.done + s.replied + s.failed + s.skipped;
                  return (
                    <tr key={c.id} className="clickable" onClick={() => nav(`/campaigns/${c.id}`)}>
                      <td>
                        <div className="cell-title">{c.name}</div>
                        <div className="cell-sub">{c.account ? c.account.name : 'No LinkedIn account selected'}</div>
                      </td>
                      <td>
                        <Pill status={c.status} />
                      </td>
                      <td style={{ minWidth: 140 }}>
                        <div className="progress" title={`${finished} of ${s.total} finished`}>
                          <span style={{ width: `${s.total ? (finished / s.total) * 100 : 0}%`, background: 'var(--series-1)' }} />
                        </div>
                        <div className="cell-sub">
                          {s.active} in progress · {finished} finished
                        </div>
                      </td>
                      <td className="num">{s.total}</td>
                      <td className="num">{s.funnel.invited}</td>
                      <td className="num">
                        {s.funnel.accepted} <span className="muted">({pct(s.acceptanceRate)})</span>
                      </td>
                      <td className="num">
                        {s.funnel.replied} <span className="muted">({pct(s.replyRate)})</span>
                      </td>
                      <td className="num" onClick={(e) => e.stopPropagation()}>
                        <Button size="sm" busy={busy === `t${c.id}`} onClick={() => toggle(c)}>
                          {c.status === 'active' ? 'Pause' : 'Start'}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {creating && <NewCampaign onClose={() => setCreating(false)} onCreated={(id) => nav(`/campaigns/${id}`)} />}
    </>
  );
}

function NewCampaign({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const accounts = useApi<Account[]>('/api/accounts');
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState<number | ''>('');
  const { busy, run } = useAction();
  const chosen = accountId || accounts.data?.[0]?.id || '';

  const create = () =>
    run('create', async () => {
      const c = await api<Campaign>('/api/campaigns', { body: { name: name || 'Untitled campaign', accountId: chosen || null } });
      onCreated(c.id);
    });

  return (
    <Modal
      title="New campaign"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy === 'create'} onClick={create}>
            Create and edit sequence
          </Button>
        </>
      }
    >
      <Field label="Name">
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. SaaS founders, London" autoFocus />
      </Field>
      <Field label="LinkedIn account" hint={!accounts.data?.length ? 'Add an account first on the LinkedIn accounts page; you can pick it later.' : undefined}>
        <select value={chosen} onChange={(e) => setAccountId(Number(e.target.value))}>
          {!accounts.data?.length && <option value="">None yet</option>}
          {accounts.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.driver === 'simulator' ? ' (simulated)' : ''}
            </option>
          ))}
        </select>
      </Field>
      <p className="muted" style={{ margin: 0 }}>
        It starts with a proven sequence: view profile, wait a day, invite with a note, then follow up with two messages if they accept or withdraw the invite after 7 days if not. You can change every step.
      </p>
    </Modal>
  );
}

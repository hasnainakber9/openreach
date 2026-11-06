import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, useApi, type Account, type Campaign } from '../api';
import { Button, CheckList, Empty, Field, Modal, Pill, useAction } from '../components/ui';
import { pct, senderSummary } from '../format';
import { canWrite, type Me } from '../session';

export default function Campaigns({ me }: { me: Me }) {
  const writer = canWrite(me);
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
          <p>Each campaign runs one sequence from one or more LinkedIn accounts.</p>
        </div>
        {writer && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            New campaign
          </Button>
        )}
      </div>

      <div className="card card-flush">
        {campaigns.data && !campaigns.data.length ? (
          <Empty title="No campaigns yet" action={writer && <Button variant="primary" onClick={() => setCreating(true)}>Create your first campaign</Button>}>
            A campaign walks each lead through a sequence of steps, like viewing their profile, inviting them, and following up once they accept.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table-cards">
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
                      <td className="cell-primary">
                        <div className="cell-title">{c.name}</div>
                        <div className="cell-sub">{c.accounts.length ? senderSummary(c.accounts) : 'No LinkedIn account selected'}</div>
                      </td>
                      <td data-label="Status">
                        <Pill status={c.status} />
                      </td>
                      <td data-label="Progress" style={{ minWidth: 140 }}>
                        <div className="progress" title={`${finished} of ${s.total} finished`}>
                          <span style={{ width: `${s.total ? (finished / s.total) * 100 : 0}%`, background: 'var(--series-1)' }} />
                        </div>
                        <div className="cell-sub">
                          {s.active} in progress · {finished} finished
                        </div>
                      </td>
                      <td className="num" data-label="Leads">{s.total}</td>
                      <td className="num" data-label="Invited">{s.funnel.invited}</td>
                      <td className="num" data-label="Accepted">
                        {s.funnel.accepted} <span className="muted">({pct(s.acceptanceRate)})</span>
                      </td>
                      <td className="num" data-label="Replied">
                        {s.funnel.replied} <span className="muted">({pct(s.replyRate)})</span>
                      </td>
                      <td className="num cell-action" onClick={(e) => e.stopPropagation()}>
                        {writer && (
                          <Button size="sm" busy={busy === `t${c.id}`} onClick={() => toggle(c)}>
                            {c.status === 'active' ? 'Pause' : 'Start'}
                          </Button>
                        )}
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
  // Until the user picks, the first account is preselected.
  const [picked, setPicked] = useState<number[] | null>(null);
  const { busy, run } = useAction();
  const chosen = picked ?? (accounts.data?.length ? [accounts.data[0].id] : []);

  const create = () =>
    run('create', async () => {
      const c = await api<Campaign>('/api/campaigns', { body: { name: name || 'Untitled campaign', accountIds: chosen } });
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
      <CheckList
        label="Send from"
        options={(accounts.data ?? []).map((a) => ({ value: a.id, label: a.name, sub: a.driver === 'simulator' ? 'Simulated' : undefined, status: a.status }))}
        value={chosen}
        onChange={setPicked}
        empty="Add an account first on the LinkedIn accounts page; you can pick it later."
        hint={accounts.data && accounts.data.length > 1 ? 'Pick several to share the work. Each lead stays with the account that first contacts it.' : undefined}
      />
      <p className="muted" style={{ margin: 0 }}>
        It starts with a proven sequence: view profile, wait a day, invite with a note, then follow up with two messages if they accept or withdraw the invite after 7 days if not. You can change every step.
      </p>
    </Modal>
  );
}

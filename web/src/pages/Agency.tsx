import { useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, useApi, type BrandingSettings, type ClientOverview } from '../api';
import { refreshBranding } from '../branding';
import { BrandMark, Button, Empty, ErrorNote, Field, Modal, Pill, Stat, useAction } from '../components/ui';
import { pct, timeAgo } from '../format';
import type { Me } from '../session';

// Agency mode: every client workspace at a glance, client management and white-label branding.
export default function Agency({ me, onMe }: { me: Me; onMe: (me: Me) => void }) {
  const [days, setDays] = useState(30);
  const overview = useApi<{ agency: { id: number; name: string }; days: number; clients: ClientOverview[] }>(`/api/agency/overview?days=${days}`, 30_000);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<ClientOverview | null>(null);
  const [deleting, setDeleting] = useState<ClientOverview | null>(null);
  const navigate = useNavigate();
  const { busy, run } = useAction();
  // Renaming and deleting clients is for the agency's owners (inside a client, the role is the inherited one).
  const owner = me.role === 'owner';
  const clients = overview.data?.clients ?? [];
  const sum = (k: 'contacted' | 'replies' | 'meetings' | 'activeCampaigns') => clients.reduce((n, c) => n + c[k], 0);

  const open = (id: number) =>
    run(`open${id}`, async () => {
      const r = await api<{ user: Me }>('/api/workspaces/switch', { body: { workspaceId: id } });
      navigate('/');
      onMe(r.user);
    });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agency</h1>
          <p>
            {me.agency?.name ?? 'Your agency'}: every client workspace at a glance. Open a client to run its campaigns; your owners and admins can open them all.
          </p>
        </div>
        <div className="row">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }} aria-label="Time range">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <Button variant="primary" onClick={() => setCreating(true)}>
            Add client
          </Button>
        </div>
      </div>
      <ErrorNote error={overview.error} />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Clients" value={clients.length} sub={`${sum('activeCampaigns')} active campaigns`} />
        <Stat label="Leads contacted" value={sum('contacted')} sub={`last ${days} days`} />
        <Stat label="Replies" value={sum('replies')} sub={pct(sum('contacted') ? Math.round((sum('replies') / sum('contacted')) * 1000) / 10 : 0) + ' reply rate'} />
        <Stat label="Meetings" value={sum('meetings')} sub="booked replies or moved to the meeting stage" />
      </div>

      <div className="card card-flush" style={{ marginBottom: 16 }}>
        {overview.data && !clients.length ? (
          <Empty title="No clients yet" action={<Button variant="primary" onClick={() => setCreating(true)}>Add your first client</Button>}>
            Each client gets its own workspace: LinkedIn accounts, mailboxes, leads, campaigns and inbox stay separate. Invite the client from its Settings with
            the Client role to give them a read-only view.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Needs attention</th>
                  <th className="num">Active campaigns</th>
                  <th className="num">Contacted</th>
                  <th className="num">Replies</th>
                  <th className="num">Meetings</th>
                  <th>Last activity</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div className="cell-title">{c.name}</div>
                      <div className="cell-sub">
                        {c.accounts} LinkedIn account{c.accounts === 1 ? '' : 's'}
                        {me.workspace_id === c.id && ' · open now'}
                      </div>
                    </td>
                    <td>
                      {!c.accountsNeedingAttention && !c.mailboxesNeedingAttention && <span className="muted">Nothing</span>}
                      {!!c.accountsNeedingAttention && <Pill status="needs_login">{c.accountsNeedingAttention} account{c.accountsNeedingAttention === 1 ? '' : 's'}</Pill>}{' '}
                      {!!c.mailboxesNeedingAttention && <Pill status="needs_attention">{c.mailboxesNeedingAttention} mailbox{c.mailboxesNeedingAttention === 1 ? '' : 'es'}</Pill>}
                    </td>
                    <td className="num">{c.activeCampaigns}</td>
                    <td className="num">{c.contacted}</td>
                    <td className="num">
                      {c.replies} <span className="muted">({pct(c.replyRate)})</span>
                    </td>
                    <td className="num">{c.meetings}</td>
                    <td className="muted">{c.lastActivityAt ? timeAgo(c.lastActivityAt) : 'None yet'}</td>
                    <td className="num">
                      <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        <Button size="sm" busy={busy === `open${c.id}`} onClick={() => open(c.id)} disabled={me.workspace_id === c.id} aria-label={`Open ${c.name}`}>
                          Open
                        </Button>
                        {owner && (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => setRenaming(c)} aria-label={`Rename ${c.name}`}>
                              Rename
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setDeleting(c)} aria-label={`Delete ${c.name}`}>
                              Delete
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <BrandingCard me={me} />

      {creating && (
        <NameModal
          title="Add client"
          label="Client name"
          action="Create client"
          onClose={() => setCreating(false)}
          onSave={async (name) => {
            await api('/api/agency/clients', { body: { name } });
            await overview.reload();
          }}
        />
      )}
      {renaming && (
        <NameModal
          title={`Rename ${renaming.name}`}
          label="Client name"
          action="Save"
          initial={renaming.name}
          onClose={() => setRenaming(null)}
          onSave={async (name) => {
            await api(`/api/agency/clients/${renaming.id}`, { method: 'PATCH', body: { name } });
            await overview.reload();
          }}
        />
      )}
      {deleting && (
        <DeleteClient
          client={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={async () => {
            // Deleting the client you are in moves your session back to the agency.
            if (me.workspace_id === deleting.id) onMe((await api<{ user: Me }>('/api/auth/me')).user);
            await overview.reload();
          }}
        />
      )}
    </>
  );
}

function NameModal({ title, label, action, initial = '', onClose, onSave }: { title: string; label: string; action: string; initial?: string; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial);
  const { busy, run } = useAction();
  const save = () => run('save', async () => (await onSave(name.trim()), onClose()));
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <Button variant="primary" busy={busy === 'save'} disabled={!name.trim()} onClick={save}>
          {action}
        </Button>
      }
    >
      <Field label={label}>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus onKeyDown={(e) => e.key === 'Enter' && name.trim() && save()} />
      </Field>
    </Modal>
  );
}

function DeleteClient({ client, onClose, onDeleted }: { client: ClientOverview; onClose: () => void; onDeleted: () => Promise<void> }) {
  const [confirm, setConfirm] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal
      title={`Delete ${client.name}`}
      onClose={onClose}
      footer={
        <Button
          variant="danger"
          busy={busy === 'delete'}
          disabled={confirm.trim() !== client.name.trim()}
          onClick={() => run('delete', async () => (await api(`/api/agency/clients/${client.id}`, { method: 'DELETE', body: { confirm } }), await onDeleted(), onClose()), `${client.name} deleted`)}
        >
          Delete client and its data
        </Button>
      }
    >
      <p style={{ margin: 0 }}>
        This deletes the workspace with its LinkedIn accounts, mailboxes, leads, campaigns, conversations and history. It can't be undone. People who only
        belong to this client lose their login.
      </p>
      <Field label={`Type ${client.name} to confirm`}>
        <input type="text" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
      </Field>
    </Modal>
  );
}

type BrandingForm = { productName: string; logoUrl: string; primaryColor: string; supportEmail: string; customDomain: string };
const FIELDS: (keyof BrandingForm)[] = ['productName', 'logoUrl', 'primaryColor', 'supportEmail', 'customDomain'];

// White-label for the open workspace: the agency's own branding, or a client's overrides of it
// (empty fields inherit the agency's values).
function BrandingCard({ me }: { me: Me }) {
  const settings = useApi<BrandingSettings>('/api/agency/branding');
  const [f, setF] = useState<BrandingForm | null>(null);
  const { busy, run } = useAction();
  const s = settings.data;
  useEffect(() => {
    if (s) setF(Object.fromEntries(FIELDS.map((k) => [k, s[k] ?? ''])) as BrandingForm);
  }, [s]);
  if (!s || !f) return <ErrorNote error={settings.error} />;

  const isClient = me.workspace_kind === 'client';
  const inherited = s.inherited;
  const placeholder = (k: Exclude<keyof BrandingForm, 'customDomain'>, fallback: string) => (isClient && inherited?.[k] ? `${inherited[k]} (from ${me.parent_name ?? 'the agency'})` : fallback);
  const validColor = /^#[0-9a-f]{6}$/i.test(f.primaryColor);
  // The preview shows what the form would give, before saving.
  const preview = {
    productName: f.productName.trim() || (isClient ? inherited?.productName : null) || 'OpenReach',
    logoUrl: f.logoUrl.trim() || (isClient ? inherited?.logoUrl : null) || null,
    color: (validColor ? f.primaryColor : null) || (isClient ? inherited?.primaryColor : null) || null,
  };
  const previewStyle = preview.color
    ? ({ '--accent': preview.color, '--accent-soft': `color-mix(in srgb, ${preview.color} 14%, var(--surface))`, '--accent-text': `color-mix(in srgb, ${preview.color} 75%, var(--ink))` } as CSSProperties)
    : undefined;
  const save = () =>
    run(
      'branding',
      async () => {
        // The domain is sent only by those who may change it.
        const body = Object.fromEntries(FIELDS.filter((k) => k !== 'customDomain' || s.canEditDomain).map((k) => [k, f[k].trim()]));
        settings.setData(await api<BrandingSettings>('/api/agency/branding', { method: 'PUT', body }));
        refreshBranding();
      },
      'Branding saved',
    );
  const set = (k: keyof BrandingForm) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="card">
      <div className="card-head">
        <h2>{isClient ? `Branding for ${me.workspace_name}` : 'White-label branding'}</h2>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {isClient
          ? `Leave a field empty to use ${me.parent_name ?? 'the agency'}'s value. Clients see this branding when they sign in.`
          : 'Your name, logo and color replace OpenReach for your team and your clients. Clients inherit it unless you override it in their workspace.'}
      </p>
      <div className="grid grid-main-side" style={{ alignItems: 'start' }}>
        <div className="stack">
          <div className="grid grid-2">
            <Field label="Product name" hint="Up to 40 characters; shown in the sidebar, sign-in page and tab title.">
              <input type="text" value={f.productName} onChange={set('productName')} maxLength={40} placeholder={placeholder('productName', 'OpenReach')} />
            </Field>
            <Field label="Support email" hint="Shown as a help link on the sign-in page and sidebar.">
              <input type="email" value={f.supportEmail} onChange={set('supportEmail')} placeholder={placeholder('supportEmail', 'help@youragency.com')} />
            </Field>
          </div>
          <Field label="Logo URL" hint="An https:// image, about 28 pixels high.">
            <input type="url" value={f.logoUrl} onChange={set('logoUrl')} placeholder={placeholder('logoUrl', 'https://youragency.com/logo.png')} />
          </Field>
          <div className="grid grid-2">
            <Field label="Primary color" hint="Buttons, links and highlights." error={f.primaryColor && !validColor ? 'Use a color like #4f46e5' : null}>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input type="color" value={validColor ? f.primaryColor : '#5b4bdb'} onChange={set('primaryColor')} aria-label="Pick primary color" style={{ width: 44, padding: 2 }} />
                <input type="text" value={f.primaryColor} onChange={set('primaryColor')} placeholder={placeholder('primaryColor', '#5b4bdb')} aria-label="Primary color (hex)" />
              </div>
            </Field>
            <Field
              label="Custom domain"
              hint={
                s.canEditDomain
                  ? 'Optional, e.g. app.youragency.com. Point its DNS at this server and add TLS for it at your proxy (see README).'
                  : 'Only the agency owner can set or change the custom domain.'
              }
            >
              <input type="text" value={f.customDomain} onChange={set('customDomain')} placeholder="app.youragency.com" disabled={!s.canEditDomain} />
            </Field>
          </div>
          <div>
            <Button variant="primary" busy={busy === 'branding'} disabled={!!f.primaryColor && !validColor} onClick={save}>
              Save branding
            </Button>
          </div>
        </div>
        <div className="brand-preview" style={previewStyle} role="group" aria-label="Branding preview">
          <BrandMark name={preview.productName} logoUrl={preview.logoUrl} />
          <div className="nav">
            <a className="active" aria-hidden>
              Dashboard
            </a>
            <a aria-hidden>Campaigns</a>
          </div>
          <Button variant="primary" tabIndex={-1}>
            Sign in
          </Button>
        </div>
      </div>
    </div>
  );
}

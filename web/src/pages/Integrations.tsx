import { useState } from 'react';
import { api, serverNow, useApi, type EnrichmentSettings, type FieldSpec, type Integration, type KindStatus, type ProviderDef, type ProviderKind, type UsageRow } from '../api';
import type { Me } from '../App';
import { Button, ConfirmButton, ErrorNote, Field, Modal, Pill, ProviderBadge, SecretField, Toggle, useAction, useToast } from '../components/ui';
import { KIND_HELP, KIND_LABELS, KIND_ORDER, timeAgo, USAGE_OPERATION_LABELS } from '../format';

type Editing = { kind: ProviderKind; integration?: Integration };

// External services per kind. Until one is added, the built-in simulator stands in (except for CRMs),
// so every feature can be tried without keys. Members only see what is in use.
export default function Integrations({ me }: { me: Me }) {
  const admin = me.role === 'owner' || me.role === 'admin';
  const providers = useApi<ProviderDef[]>('/api/integrations/providers');
  const status = useApi<Record<ProviderKind, KindStatus>>('/api/integrations/status');
  const list = useApi<Integration[]>(admin ? '/api/integrations' : null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const reload = async () => void (await Promise.all([status.reload(), list.reload()]));
  const kinds = KIND_ORDER.filter((k) => providers.data?.some((p) => p.kind === k));

  return (
    <div className="stack">
      <div className="card stack">
        <h2>Providers</h2>
        <p className="muted" style={{ margin: 0 }}>
          Connect services for AI writing, finding and verifying emails, enrichment, CRM sync and SMS. Until you add one, a built-in simulator stands in so you can try every feature without
          keys. It works offline with made-up data and never contacts anyone.
          {!admin && ' Only admins can change providers.'}
        </p>
      </div>
      <ErrorNote error={providers.error ?? status.error ?? list.error} />
      {kinds.map((kind) => (
        <KindCard
          key={kind}
          kind={kind}
          admin={admin}
          status={status.data?.[kind]}
          defs={providers.data!.filter((p) => p.kind === kind)}
          items={(list.data ?? []).filter((i) => i.kind === kind).sort((a, b) => a.priority - b.priority || a.id - b.id)}
          onEdit={setEditing}
          onChange={reload}
        />
      ))}
      <EnrichmentSettingsCard admin={admin} />
      {admin && <UsageCard />}
      {editing && (
        <IntegrationForm
          editing={editing}
          defs={providers.data!.filter((p) => p.kind === editing.kind)}
          taken={(list.data ?? []).filter((i) => i.kind === editing.kind).map((i) => i.provider)}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function KindCard({
  kind,
  admin,
  status,
  defs,
  items,
  onEdit,
  onChange,
}: {
  kind: ProviderKind;
  admin: boolean;
  status?: KindStatus;
  defs: ProviderDef[];
  items: Integration[];
  onEdit: (e: Editing) => void;
  onChange: () => Promise<void>;
}) {
  const toast = useToast();
  const { busy, run } = useAction();
  const canAdd = defs.some((d) => !items.some((i) => i.provider === d.id));
  const move = (index: number, by: -1 | 1) =>
    run(`m${items[index].id}`, async () => {
      const ids = items.map((i) => i.id);
      [ids[index], ids[index + by]] = [ids[index + by], ids[index]];
      await api('/api/integrations/order', { method: 'PUT', body: { kind, ids } });
      await onChange();
    });

  return (
    <section className="card stack" aria-labelledby={`kind-${kind}`}>
      <div className="spread" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 id={`kind-${kind}`}>{KIND_LABELS[kind]}</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            {KIND_HELP[kind]}
          </p>
        </div>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <span className="muted" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
            {status?.provider ? <>In use: {status.label}</> : 'Not connected'}
          </span>
          {status && <ProviderBadge simulated={status.simulated} />}
          {admin && (
            <Button size="sm" disabled={!canAdd} onClick={() => onEdit({ kind })}>
              Add provider
            </Button>
          )}
        </div>
      </div>
      {admin && !items.length && (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {kind === 'crm' ? 'No CRM connected. Add one to sync leads; the simulated CRM lets you try it first.' : 'Nothing set up yet, so the built-in simulator is used.'}
        </p>
      )}
      {admin && !!items.length && (
        <ul className="integration-list">
          {items.map((i, index) => (
            <li key={i.id} className="integration-row">
              <div className="integration-main">
                <div className="row" style={{ gap: 6 }}>
                  <strong>{i.label}</strong>
                  {i.label !== i.providerLabel && <span className="muted">{i.providerLabel}</span>}
                  <ProviderBadge simulated={i.simulated} />
                  {!i.enabled && <Pill status="paused">Off</Pill>}
                  <Pill status={i.lastStatus ?? 'untested'} />
                </div>
                {(i.lastMessage || i.lastCheckedAt) && (
                  <div className="muted" style={{ fontSize: 13 }}>
                    {i.lastMessage}
                    {i.lastCheckedAt ? ` · checked ${timeAgo(i.lastCheckedAt)}` : ''}
                  </div>
                )}
                {i.webhookUrl !== undefined && (
                  <div className="muted" style={{ fontSize: 13 }}>
                    {i.webhookUrl ? (
                      <>
                        Replies and STOP messages: in Twilio, set the number's “A message comes in” webhook (HTTP POST) to{' '}
                        <code className="webhook-url">{i.webhookUrl}</code>
                      </>
                    ) : (
                      'Set PUBLIC_URL on the server to receive replies and STOP messages from Twilio; the webhook URL then shows here.'
                    )}
                  </div>
                )}
              </div>
              <div className="row" style={{ gap: 4 }}>
                {items.length > 1 && (
                  <>
                    <button className="icon-btn" aria-label={`Use ${i.label} earlier`} disabled={index === 0 || !!busy} onClick={() => move(index, -1)}>
                      ↑
                    </button>
                    <button className="icon-btn" aria-label={`Use ${i.label} later`} disabled={index === items.length - 1 || !!busy} onClick={() => move(index, 1)}>
                      ↓
                    </button>
                  </>
                )}
                <Button
                  size="sm"
                  busy={busy === `t${i.id}`}
                  onClick={() =>
                    run(`t${i.id}`, async () => {
                      const r = await api<{ ok: boolean; message: string }>(`/api/integrations/${i.id}/test`, { body: {} });
                      toast(r.message, r.ok ? 'ok' : 'error');
                      await onChange();
                    })
                  }
                >
                  Test connection
                </Button>
                <Button size="sm" onClick={() => onEdit({ kind, integration: i })}>
                  Configure
                </Button>
                <ConfirmButton
                  size="sm"
                  variant="ghost"
                  busy={busy === `d${i.id}`}
                  confirmLabel="Remove?"
                  onConfirm={() => run(`d${i.id}`, async () => (await api(`/api/integrations/${i.id}`, { method: 'DELETE' }), await onChange()), `${i.label} removed`)}
                >
                  Remove
                </ConfirmButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {items.length > 1 && (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          The first working provider in this list is used. Lookups that try several providers go top to bottom.
        </p>
      )}
    </section>
  );
}

const ENRICHMENT_TOGGLES: { key: keyof EnrichmentSettings; label: string; hint: string }[] = [
  { key: 'verifyFound', label: 'Verify found addresses', hint: 'Checks every address a finder returns with the first email verifier above before using it.' },
  { key: 'acceptRisky', label: 'Accept risky addresses', hint: 'Treats accept-all and webmail addresses as good enough: the lookup stops there, and "If email verified" says yes.' },
  { key: 'trustFinderStatus', label: 'Trust the finder’s own check', hint: 'Skips our verification when the finder already verified the address, which saves verifier credits.' },
  { key: 'autoEnrichOnImport', label: 'Find emails for imported leads', hint: 'New leads from CSV files and LinkedIn imports are looked up in the background. Each import can change this.' },
  { key: 'enrichCompany', label: 'Add company data to imported leads', hint: 'Imports that find emails also fetch company facts from the enrichment provider.' },
];

// How the email waterfall behaves: finders are tried in the order of the "Email finder" card above.
function EnrichmentSettingsCard({ admin }: { admin: boolean }) {
  const settings = useApi<EnrichmentSettings>('/api/settings/enrichment');
  const { busy, run } = useAction();
  const save = (patch: Partial<EnrichmentSettings>) =>
    run('save', async () => settings.setData(await api<EnrichmentSettings>('/api/settings/enrichment', { method: 'PUT', body: patch })), 'Saved');
  return (
    <section className="card stack" aria-labelledby="enrichment-settings">
      <div>
        <h2 id="enrichment-settings">Email lookup</h2>
        <p className="muted" style={{ margin: '4px 0 0' }}>
          Finding emails tries each email finder in the order above until one returns an address that passes verification. Addresses people entered (CSV, typed in, LinkedIn) are only replaced when you
          ask for it.{!admin && ' Only admins can change these settings.'}
        </p>
      </div>
      <ErrorNote error={settings.error} />
      {settings.data && (
        <div className="grid grid-2" style={{ gap: 8 }}>
          {ENRICHMENT_TOGGLES.map((t) =>
            admin ? (
              <Toggle key={t.key} checked={settings.data![t.key]} onChange={(v) => !busy && save({ [t.key]: v })} label={t.label} hint={t.hint} />
            ) : (
              <div key={t.key}>
                <strong>{t.label}:</strong> {settings.data![t.key] ? 'on' : 'off'}
                <div className="field-hint">{t.hint}</div>
              </div>
            ),
          )}
        </div>
      )}
    </section>
  );
}

const thisMonth = () => new Date(serverNow()).toISOString().slice(0, 7);
function shiftMonth(month: string, by: number) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

// Calls and credits per provider for one month (UTC), from the usage log.
function UsageCard() {
  const [month, setMonth] = useState(thisMonth);
  const usage = useApi<{ month: string; rows: UsageRow[] }>(`/api/usage?month=${month}`);
  const rows = usage.data?.rows ?? [];
  const label = new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return (
    <section className="card stack" aria-labelledby="usage-title">
      <div className="spread">
        <div>
          <h2 id="usage-title">Usage</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Calls to each provider and the credits they used. Simulated calls are free.
          </p>
        </div>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <button className="icon-btn" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
            ‹
          </button>
          <span style={{ minWidth: 120, textAlign: 'center' }}>{label}</span>
          <button className="icon-btn" aria-label="Next month" disabled={month >= thisMonth()} onClick={() => setMonth(shiftMonth(month, 1))}>
            ›
          </button>
        </div>
      </div>
      <ErrorNote error={usage.error} />
      {usage.data && !rows.length ? (
        <p className="muted" style={{ margin: 0 }}>
          Nothing used in {label}.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th>Provider</th>
                <th>What</th>
                <th className="num">Calls</th>
                <th className="num">Credits</th>
                <th className="num">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.kind}:${r.provider}:${r.operation}`}>
                  <td>{KIND_LABELS[r.kind] ?? r.kind}</td>
                  <td>{r.provider === 'simulated' ? 'Built-in simulator' : r.provider}</td>
                  <td>{USAGE_OPERATION_LABELS[r.operation] ?? r.operation}</td>
                  <td className="num">{r.calls}</td>
                  <td className="num">{r.credits}</td>
                  <td className="num">{r.inputTokens + r.outputTokens ? (r.inputTokens + r.outputTokens).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function IntegrationForm({ editing, defs, taken, onClose, onSaved }: { editing: Editing; defs: ProviderDef[]; taken: string[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const existing = editing.integration;
  const choices = existing ? defs.filter((d) => d.id === existing.provider) : defs.filter((d) => !taken.includes(d.id));
  const [provider, setProvider] = useState(existing?.provider ?? choices[0]?.id ?? '');
  const def = defs.find((d) => d.id === provider);
  const [label, setLabel] = useState(existing?.label ?? '');
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [settings, setSettings] = useState<Record<string, unknown>>(existing?.settings ?? {});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();

  const save = () =>
    run(
      'save',
      async () => {
        setError(null);
        // Only typed secrets are sent; blank ones keep what is saved.
        const credentials = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== ''));
        const body = { label: label.trim() || undefined, enabled, settings, credentials };
        try {
          if (existing) await api(`/api/integrations/${existing.id}`, { method: 'PATCH', body });
          else await api('/api/integrations', { body: { kind: editing.kind, provider, ...body } });
        } catch (e) {
          setError((e as Error).message);
          return;
        }
        await onSaved();
      },
      existing ? 'Saved' : 'Provider added',
    );

  return (
    <Modal
      title={existing ? `Configure ${existing.label}` : `Add provider: ${KIND_LABELS[editing.kind]}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy === 'save'} disabled={!def} onClick={save}>
            {existing ? 'Save' : 'Add provider'}
          </Button>
        </>
      }
    >
      {!existing && (
        <Field label="Provider">
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setSettings({});
              setSecrets({});
            }}
          >
            {choices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      {def && (
        <p className="muted" style={{ margin: 0 }}>
          {def.description} {def.docsUrl && (
            <a href={def.docsUrl} target="_blank" rel="noreferrer">
              Docs
            </a>
          )}
        </p>
      )}
      {def?.simulated && <div className="note note-warning">Simulated: uses made-up data and never contacts anyone. Its output is never sent to real people.</div>}
      <Field label="Name" hint="Shown on this page. Defaults to the provider's name.">
        <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={def?.label} maxLength={100} />
      </Field>
      {def?.fields.map((f) =>
        f.secret ? (
          <SecretField
            key={f.key}
            label={f.label}
            saved={existing?.credentials[f.key]}
            value={secrets[f.key] ?? ''}
            onChange={(v) => setSecrets({ ...secrets, [f.key]: v })}
            required={f.required}
            placeholder={f.placeholder}
            hint={f.help}
          />
        ) : (
          <SettingField key={f.key} field={f} value={settings[f.key]} onChange={(v) => setSettings({ ...settings, [f.key]: v })} />
        ),
      )}
      <Toggle checked={enabled} onChange={setEnabled} label="Enabled" hint="Turned off, it is skipped and the next provider (or the simulator) is used." />
      <ErrorNote error={error} />
    </Modal>
  );
}

// Cleared fields are sent as null, which puts the setting back to the provider's default.
function SettingField({ field: f, value, onChange }: { field: FieldSpec; value: unknown; onChange: (v: unknown) => void }) {
  if (f.type === 'toggle') return <Toggle checked={!!value} onChange={onChange} label={f.label} hint={f.help} />;
  const text = value == null ? '' : String(value);
  return (
    <Field label={f.label} hint={f.help}>
      {f.type === 'select' ? (
        <select value={text} onChange={(e) => onChange(e.target.value || null)} required={f.required}>
          {!f.required && <option value="">Default</option>}
          {f.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : f.type === 'textarea' ? (
        <textarea value={text} onChange={(e) => onChange(e.target.value || null)} placeholder={f.placeholder} required={f.required} rows={4} />
      ) : (
        <input
          type={f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : 'text'}
          value={text}
          onChange={(e) => onChange(e.target.value === '' ? null : f.type === 'number' ? Number(e.target.value) : e.target.value)}
          placeholder={f.placeholder}
          required={f.required}
        />
      )}
    </Field>
  );
}

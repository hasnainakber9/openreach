import { useState } from 'react';
import { api, useApi, type CrmLogItem, type CrmSettings, type Integration, type Stage } from '../api';
import { Button, CheckList, ErrorNote, Field, Pager, Pill, ProviderBadge, Toggle, useAction } from '../components/ui';
import { CRM_EVENT_LABELS, CRM_FIELD_LABELS, CRM_OPERATION_LABELS, dateTime } from '../format';

const DEFAULTS: CrmSettings = {
  triggers: { onReply: true, onStageChange: ['interested', 'meeting'], onCampaignFinished: false, onConnected: false, logMessages: false },
  createDealOn: [],
  dealNameTemplate: '{{company}} – {{fullName}}',
  fieldMapping: {},
};

const TRIGGERS: { key: Exclude<keyof CrmSettings['triggers'], 'onStageChange'>; label: string; hint: string }[] = [
  { key: 'onReply', label: 'Replies', hint: 'Adds each reply (LinkedIn, email, SMS) as a note.' },
  { key: 'logMessages', label: 'Sent messages', hint: 'Adds every message, InMail, email and SMS a campaign sends as a note.' },
  { key: 'onConnected', label: 'Accepted invitations', hint: 'Adds a note when a lead accepts a connection request.' },
  { key: 'onCampaignFinished', label: 'Finished campaigns', hint: 'Adds a note when a lead reaches the end of a campaign.' },
];

const settingsOf = (i: Integration): CrmSettings => {
  const s = i.settings as Partial<CrmSettings>;
  return { ...DEFAULTS, ...s, triggers: { ...DEFAULTS.triggers, ...s.triggers }, fieldMapping: { ...(s.fieldMapping ?? {}) } };
};

// What one CRM receives and when: note triggers, deal stages and the field mapping. Admins only.
export function CrmSyncCard({ integration, onSaved }: { integration: Integration; onSaved: () => Promise<void> }) {
  const stages = useApi<Stage[]>('/api/pipeline/stages');
  const [s, setS] = useState<CrmSettings>(() => settingsOf(integration));
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();
  const stageOptions = (stages.data ?? []).map((st) => ({ value: st.slug, label: st.name }));
  const trig = (patch: Partial<CrmSettings['triggers']>) => setS({ ...s, triggers: { ...s.triggers, ...patch } });
  const save = () =>
    run(
      `crm${integration.id}`,
      async () => {
        setError(null);
        try {
          await api(`/api/integrations/${integration.id}`, { method: 'PATCH', body: { settings: s } });
        } catch (e) {
          setError((e as Error).message);
          return;
        }
        await onSaved();
      },
      'Sync settings saved',
    );
  const id = `crm-sync-${integration.id}`;
  return (
    <section className="card stack" aria-labelledby={id}>
      <div className="row" style={{ gap: 6 }}>
        <h2 id={id}>Sync to {integration.label}</h2>
        <ProviderBadge simulated={integration.simulated} />
        {!integration.enabled && <Pill status="paused">Off</Pill>}
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Each event below creates or updates the lead's contact in {integration.label} (matched by email, else by the LinkedIn URL property) and adds a note. Syncs run in the background and are
        retried when the CRM is busy.
      </p>
      <div className="grid grid-2" style={{ gap: 8 }}>
        {TRIGGERS.map((t) => (
          <Toggle key={t.key} checked={s.triggers[t.key]} onChange={(v) => trig({ [t.key]: v })} label={t.label} hint={t.hint} />
        ))}
      </div>
      <div className="grid grid-2">
        <CheckList label="Log moves to these stages" options={stageOptions} value={s.triggers.onStageChange} onChange={(v) => trig({ onStageChange: v })} empty="Loading stages…" />
        <CheckList
          label="Open a deal when a lead reaches"
          options={stageOptions}
          value={s.createDealOn}
          onChange={(v) => setS({ ...s, createDealOn: v })}
          hint="One deal per lead, linked to the contact."
          empty="Loading stages…"
        />
      </div>
      <Field label="Deal name" hint="Lead variables such as {{company}}, {{fullName}} or {{title}}.">
        <input type="text" value={s.dealNameTemplate} onChange={(e) => setS({ ...s, dealNameTemplate: e.target.value })} maxLength={200} />
      </Field>
      <div>
        <h3 style={{ marginBottom: 4 }}>Field mapping</h3>
        <p className="field-hint" style={{ margin: '0 0 6px' }}>
          The CRM property (its internal name) each field is copied to. Leave a row empty to skip that field; empty lead values never overwrite the CRM. Name a property for the LinkedIn URL to match
          leads that have no email.{integration.mappingHelp ? ` ${integration.mappingHelp}` : ''}
        </p>
        <div className="table-wrap">
          <table className="crm-mapping">
            <thead>
              <tr>
                <th>OpenReach field</th>
                <th>CRM property</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(CRM_FIELD_LABELS).map(([field, label]) => (
                <tr key={field}>
                  <td>{label}</td>
                  <td>
                    <input
                      type="text"
                      aria-label={`CRM property for ${label}`}
                      value={s.fieldMapping[field] ?? ''}
                      onChange={(e) => setS({ ...s, fieldMapping: { ...s.fieldMapping, [field]: e.target.value.trim() } })}
                      placeholder="Not synced"
                      maxLength={100}
                      spellCheck={false}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <ErrorNote error={error ?? stages.error} />
      <div className="row">
        <Button variant="primary" busy={busy === `crm${integration.id}`} onClick={save}>
          Save sync settings
        </Button>
      </div>
    </section>
  );
}

// Every CRM call with its result, newest first; failed syncs can be retried.
export function CrmLogCard({ crms }: { crms: Integration[] }) {
  const [integrationId, setIntegrationId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const q = new URLSearchParams({ page: String(page), ...(integrationId ? { integrationId } : {}), ...(status ? { status } : {}) });
  const log = useApi<{ total: number; pageSize: number; items: CrmLogItem[] }>(`/api/crm/log?${q}`, 10_000);
  const { busy, run } = useAction();
  const retry = (item: CrmLogItem) =>
    run(
      `r${item.id}`,
      async () => {
        await api(`/api/crm/log/${item.id}/retry`, { body: {} });
        await log.reload();
      },
      'Sync queued again',
    );
  return (
    <section className="card stack" aria-labelledby="crm-log">
      <div className="spread">
        <div>
          <h2 id="crm-log">CRM sync log</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Kept for 90 days. Errors are retried automatically, except rejected credentials: fix the integration, then retry.
          </p>
        </div>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          {crms.length > 1 && (
            <select aria-label="CRM" value={integrationId} onChange={(e) => (setIntegrationId(e.target.value), setPage(1))}>
              <option value="">All CRMs</option>
              {crms.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          <select aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
            <option value="">Any status</option>
            <option value="ok">OK</option>
            <option value="error">Errors</option>
            <option value="skipped">Skipped</option>
          </select>
        </div>
      </div>
      <ErrorNote error={log.error} />
      {log.data && !log.data.items.length ? (
        <p className="muted" style={{ margin: 0 }}>
          Nothing synced yet.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Lead</th>
                {crms.length > 1 && <th>CRM</th>}
                <th>Event</th>
                <th>Step</th>
                <th>Status</th>
                <th>Details</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {log.data?.items.map((i) => (
                <tr key={i.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{dateTime(i.createdAt)}</td>
                  <td>{i.leadName ?? '—'}</td>
                  {crms.length > 1 && <td>{i.integration ?? '—'}</td>}
                  <td>{CRM_EVENT_LABELS[i.event] ?? i.event}</td>
                  <td>{CRM_OPERATION_LABELS[i.operation] ?? i.operation}</td>
                  <td>
                    <Pill status={i.status} />
                  </td>
                  <td className={i.status === 'error' ? 'field-error' : 'muted'} style={{ maxWidth: 360 }}>
                    {i.message ?? (i.externalId ? `id ${i.externalId}` : '')}
                  </td>
                  <td>
                    {i.status === 'error' && <LogAction item={i} busy={busy === `r${i.id}`} onRetry={() => retry(i)} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {log.data && <Pager page={page} pageSize={log.data.pageSize} total={log.data.total} onPage={setPage} />}
    </section>
  );
}

// What can still be done about a failed step: nothing while the queue is on it or once a later attempt got past it.
function LogAction({ item, busy, onRetry }: { item: CrmLogItem; busy: boolean; onRetry: () => void }) {
  if (item.resolved) return <span className="muted">Recovered on retry</span>;
  if (item.jobStatus === 'queued' || item.jobStatus === 'running') return <span className="muted">Retrying</span>;
  return (
    <Button size="sm" busy={busy} onClick={onRetry} aria-label={`Retry sync for ${item.leadName ?? 'lead'}`}>
      Retry
    </Button>
  );
}

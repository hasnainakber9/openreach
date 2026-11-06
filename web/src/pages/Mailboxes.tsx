import { useState } from 'react';
import type { Me } from '../App';
import { api, useApi, type DomainReport, type Mailbox, type MailboxPreset } from '../api';
import { Button, ConfirmButton, Empty, ErrorNote, Field, Meter, Modal, Pill, ProviderBadge, SecretField, Toggle, useAction } from '../components/ui';
import { timeAgo, WEEKDAYS } from '../format';

type TestResult = { smtp: { ok: boolean; message: string }; imap: { ok: boolean; message: string } };

export default function Mailboxes({ me }: { me: Me }) {
  const mailboxes = useApi<Mailbox[]>('/api/mailboxes', 15_000);
  const presets = useApi<MailboxPreset[]>('/api/mailboxes/presets');
  const [editing, setEditing] = useState<Mailbox | 'new' | null>(null);
  const [tests, setTests] = useState<Record<number, TestResult>>({});
  const { busy, run } = useAction();
  const admin = me.role === 'owner' || me.role === 'admin';

  const act = (m: Mailbox, what: 'pause' | 'resume' | 'sync') =>
    run(
      `${what}${m.id}`,
      async () => {
        await api(`/api/mailboxes/${m.id}/${what}`, { body: {} });
        await mailboxes.reload();
      },
      { pause: 'Mailbox paused', resume: 'Mailbox resumed', sync: 'Checking for replies' }[what],
    );
  const test = (m: Mailbox) =>
    run(`test${m.id}`, async () => {
      const r = await api<TestResult>(`/api/mailboxes/${m.id}/test`, { body: {} });
      setTests((t) => ({ ...t, [m.id]: r }));
    });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Mailboxes</h1>
          <p>Email steps go out from these addresses. Each mailbox keeps to its own daily limit, warm-up, sending hours and random gaps, and reads replies and bounces over IMAP.</p>
        </div>
        {admin && (
          <Button variant="primary" onClick={() => setEditing('new')}>
            Add mailbox
          </Button>
        )}
      </div>

      {mailboxes.data && !mailboxes.data.length && (
        <div className="card">
          <Empty title="No mailboxes yet" action={admin ? <Button variant="primary" onClick={() => setEditing('new')}>Add mailbox</Button> : undefined}>
            Connect a Gmail, Microsoft 365 or other SMTP mailbox with an app password, or add a simulated mailbox to try email steps without sending anything.
            {!admin && ' Ask an admin to add one.'}
          </Empty>
        </div>
      )}

      <div className="grid grid-2">
        {mailboxes.data?.map((m) => {
          const t = tests[m.id];
          return (
            <div className="card stack" key={m.id}>
              <div className="spread">
                <div>
                  <h2 className="row" style={{ gap: 8 }}>
                    {m.name} <ProviderBadge simulated={m.simulated} />
                  </h2>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail}
                    {!m.simulated && ` · ${presets.data?.find((p) => p.id === m.preset)?.label ?? 'SMTP'}`}
                  </div>
                </div>
                {m.overPlan ? <Pill status="paused">Over plan limit</Pill> : <Pill status={m.status} />}
              </div>
              {m.statusMessage && <div className={`note ${m.overPlan ? 'note-warning' : 'note-error'}`}>{m.statusMessage}</div>}
              {m.simulated && <div className="note">Simulated: emails are recorded but never delivered, and made-up replies and bounces come back so you can try the whole flow.</div>}
              {!m.simulated && !m.hasImap && (
                <div className="note note-warning">
                  No IMAP settings: replies and bounces from this mailbox aren’t detected, so sequences won’t stop when people answer
                  {m.unsubscribe !== 'reply'
                    ? '.'
                    : m.legacyAccountId
                      ? ', and replies asking to unsubscribe must be added to the do-not-contact list by hand.'
                      : '. With no unsubscribe link, campaign emails ask people to reply “unsubscribe”, so this mailbox can’t send them until it has IMAP settings.'}
                </div>
              )}
              {!m.simulated && m.hasImap && m.unsubscribe === 'reply' && m.status !== 'needs_attention' && (
                <div className="note">
                  No unsubscribe link: this server has no public address (PUBLIC_URL), so campaign emails ask people to{' '}
                  {m.replyTo && m.replyTo.toLowerCase() !== m.fromEmail.toLowerCase() ? `email ${m.fromEmail} with the subject “unsubscribe”` : 'reply “unsubscribe”'} instead. Such
                  messages put them on the do-not-contact list automatically.
                </div>
              )}
              <Meter label="Sent today" used={m.sentToday} limit={m.effectiveLimit} />
              {m.warmup && m.effectiveLimit < m.dailyLimit && (
                <div className="note">
                  Warming up: day {m.warmupDay + 1} of {m.warmupDays}. Today’s limit is {m.effectiveLimit} of {m.dailyLimit}.
                </div>
              )}
              <div className="muted" style={{ fontSize: 13 }}>
                {m.workDays.map((d) => WEEKDAYS[d]).join(', ')} · {m.workStart}–{m.workEnd} ({m.timezone}) · {m.working ? 'sending window open' : `next window ${timeAgo(m.nextWorkingAt)}`} · {m.gapMinSec}–{m.gapMaxSec}s between emails · replies checked {timeAgo(m.lastSyncAt || null)}
                {m.campaigns ? ` · used by ${m.campaigns} campaign${m.campaigns === 1 ? '' : 's'}` : ''}
              </div>
              {t && (
                <div className="stack" style={{ gap: 4 }} aria-live="polite">
                  <div className={`note ${t.smtp.ok ? '' : 'note-error'}`}>SMTP: {t.smtp.message}</div>
                  <div className={`note ${t.imap.ok ? '' : 'note-warning'}`}>IMAP: {t.imap.message}</div>
                </div>
              )}
              <div className="row">
                {admin && (
                  <Button size="sm" onClick={() => setEditing(m)}>
                    Edit
                  </Button>
                )}
                {admin && (
                  <Button size="sm" busy={busy === `test${m.id}`} onClick={() => test(m)}>
                    Test connection
                  </Button>
                )}
                {(m.simulated || m.hasImap) && (
                  <Button size="sm" busy={busy === `sync${m.id}`} onClick={() => act(m, 'sync')}>
                    Check replies now
                  </Button>
                )}
                {admin &&
                  (m.status === 'active' ? (
                    <Button size="sm" busy={busy === `pause${m.id}`} onClick={() => act(m, 'pause')}>
                      Pause
                    </Button>
                  ) : (
                    <Button size="sm" variant="primary" busy={busy === `resume${m.id}`} onClick={() => act(m, 'resume')}>
                      Resume
                    </Button>
                  ))}
              </div>
            </div>
          );
        })}
      </div>

      <Deliverability mailboxes={mailboxes.data ?? []} />

      {editing && (
        <MailboxModal
          mailbox={editing === 'new' ? null : editing}
          presets={presets.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => (setEditing(null), mailboxes.reload())}
        />
      )}
    </>
  );
}

const CHECK_LABELS: Record<string, string> = { mx: 'MX (receives mail)', spf: 'SPF (allowed senders)', dkim: 'DKIM (signing key)', dmarc: 'DMARC (policy)' };
const CHECK_TONE: Record<string, string> = { pass: 'active', warn: 'paused', fail: 'failed' };
const CHECK_TEXT: Record<string, string> = { pass: 'Pass', warn: 'Check', fail: 'Missing' };

function Deliverability({ mailboxes }: { mailboxes: Mailbox[] }) {
  const domains = [...new Set(mailboxes.map((m) => m.domain).filter(Boolean))];
  const [domain, setDomain] = useState('');
  const [selector, setSelector] = useState('');
  const [report, setReport] = useState<DomainReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();
  const target = domain || domains[0] || '';
  // A mailbox on this domain tells the check which provider's SPF include to expect.
  const mailboxId = mailboxes.find((m) => m.domain === target)?.id;

  const check = () =>
    run('check', async () => {
      setError(null);
      try {
        setReport(await api<DomainReport>('/api/deliverability/check', { body: { domain: target, ...(selector.trim() ? { dkimSelector: selector.trim() } : {}), ...(mailboxId ? { mailboxId, domain: target } : {}) } }));
      } catch (e) {
        setError((e as Error).message);
      }
    });

  return (
    <div className="card stack" style={{ marginTop: 16 }}>
      <div>
        <h2>Deliverability check</h2>
        <p className="muted" style={{ margin: '4px 0 0' }}>Looks up your sending domain’s DNS records. Fixing what fails here keeps campaign email out of spam folders.</p>
      </div>
      <div className="grid grid-3" style={{ alignItems: 'start' }}>
        <Field label="Domain">
          <input type="text" list="mailbox-domains" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder={domains[0] ?? 'example.com'} />
          <datalist id="mailbox-domains">
            {domains.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </Field>
        <Field label="DKIM selector" hint="Optional. The s= value in a sent email’s DKIM-Signature header. Leave blank to try common ones.">
          <input type="text" value={selector} onChange={(e) => setSelector(e.target.value)} placeholder="google" />
        </Field>
        <div className="field-action">
          <Button variant="primary" busy={busy === 'check'} disabled={!target} onClick={check}>
            Check DNS
          </Button>
        </div>
      </div>
      <ErrorNote error={error} />
      {report && (
        <table className="table">
          <caption className="muted" style={{ textAlign: 'left', paddingBottom: 6 }}>
            Results for {report.domain}
          </caption>
          <thead>
            <tr>
              <th scope="col">Record</th>
              <th scope="col">Result</th>
              <th scope="col">What it means</th>
            </tr>
          </thead>
          <tbody>
            {report.checks.map((c) => (
              <tr key={c.id}>
                <td>{CHECK_LABELS[c.id]}</td>
                <td>
                  <Pill status={CHECK_TONE[c.status]}>{CHECK_TEXT[c.status]}</Pill>
                </td>
                <td>
                  <div>{c.message}</div>
                  {c.record && <code className="cell-sub" style={{ wordBreak: 'break-all' }}>{c.record}</code>}
                  {c.fix && <div className="cell-sub">Fix: {c.fix}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

type ServerForm = { host: string; port: number; secure: boolean; user: string; pass: string };
const blankServer = (s?: Partial<ServerForm> | null): ServerForm => ({ host: '', port: 587, secure: false, user: '', pass: '', ...(s ?? {}), ...(s ? { pass: '' } : {}) });

function MailboxModal({ mailbox, presets, onClose, onSaved }: { mailbox: Mailbox | null; presets: MailboxPreset[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: mailbox?.name ?? '',
    provider: mailbox?.provider ?? ('smtp' as Mailbox['provider']),
    preset: mailbox?.preset ?? ('gmail' as Mailbox['preset']),
    fromName: mailbox?.fromName ?? '',
    fromEmail: mailbox?.fromEmail ?? '',
    replyTo: mailbox?.replyTo ?? '',
    signature: mailbox?.signature ?? '',
    smtp: blankServer(mailbox?.smtp ?? { host: 'smtp.gmail.com', port: 465, secure: true }),
    imapOn: mailbox ? mailbox.hasImap : true,
    imap: blankServer(mailbox?.imap ?? { host: 'imap.gmail.com', port: 993, secure: true }),
    timezone: mailbox?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    workDays: mailbox?.workDays ?? [1, 2, 3, 4, 5],
    workStart: mailbox?.workStart ?? '08:00',
    workEnd: mailbox?.workEnd ?? '18:00',
    dailyLimit: mailbox?.dailyLimit ?? 40,
    warmup: mailbox?.warmup ?? true,
    warmupDays: mailbox?.warmupDays ?? 14,
    warmupStart: mailbox?.warmupStart ?? 5,
    gapMinSec: mailbox?.gapMinSec ?? 120,
    gapMaxSec: mailbox?.gapMaxSec ?? 420,
  });
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const real = f.provider === 'smtp';
  const preset = presets.find((p) => p.id === f.preset);

  const choosePreset = (id: Mailbox['preset']) => {
    const p = presets.find((x) => x.id === id);
    setF((cur) => ({
      ...cur,
      preset: id,
      smtp: p?.smtp ? { ...cur.smtp, ...p.smtp, user: cur.smtp.user || cur.fromEmail } : cur.smtp,
      imap: p?.imap ? { ...cur.imap, ...p.imap, user: cur.imap.user || cur.fromEmail } : cur.imap,
    }));
  };

  // Blank passwords are left out, so the saved ones are kept (for the same server and user only).
  const server = (s: ServerForm) => ({ host: s.host.trim(), port: s.port, secure: s.secure, user: s.user.trim(), ...(s.pass ? { pass: s.pass } : {}) });
  const save = () =>
    run('save', async () => {
      setError(null);
      const body: Record<string, unknown> = {
        name: f.name,
        provider: f.provider,
        preset: f.preset,
        fromName: f.fromName,
        fromEmail: f.fromEmail,
        replyTo: f.replyTo.trim() || null,
        signature: f.signature,
        timezone: f.timezone,
        workDays: f.workDays,
        workStart: f.workStart,
        workEnd: f.workEnd,
        dailyLimit: f.dailyLimit,
        warmup: f.warmup,
        warmupDays: f.warmupDays,
        warmupStart: f.warmupStart,
        gapMinSec: f.gapMinSec,
        gapMaxSec: f.gapMaxSec,
      };
      if (real) {
        body.smtp = server(f.smtp);
        body.imap = f.imapOn ? server(f.imap) : null;
      }
      try {
        await api(mailbox ? `/api/mailboxes/${mailbox.id}` : '/api/mailboxes', { method: mailbox ? 'PATCH' : 'POST', body });
        onSaved();
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const remove = () =>
    mailbox &&
    run('del', async () => {
      await api(`/api/mailboxes/${mailbox.id}`, { method: 'DELETE' });
      onSaved();
    });

  const serverFields = (which: 'smtp' | 'imap', saved: Mailbox['smtp']) => {
    const s = f[which];
    const put = (patch: Partial<ServerForm>) => set(which, { ...s, ...patch });
    const label = which.toUpperCase();
    return (
      <div className="grid grid-3">
        <Field label={`${label} host`}>
          <input type="text" value={s.host} onChange={(e) => put({ host: e.target.value })} placeholder={which === 'smtp' ? 'smtp.example.com' : 'imap.example.com'} autoComplete="off" />
        </Field>
        <Field label={`${label} port`}>
          <input type="number" min={1} max={65535} value={s.port} onChange={(e) => put({ port: Number(e.target.value) })} />
        </Field>
        <div style={{ alignSelf: 'end', paddingBottom: 8 }}>
          <Toggle checked={s.secure} onChange={(secure) => put({ secure })} label="TLS from the start" hint={which === 'smtp' ? 'On for port 465; off for 587 (STARTTLS is required then).' : 'On for port 993.'} />
        </div>
        <Field label={`${label} username`}>
          <input type="text" value={s.user} onChange={(e) => put({ user: e.target.value })} autoComplete="off" />
        </Field>
        <SecretField
          label={`${label} password`}
          saved={saved?.pass || null}
          value={s.pass}
          onChange={(pass) => put({ pass })}
          placeholder="App password"
          hint={saved?.pass ? 'Enter it again if you change the host, port or username.' : undefined}
        />
      </div>
    );
  };

  return (
    <Modal
      title={mailbox ? `Edit ${mailbox.name}` : 'Add mailbox'}
      wide
      onClose={onClose}
      footer={
        <>
          {mailbox && (
            <ConfirmButton variant="danger" busy={busy === 'del'} onConfirm={remove} confirmLabel="Click again to remove" style={{ marginRight: 'auto' }}>
              Remove mailbox
            </ConfirmButton>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy === 'save'} disabled={!f.name.trim() || !f.fromEmail.trim()} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-2">
        <Field label="Name">
          <input type="text" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Sara – outreach" autoFocus />
        </Field>
        <Field label="Type">
          <select value={f.provider} onChange={(e) => set('provider', e.target.value as Mailbox['provider'])} disabled={!!mailbox}>
            <option value="smtp">Real mailbox (SMTP + IMAP)</option>
            <option value="simulated">Simulated mailbox (sends nothing)</option>
          </select>
        </Field>
        <Field label="From name">
          <input type="text" value={f.fromName} onChange={(e) => set('fromName', e.target.value)} placeholder="Sara Lee" />
        </Field>
        <Field label="From address">
          <input type="email" value={f.fromEmail} onChange={(e) => set('fromEmail', e.target.value)} placeholder="sara@yourcompany.com" />
        </Field>
        <Field label="Reply-to (optional)" hint="Where replies go when it isn't the from address. Replies are only detected in this mailbox's own inbox.">
          <input type="email" value={f.replyTo} onChange={(e) => set('replyTo', e.target.value)} />
        </Field>
      </div>
      <Field label="Signature" hint="Added under every email from this mailbox.">
        <textarea rows={3} value={f.signature} onChange={(e) => set('signature', e.target.value)} />
      </Field>

      {real ? (
        <>
          <h3>Server</h3>
          <Field label="Provider">
            <select value={f.preset} onChange={(e) => choosePreset(e.target.value as Mailbox['preset'])}>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          {preset && <div className="note">{preset.help}</div>}
          {serverFields('smtp', mailbox?.smtp ?? null)}
          <Toggle checked={f.imapOn} onChange={(v) => set('imapOn', v)} label="Read replies and bounces over IMAP" hint="Recommended: replies stop sequences and show in the inbox, and bounces mark addresses invalid. Read-only; messages stay unread." />
          {f.imapOn && serverFields('imap', mailbox?.imap ?? null)}
        </>
      ) : (
        <div className="note">A simulated mailbox records emails without delivering them, answers some of them with made-up replies and bounces addresses containing “bounce”.</div>
      )}

      <h3>Sending window</h3>
      <div className="grid grid-3">
        <Field label="Time zone">
          <input type="text" value={f.timezone} onChange={(e) => set('timezone', e.target.value)} placeholder="Europe/London" />
        </Field>
        <Field label="Start">
          <input type="time" value={f.workStart} onChange={(e) => set('workStart', e.target.value)} />
        </Field>
        <Field label="End">
          <input type="time" value={f.workEnd} onChange={(e) => set('workEnd', e.target.value)} />
        </Field>
      </div>
      <div className="daypicker" role="group" aria-label="Sending days">
        {WEEKDAYS.map((d, i) => (
          <button key={d} type="button" className={f.workDays.includes(i) ? 'on' : ''} aria-pressed={f.workDays.includes(i)} onClick={() => set('workDays', f.workDays.includes(i) ? f.workDays.filter((x) => x !== i) : [...f.workDays, i])}>
            {d}
          </button>
        ))}
      </div>
      <div className="grid grid-2">
        <Field label="Shortest gap between emails (seconds)">
          <input type="number" min={30} value={f.gapMinSec} onChange={(e) => set('gapMinSec', Number(e.target.value))} />
        </Field>
        <Field label="Longest gap between emails (seconds)">
          <input type="number" min={30} value={f.gapMaxSec} onChange={(e) => set('gapMaxSec', Number(e.target.value))} />
        </Field>
      </div>

      <h3>Limits</h3>
      <div className="grid grid-3">
        <Field label="Emails per day" hint="Including inbox replies. 30–50 is a safe range for one mailbox.">
          <input type="number" min={1} max={500} value={f.dailyLimit} onChange={(e) => set('dailyLimit', Number(e.target.value))} />
        </Field>
      </div>
      <Toggle checked={f.warmup} onChange={(v) => set('warmup', v)} label="Warm up" hint="Start low and raise the daily limit a little every day, so a new mailbox builds a sending reputation." />
      {f.warmup && (
        <div className="grid grid-3">
          <Field label="Emails on day one">
            <input type="number" min={1} max={500} value={f.warmupStart} onChange={(e) => set('warmupStart', Number(e.target.value))} />
          </Field>
          <Field label="Days to reach the full limit">
            <input type="number" min={1} max={60} value={f.warmupDays} onChange={(e) => set('warmupDays', Number(e.target.value))} />
          </Field>
        </div>
      )}
      <ErrorNote error={error} />
    </Modal>
  );
}

import { useState } from 'react';
import { api, serverNow, useApi, type Account } from '../api';
import { Button, Empty, ErrorNote, Field, Meter, Modal, Pill, Toggle, useAction } from '../components/ui';
import { ACTION_LABELS, timeAgo, WEEKDAYS } from '../format';

const LIMIT_KEYS = ['connect', 'connect_weekly', 'message', 'view_profile', 'follow', 'like_post', 'endorse', 'withdraw_invite', 'email'] as const;
const LIMIT_LABEL: Record<string, string> = { ...ACTION_LABELS, connect: 'Invites / day', connect_weekly: 'Invites / week', message: 'Messages / day' };
const DEFAULTS: Record<string, number> = { view_profile: 80, follow: 30, endorse: 20, like_post: 30, connect: 20, connect_weekly: 100, message: 50, email: 60, withdraw_invite: 20 };

export default function Accounts() {
  const accounts = useApi<Account[]>('/api/accounts', 10_000);
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const { busy, run } = useAction();

  const act = (a: Account, what: 'check' | 'sync' | 'pause' | 'resume') =>
    run(
      `${what}${a.id}`,
      async () => {
        const r = await api(`/api/accounts/${a.id}/${what}`, { body: {} });
        await accounts.reload();
        return r;
      },
      { check: 'Connection works', sync: 'Synced connections and inbox', pause: 'Account paused', resume: 'Account resumed' }[what],
    );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>LinkedIn accounts</h1>
          <p>Each account works only inside its working hours, under its daily limits, with randomized pauses between actions.</p>
        </div>
        <Button variant="primary" onClick={() => setEditing('new')}>
          Add account
        </Button>
      </div>

      {accounts.data && !accounts.data.length && (
        <div className="card">
          <Empty title="No LinkedIn accounts yet" action={<Button variant="primary" onClick={() => setEditing('new')}>Add account</Button>}>
            Connect a LinkedIn account with its session cookie, or add a simulated account to try campaigns end to end without touching LinkedIn.
          </Empty>
        </div>
      )}

      <div className="grid grid-2">
        {accounts.data?.map((a) => (
          <div className="card stack" key={a.id}>
            <div className="spread">
              <div>
                <h2>{a.name}</h2>
                <div className="muted" style={{ fontSize: 13 }}>
                  {a.driver === 'simulator' ? 'Simulated LinkedIn (safe sandbox)' : a.linkedinName ? `Signed in as ${a.linkedinName}` : 'LinkedIn browser session'}
                  {a.proxyUrl && ' · via proxy'}
                </div>
              </div>
              <Pill status={a.status} />
            </div>
            {a.statusMessage && <div className="note note-error">{a.statusMessage}</div>}
            {Object.entries(a.cooldowns).some(([, t]) => t > serverNow()) && (
              <div className="note note-warning">LinkedIn pushed back on {Object.keys(a.cooldowns).map((k) => ACTION_LABELS[k as keyof typeof ACTION_LABELS] ?? k).join(', ')}; that action is paused for 24 hours.</div>
            )}
            {a.warmup && a.effectiveLimits.connect < (a.limits.connect ?? DEFAULTS.connect) && (
              <div className="note">Warming up: limits ramp to full over the first week.</div>
            )}
            <div className="grid grid-2" style={{ gap: 12 }}>
              <Meter label="Invites today" used={a.usedToday.connect ?? 0} limit={a.effectiveLimits.connect} />
              <Meter label="Invites this week" used={a.usedToday.connect_weekly ?? 0} limit={a.effectiveLimits.connect_weekly} />
              <Meter label="Messages today" used={a.usedToday.message ?? 0} limit={a.effectiveLimits.message} />
              <Meter label="Profile views today" used={a.usedToday.view_profile ?? 0} limit={a.effectiveLimits.view_profile} />
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              {a.workDays.map((d) => WEEKDAYS[d]).join(', ')} · {a.workStart}–{a.workEnd} ({a.timezone}) · {a.working ? 'working now' : `next window ${timeAgo(a.nextWorkingAt)}`} · last sync {timeAgo(a.lastSyncAt || null)}
            </div>
            <div className="row">
              <Button size="sm" onClick={() => setEditing(a)}>
                Edit
              </Button>
              <Button size="sm" busy={busy === `check${a.id}`} onClick={() => act(a, 'check')}>
                Test connection
              </Button>
              <Button size="sm" busy={busy === `sync${a.id}`} onClick={() => act(a, 'sync')}>
                Sync now
              </Button>
              {a.status === 'active' ? (
                <Button size="sm" busy={busy === `pause${a.id}`} onClick={() => act(a, 'pause')}>
                  Pause
                </Button>
              ) : (
                <Button size="sm" variant="primary" busy={busy === `resume${a.id}`} onClick={() => act(a, 'resume')}>
                  Resume
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      {editing && <AccountModal account={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), accounts.reload())} />}
    </>
  );
}

function AccountModal({ account, onClose, onSaved }: { account: Account | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: account?.name ?? '',
    driver: account?.driver ?? ('playwright' as Account['driver']),
    liAt: '',
    proxyUrl: account ? '' : '',
    timezone: account?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    workDays: account?.workDays ?? [1, 2, 3, 4, 5],
    workStart: account?.workStart ?? '09:00',
    workEnd: account?.workEnd ?? '18:00',
    delayMinSec: account?.delayMinSec ?? 60,
    delayMaxSec: account?.delayMaxSec ?? 240,
    warmup: account?.warmup ?? true,
    limits: { ...DEFAULTS, ...(account?.limits ?? {}) } as Record<string, number>,
    smtpOn: !!account?.smtp,
    smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '', ...(account?.smtp ?? {}) },
  });
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });

  const save = () =>
    run('save', async () => {
      setError(null);
      const body: Record<string, unknown> = {
        name: f.name,
        driver: f.driver,
        timezone: f.timezone,
        workDays: f.workDays,
        workStart: f.workStart,
        workEnd: f.workEnd,
        delayMinSec: f.delayMinSec,
        delayMaxSec: f.delayMaxSec,
        warmup: f.warmup,
        limits: f.limits,
        smtp: f.smtpOn ? f.smtp : null,
      };
      if (f.liAt.trim()) body.liAt = f.liAt.trim();
      if (f.proxyUrl.trim()) body.proxyUrl = f.proxyUrl.trim();
      try {
        await api(account ? `/api/accounts/${account.id}` : '/api/accounts', { method: account ? 'PATCH' : 'POST', body });
        onSaved();
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const remove = () =>
    account &&
    confirm(`Remove "${account.name}"? Its campaigns will be paused.`) &&
    run('del', async () => {
      await api(`/api/accounts/${account.id}`, { method: 'DELETE' });
      onSaved();
    });

  return (
    <Modal
      title={account ? `Edit ${account.name}` : 'Add LinkedIn account'}
      wide
      onClose={onClose}
      footer={
        <>
          {account && (
            <Button variant="danger" busy={busy === 'del'} onClick={remove} style={{ marginRight: 'auto' }}>
              Remove account
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy === 'save'} disabled={!f.name.trim()} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-2">
        <Field label="Name">
          <input type="text" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Sara – Sales" autoFocus />
        </Field>
        <Field label="Connection type">
          <select value={f.driver} onChange={(e) => set('driver', e.target.value as Account['driver'])}>
            <option value="playwright">Real LinkedIn (browser session)</option>
            <option value="simulator">Simulated LinkedIn (for testing)</option>
          </select>
        </Field>
      </div>

      {f.driver === 'playwright' ? (
        <>
          <Field
            label={account?.hasSession ? 'Replace li_at session cookie' : 'li_at session cookie'}
            hint={
              <>
                Log in to linkedin.com in your browser, open Developer Tools → Application → Cookies → www.linkedin.com, and copy the value of <code>li_at</code>. It is encrypted before it is stored.
                {account?.hasSession && ' Leave blank to keep the current one.'}
              </>
            }
          >
            <input type="password" value={f.liAt} onChange={(e) => set('liAt', e.target.value)} placeholder={account?.hasSession ? '••••••••  (saved)' : 'AQEDA…'} autoComplete="off" />
          </Field>
          <Field label="Proxy (recommended)" hint={account?.proxyUrl ? `Current: ${account.proxyUrl}. Use a residential proxy in the account's home country so LinkedIn sees a consistent location.` : "Use a residential proxy in the account's home country so LinkedIn sees a consistent location. Format: http://user:pass@host:port"}>
            <input type="text" value={f.proxyUrl} onChange={(e) => set('proxyUrl', e.target.value)} placeholder="http://user:pass@proxy.example.com:8000" />
          </Field>
          <div className="note note-warning">Automating LinkedIn is against its User Agreement and can get an account restricted. Keep limits conservative, especially for new or rarely used accounts.</div>
        </>
      ) : (
        <div className="note">The simulator behaves like a LinkedIn network: about 45% of invitations get accepted within 3 days and about 30% of messages get replies. Nothing is sent anywhere.</div>
      )}

      <h3>Schedule</h3>
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
      <div className="daypicker" role="group" aria-label="Working days">
        {WEEKDAYS.map((d, i) => (
          <button key={d} type="button" className={f.workDays.includes(i) ? 'on' : ''} aria-pressed={f.workDays.includes(i)} onClick={() => set('workDays', f.workDays.includes(i) ? f.workDays.filter((x) => x !== i) : [...f.workDays, i])}>
            {d}
          </button>
        ))}
      </div>
      <div className="grid grid-2">
        <Field label="Shortest pause between actions (seconds)">
          <input type="number" min={5} value={f.delayMinSec} onChange={(e) => set('delayMinSec', Number(e.target.value))} />
        </Field>
        <Field label="Longest pause between actions (seconds)">
          <input type="number" min={5} value={f.delayMaxSec} onChange={(e) => set('delayMaxSec', Number(e.target.value))} />
        </Field>
      </div>

      <h3>Limits</h3>
      <Toggle checked={f.warmup} onChange={(v) => set('warmup', v)} label="Warm-up" hint="Start at 30% of these limits and add 10% a day for a new account." />
      <div className="grid grid-3">
        {LIMIT_KEYS.map((k) => (
          <Field key={k} label={LIMIT_LABEL[k] ?? k}>
            <input type="number" min={0} max={1000} value={f.limits[k]} onChange={(e) => set('limits', { ...f.limits, [k]: Number(e.target.value) })} />
          </Field>
        ))}
      </div>

      <h3>Email (optional)</h3>
      <Toggle checked={f.smtpOn} onChange={(v) => set('smtpOn', v)} label="Send email steps through SMTP" hint="Without this, email steps are recorded but not delivered." />
      {f.smtpOn && (
        <div className="grid grid-3">
          <Field label="SMTP host">
            <input type="text" value={f.smtp.host} onChange={(e) => set('smtp', { ...f.smtp, host: e.target.value })} />
          </Field>
          <Field label="Port">
            <input type="number" value={f.smtp.port} onChange={(e) => set('smtp', { ...f.smtp, port: Number(e.target.value) })} />
          </Field>
          <Field label="From address">
            <input type="text" value={f.smtp.from} onChange={(e) => set('smtp', { ...f.smtp, from: e.target.value })} placeholder="Sara <sara@acme.com>" />
          </Field>
          <Field label="Username">
            <input type="text" value={f.smtp.user} onChange={(e) => set('smtp', { ...f.smtp, user: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Password" hint={account?.smtp ? 'Leave blank to keep the saved one.' : undefined}>
            <input type="password" value={f.smtp.pass} onChange={(e) => set('smtp', { ...f.smtp, pass: e.target.value })} autoComplete="new-password" />
          </Field>
          <div style={{ alignSelf: 'end', paddingBottom: 8 }}>
            <Toggle checked={f.smtp.secure} onChange={(v) => set('smtp', { ...f.smtp, secure: v })} label="TLS (port 465)" />
          </div>
        </div>
      )}
      <ErrorNote error={error} />
    </Modal>
  );
}

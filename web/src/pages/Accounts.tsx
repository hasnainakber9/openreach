import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, serverNow, useApi, type Account } from '../api';
import { Button, Empty, ErrorNote, Field, Meter, Modal, Pill, Toggle, useAction, useToast } from '../components/ui';
import { ACTION_LABELS, timeAgo, WEEKDAYS } from '../format';
import { useMe } from '../session';

const LIMIT_KEYS = ['connect', 'connect_weekly', 'message', 'view_profile', 'follow', 'like_post', 'endorse', 'withdraw_invite', 'email', 'inmail', 'scrape'] as const;
const LIMIT_LABEL: Record<string, string> = { ...ACTION_LABELS, connect: 'Invites / day', connect_weekly: 'Invites / week', message: 'Messages / day', inmail: 'InMails / day', scrape: 'Profiles imported / day' };
const DEFAULTS: Record<string, number> = { view_profile: 80, follow: 30, endorse: 20, like_post: 30, connect: 20, connect_weekly: 100, message: 50, email: 60, withdraw_invite: 20, inmail: 10, scrape: 1000 };

export default function Accounts() {
  // Faster while a sign-in window is open, so the page notices soon after the user has signed in.
  const [signingIn, setSigningIn] = useState(false);
  const accounts = useApi<Account[]>('/api/accounts', signingIn ? 3_000 : 10_000);
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const browserSignIn = !!useMe().features?.browserSignIn;

  // Says how a sign-in ended once the window it was waiting on is done.
  const waiting = useRef(new Set<number>());
  useEffect(() => {
    const now = new Set<number>();
    for (const a of accounts.data ?? []) {
      const s = a.browserLogin;
      if (s?.state === 'waiting') now.add(a.id);
      else if (s && waiting.current.has(a.id)) toast(s.message, s.state === 'done' ? 'ok' : 'error');
    }
    waiting.current = now;
    setSigningIn(now.size > 0);
  }, [accounts.data, toast]);

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
            Connect a LinkedIn account by signing in to it, or add a simulated account to try campaigns end to end without touching LinkedIn.
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
              {a.overPlan ? <Pill status="paused">Over plan limit</Pill> : <Pill status={a.status} />}
            </div>
            {a.statusMessage && <div className={`note ${a.overPlan ? 'note-warning' : 'note-error'}`}>{a.statusMessage}</div>}
            {/* A failed attempt matters on the card only while the account still has to sign in. */}
            {(a.browserLogin?.state === 'waiting' || a.status === 'needs_login' || !a.hasSession) && <SignInStatus account={a} onChanged={accounts.reload} />}
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
              <Meter label="InMails today" used={a.usedToday.inmail ?? 0} limit={a.effectiveLimits.inmail} />
              <Meter label="Profiles imported today" used={a.usedToday.scrape ?? 0} limit={a.effectiveLimits.scrape} />
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              {a.workDays.map((d) => WEEKDAYS[d]).join(', ')} · {a.workStart}–{a.workEnd} ({a.timezone}) · {a.working ? 'working now' : `next window ${timeAgo(a.nextWorkingAt)}`} · last sync {timeAgo(a.lastSyncAt || null)}
            </div>
            <div className="row">
              {browserSignIn && a.driver === 'playwright' && (a.status === 'needs_login' || !a.hasSession) && a.browserLogin?.state !== 'waiting' && (
                <SignInButton account={a} variant="primary" onChanged={accounts.reload} />
              )}
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
      {editing && (
        <AccountModal
          // The live copy, so the sign-in progress shows while the form is open (the form keeps its own edits).
          account={editing === 'new' ? null : (accounts.data?.find((x) => x.id === editing.id) ?? editing)}
          browserSignIn={browserSignIn}
          onClose={() => setEditing(null)}
          onSaved={() => (setEditing(null), accounts.reload())}
          onChanged={accounts.reload}
        />
      )}
    </>
  );
}

// Opens LinkedIn's sign-in page in a window on the computer running OpenReach; the user signs in there.
function SignInButton({ account, variant, onChanged }: { account: Account; variant?: 'primary'; onChanged: () => void }) {
  const { busy, run } = useAction();
  return (
    <Button
      size="sm"
      variant={variant}
      busy={busy === 'start'}
      onClick={() =>
        run('start', async () => {
          await api(`/api/accounts/${account.id}/browser-login`, { body: {} });
          onChanged();
        })
      }
    >
      Sign in in a browser window
    </Button>
  );
}

// While the sign-in window is open: what it is waiting for, and a way to close it. A failed attempt says why.
function SignInStatus({ account, onChanged }: { account: Account; onChanged: () => void }) {
  const { busy, run } = useAction();
  const s = account.browserLogin;
  if (s?.state === 'failed') return <div className="note note-error">{s.message}</div>;
  if (s?.state !== 'waiting') return null;
  return (
    <div className="note spread" style={{ gap: 12 }}>
      <span>{s.message}</span>
      {/* Not once signed in and checking the session: the window is closed already. */}
      {s.cancellable && (
        <Button
          size="sm"
          busy={busy === 'cancel'}
          onClick={() =>
            run('cancel', async () => {
              await api(`/api/accounts/${account.id}/browser-login/cancel`, { body: {} });
              onChanged();
            })
          }
        >
          Cancel
        </Button>
      )}
    </div>
  );
}

function AccountModal({
  account,
  browserSignIn,
  onClose,
  onSaved,
  onChanged,
}: {
  account: Account | null;
  browserSignIn: boolean;
  onClose: () => void;
  onSaved: () => void;
  onChanged: () => void;
}) {
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
  });
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const signInAfterSave = browserSignIn && !account && f.driver === 'playwright' && !f.liAt.trim();

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
      };
      if (f.liAt.trim()) body.liAt = f.liAt.trim();
      if (f.proxyUrl.trim()) body.proxyUrl = f.proxyUrl.trim();
      try {
        const saved = await api<Account>(account ? `/api/accounts/${account.id}` : '/api/accounts', { method: account ? 'PATCH' : 'POST', body });
        // A new real account without a cookie is signed in with the browser window straight away.
        if (signInAfterSave) {
          try {
            await api(`/api/accounts/${saved.id}/browser-login`, { body: {} });
          } catch (e) {
            toast(`Saved, but the sign-in window did not open: ${(e as Error).message}`, 'error');
          }
        }
        onSaved();
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const remove = () =>
    account &&
    confirm(`Remove "${account.name}"? Leads it already contacted stop, and campaigns with no other sender are paused.`) &&
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
            {signInAfterSave ? 'Save and sign in' : 'Save'}
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
          {browserSignIn && (
            <div className="field">
              <span className="field-label">Sign in to LinkedIn</span>
              {account && (account.browserLogin?.state === 'waiting' ? <SignInStatus account={account} onChanged={onChanged} /> : (
                <div className="row">
                  <SignInButton account={account} onChanged={onChanged} />
                </div>
              ))}
              {account?.browserLogin?.state === 'failed' && <SignInStatus account={account} onChanged={onChanged} />}
              <span className="field-hint">
                A LinkedIn window opens on this computer; sign in there. This is more reliable than pasting a cookie, because LinkedIn keeps a session tied to the browser it was signed in with.
                {!account && ' Leave the cookie below empty and choose "Save and sign in".'}
              </span>
            </div>
          )}
          <Field
            label={browserSignIn ? (account?.hasSession ? 'Or replace the li_at session cookie' : 'Or paste the li_at session cookie') : account?.hasSession ? 'Replace li_at session cookie' : 'li_at session cookie'}
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

      <h3>Email</h3>
      <div className="note">
        Email steps now send from <Link to="/mailboxes">Mailboxes</Link>, with their own limits, warm-up and reply detection. SMTP settings saved on this account earlier were moved to a mailbox.
      </div>
      <ErrorNote error={error} />
    </Modal>
  );
}

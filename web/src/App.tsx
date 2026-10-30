import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, useApi } from './api';
import { Button, ErrorNote, Field } from './components/ui';
import Accounts from './pages/Accounts';
import CampaignDetail from './pages/CampaignDetail';
import Campaigns from './pages/Campaigns';
import Dashboard from './pages/Dashboard';
import Inbox from './pages/Inbox';
import Leads from './pages/Leads';
import Settings from './pages/Settings';

export interface Me {
  id: number;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  workspace_id: number;
  workspace_name: string;
}

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    api<{ user: Me }>('/api/auth/me')
      .then((r) => setMe(r.user))
      .catch(() => setMe(null));
    const out = () => setMe(null);
    window.addEventListener('openreach:signed-out', out);
    return () => window.removeEventListener('openreach:signed-out', out);
  }, []);

  if (me === undefined) return null;
  if (!me) return <SignIn onDone={setMe} />;
  return <Shell me={me} onSignOut={() => setMe(null)} />;
}

function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const unread = useApi<any[]>('/api/inbox?unread=true', 30_000);
  const signOut = async () => {
    await api('/api/auth/logout', { body: {} });
    onSignOut();
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 32 32">
              <path d="M5 24c4-11 15-11 20-14" stroke="white" strokeWidth="4" fill="none" strokeLinecap="round" />
              <circle cx="25" cy="10" r="4" fill="white" />
            </svg>
          </span>
          OpenReach
        </div>
        <nav className="nav">
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/campaigns">Campaigns</NavLink>
          <NavLink to="/leads">Leads</NavLink>
          <NavLink to="/inbox">
            Inbox
            {!!unread.data?.length && <span className="nav-badge">{unread.data.length}</span>}
          </NavLink>
          <NavLink to="/accounts">LinkedIn accounts</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="sidebar-foot">
          <div style={{ fontWeight: 600 }}>{me.name}</div>
          <div className="muted" style={{ marginBottom: 8 }}>
            {me.workspace_name}
          </div>
          <Button size="sm" variant="ghost" onClick={signOut} style={{ paddingLeft: 0 }}>
            Sign out
          </Button>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/campaigns/:id" element={<CampaignDetail />} />
          <Route path="/leads" element={<Leads />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/settings" element={<Settings me={me} />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}

function SignIn({ onDone }: { onDone: (me: Me) => void }) {
  const status = useApi<{ needsSetup: boolean; allowSignup: boolean }>('/api/auth/status');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', workspace: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const register = status.data?.needsSetup || mode === 'register';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ user: Me }>(register ? '/api/auth/register' : '/api/auth/login', {
        body: register ? { ...form, workspace: form.workspace || `${form.name.split(' ')[0] || 'My'}'s workspace` } : { email: form.email, password: form.password },
      });
      onDone(r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  if (!status.data) return null;
  return (
    <div className="auth">
      <form className="card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 32 32">
              <path d="M5 24c4-11 15-11 20-14" stroke="white" strokeWidth="4" fill="none" strokeLinecap="round" />
              <circle cx="25" cy="10" r="4" fill="white" />
            </svg>
          </span>
          OpenReach
        </div>
        <div>
          <h1>{status.data.needsSetup ? 'Set up your workspace' : register ? 'Create an account' : 'Sign in'}</h1>
          {status.data.needsSetup && <p className="muted" style={{ margin: '6px 0 0' }}>You are the first user, so you will own this installation.</p>}
        </div>
        {register && (
          <>
            <Field label="Your name">
              <input type="text" value={form.name} onChange={set('name')} required autoFocus />
            </Field>
            <Field label="Workspace name">
              <input type="text" value={form.workspace} onChange={set('workspace')} placeholder="Acme Sales" />
            </Field>
          </>
        )}
        <Field label="Email">
          <input type="email" value={form.email} onChange={set('email')} required autoFocus={!register} autoComplete="email" />
        </Field>
        <Field label="Password" hint={register ? 'At least 8 characters' : undefined}>
          <input type="password" value={form.password} onChange={set('password')} required minLength={register ? 8 : undefined} autoComplete={register ? 'new-password' : 'current-password'} />
        </Field>
        <ErrorNote error={error} />
        <Button variant="primary" busy={busy} type="submit" style={{ justifyContent: 'center' }}>
          {register ? 'Create workspace' : 'Sign in'}
        </Button>
        {!status.data.needsSetup && status.data.allowSignup && (
          <button type="button" className="btn btn-ghost" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in'}
          </button>
        )}
      </form>
    </div>
  );
}

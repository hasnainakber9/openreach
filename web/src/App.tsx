import { useEffect, useRef, useState, type FormEvent } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, PLAN_LIMIT_EVENT, setShownWorkspace, syncClock, useApi, WORKSPACE_CHANGED_EVENT, type Branding, type Role, type TaskCounts, type WorkspaceItem } from './api';
import { DEFAULT_BRANDING, refreshBranding, useBranding } from './branding';
import { BrandMark, Button, ErrorNote, Field, useToast } from './components/ui';
import { canWrite, MeContext, type Me } from './session';
import Accounts from './pages/Accounts';
import Agency from './pages/Agency';
import Billing from './pages/Billing';
import CampaignDetail from './pages/CampaignDetail';
import Campaigns from './pages/Campaigns';
import Dashboard from './pages/Dashboard';
import Inbox from './pages/Inbox';
import Invite from './pages/Invite';
import Leads from './pages/Leads';
import Mailboxes from './pages/Mailboxes';
import Pipeline from './pages/Pipeline';
import Settings from './pages/Settings';
import Tasks, { taskCountsPath } from './pages/Tasks';

export type { Me } from './session';

// The sidebar. A page adds its entry here when it exists; `roles` and `feature` hide entries a user can't use.
interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  roles?: Role[];
  feature?: string;
  badge?: 'inbox' | 'tasks';
}

const WRITERS: Role[] = ['owner', 'admin', 'member'];
// Clients (read-only portal) see Dashboard, Campaigns, Pipeline and Inbox.
const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/campaigns', label: 'Campaigns' },
  { to: '/leads', label: 'Leads', roles: WRITERS },
  { to: '/pipeline', label: 'Pipeline' },
  { to: '/tasks', label: 'Tasks', badge: 'tasks', roles: WRITERS },
  { to: '/inbox', label: 'Inbox', badge: 'inbox' },
  { to: '/accounts', label: 'LinkedIn accounts', roles: WRITERS },
  { to: '/mailboxes', label: 'Mailboxes', roles: WRITERS },
  { to: '/agency', label: 'Agency', feature: 'agency' },
  // Hosted installs, for the owner of the paying workspace.
  { to: '/billing', label: 'Billing', feature: 'billing' },
  { to: '/settings', label: 'Settings', roles: WRITERS },
];

export default function App() {
  const [me, setMeState] = useState<Me | null | undefined>(undefined);
  const branding = useBranding();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const catchingUp = useRef(false);
  // Set before rendering, so the first calls of the new workspace's pages already carry it.
  const setMe = (u: Me | null) => {
    setShownWorkspace(u?.workspace_id ?? null);
    setMeState(u);
  };

  useEffect(() => {
    void syncClock().catch(() => {});
    api<{ user: Me }>('/api/auth/me')
      .then((r) => setMe(r.user))
      .catch(() => setMe(null));
    const out = () => setMe(null);
    window.addEventListener('openreach:signed-out', out);
    return () => window.removeEventListener('openreach:signed-out', out);
  }, []);

  // Another tab switched the session to a different workspace: show that one here too instead of the stale page.
  useEffect(() => {
    const changed = async () => {
      if (catchingUp.current) return;
      catchingUp.current = true;
      try {
        const r = await api<{ user: Me }>('/api/auth/me');
        if (r.user.workspace_id !== me?.workspace_id) {
          navigate('/');
          signedIn(r.user);
          toast(`You switched to ${r.user.workspace_name} in another tab, so this tab shows it now.`);
        }
      } catch {
        // Signed out meanwhile: the 401 handler takes over.
      } finally {
        catchingUp.current = false;
      }
    };
    window.addEventListener(WORKSPACE_CHANGED_EVENT, changed);
    return () => window.removeEventListener(WORKSPACE_CHANGED_EVENT, changed);
  });

  // Signing in or out, or switching workspace, can change the branding (a client of an agency).
  const signedIn = (u: Me | null) => {
    setMe(u);
    refreshBranding();
  };

  if (me === undefined || !branding) return null;
  // Invite links work signed in or out.
  if (location.pathname.startsWith('/invite/')) return <Invite me={me} onAccepted={signedIn} />;
  if (!me) return <SignIn onDone={signedIn} branding={branding} />;
  return (
    <MeContext.Provider value={me}>
      <Shell key={me.workspace_id} me={me} branding={branding} onMe={signedIn} />
    </MeContext.Provider>
  );
}

function Shell({ me, branding, onMe }: { me: Me; branding: Branding; onMe: (me: Me | null) => void }) {
  const writer = canWrite(me);
  const unread = useApi<any[]>('/api/inbox?unread=true', 30_000);
  const tasks = useApi<TaskCounts>(writer ? taskCountsPath : null, 60_000);
  const badges: Record<NonNullable<NavItem['badge']>, number> = { inbox: unread.data?.length ?? 0, tasks: tasks.data?.dueToday ?? 0 };
  const nav = NAV.filter((n) => (!n.roles || n.roles.includes(me.role)) && (!n.feature || me.features?.[n.feature]));
  const signOut = async () => {
    await api('/api/auth/logout', { body: {} });
    onMe(null);
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <BrandMark name={branding.productName} logoUrl={branding.logoUrl} />
        <nav className="nav" aria-label="Main">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              {n.label}
              {!!(n.badge && badges[n.badge]) && <span className="nav-badge">{badges[n.badge!]}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <WorkspaceSwitcher me={me} onMe={onMe} />
          <div style={{ fontWeight: 600 }}>{me.name}</div>
          <div className="muted" style={{ marginBottom: 8 }}>
            {me.workspace_name}
            {me.workspace_kind === 'client' && me.parent_name ? ` · client of ${me.parent_name}` : ''}
          </div>
          {branding.supportEmail && (
            <div style={{ marginBottom: 8 }}>
              <a href={`mailto:${branding.supportEmail}`}>Get help</a>
            </div>
          )}
          <Button size="sm" variant="ghost" onClick={signOut} style={{ paddingLeft: 0 }}>
            Sign out
          </Button>
        </div>
      </aside>
      <main className="main">
        <PlanLimitPrompt me={me} />
        <Routes>
          <Route path="/" element={<Dashboard me={me} />} />
          <Route path="/campaigns" element={<Campaigns me={me} />} />
          <Route path="/campaigns/:id" element={<CampaignDetail />} />
          <Route path="/pipeline" element={<Pipeline me={me} />} />
          <Route path="/inbox" element={<Inbox me={me} />} />
          {writer && (
            <>
              <Route path="/leads" element={<Leads />} />
              <Route path="/tasks" element={<Tasks me={me} />} />
              <Route path="/accounts" element={<Accounts />} />
              <Route path="/mailboxes" element={<Mailboxes me={me} />} />
              <Route path="/settings" element={<Settings me={me} onMe={onMe} />} />
            </>
          )}
          {me.features.agency && <Route path="/agency" element={<Agency me={me} onMe={onMe} />} />}
          {me.features.billing && <Route path="/billing" element={<Billing />} />}
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}

// A plan limit (402) from any request becomes one toast: an upgrade link for whoever manages billing,
// otherwise who to ask.
function PlanLimitPrompt({ me }: { me: Me }) {
  const toast = useToast();
  useEffect(() => {
    const show = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (me.features.billing) toast(text, 'error', { to: '/billing', label: 'Upgrade' });
      else toast(`${text} Ask the owner of ${me.agency?.name ?? 'the workspace'} to upgrade.`, 'error');
    };
    window.addEventListener(PLAN_LIMIT_EVENT, show);
    return () => window.removeEventListener(PLAN_LIMIT_EVENT, show);
  }, [me, toast]);
  return null;
}

// Lists the workspaces the user can reach; switching reloads the whole app inside the other one.
function WorkspaceSwitcher({ me, onMe }: { me: Me; onMe: (me: Me) => void }) {
  const list = useApi<WorkspaceItem[]>('/api/workspaces');
  const toast = useToast();
  const navigate = useNavigate();
  if (!list.data || list.data.length < 2) return null;
  const label = (w: WorkspaceItem) => (w.kind === 'agency' ? `${w.name} (agency)` : w.kind === 'client' && w.parentName ? `\u00a0\u00a0${w.name} (client)` : w.name);
  const change = async (id: number) => {
    try {
      const r = await api<{ user: Me }>('/api/workspaces/switch', { body: { workspaceId: id } });
      navigate('/');
      onMe(r.user);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="workspace-switch">
      <select aria-label="Workspace" value={me.workspace_id} onChange={(e) => void change(Number(e.target.value))}>
        {list.data.map((w) => (
          <option key={w.id} value={w.id}>
            {label(w)}
          </option>
        ))}
      </select>
    </div>
  );
}

function SignIn({ onDone, branding = DEFAULT_BRANDING }: { onDone: (me: Me) => void; branding?: Branding }) {
  const status = useApi<{ needsSetup: boolean; allowSignup: boolean; setupTokenRequired?: boolean }>('/api/auth/status');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', workspace: '', setupToken: '' });
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
    <main className="auth">
      <form className="card" onSubmit={submit}>
        <BrandMark name={branding.productName} logoUrl={branding.logoUrl} />
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
        {status.data.setupTokenRequired && (
          <Field label="Setup token" hint="The SETUP_TOKEN value from your hosting dashboard. It proves you own this server.">
            <input type="password" value={form.setupToken} onChange={set('setupToken')} required autoComplete="off" />
          </Field>
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
        {branding.supportEmail && (
          <p className="muted" style={{ margin: 0, textAlign: 'center' }}>
            Trouble signing in? <a href={`mailto:${branding.supportEmail}`}>Contact support</a>
          </p>
        )}
        {!status.data.needsSetup && status.data.allowSignup && (
          <button type="button" className="btn btn-ghost" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in'}
          </button>
        )}
      </form>
    </main>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, useApi, type InviteInfo } from '../api';
import { applyBranding } from '../branding';
import { BrandMark, Button, ErrorNote, Field } from '../components/ui';
import type { Me } from '../session';

const ROLE_TEXT: Record<InviteInfo['role'], string> = {
  admin: 'an admin',
  member: 'a member',
  client: 'a client (read-only access to results)',
};

// /invite/:token, signed in or not. New people choose a name and password; existing users confirm
// with their password (or just join when they're already signed in as the invited address).
export default function Invite({ me, onAccepted }: { me: Me | null; onAccepted: (me: Me) => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const token = decodeURIComponent(location.pathname.split('/invite/')[1] ?? '').replace(/\/+$/, '');
  const info = useApi<InviteInfo>(token ? `/api/public/invites/${encodeURIComponent(token)}` : null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inv = info.data;

  // The invite shows the inviting workspace's branding (its agency's name, logo and color).
  useEffect(() => {
    if (inv) applyBranding(inv.branding);
  }, [inv]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ user: Me }>(`/api/public/invites/${encodeURIComponent(token)}/accept`, { body: inv?.existingUser ? (inv.signedIn ? {} : { password }) : { name, password } });
      navigate('/', { replace: true });
      onAccepted(r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!inv && !info.error) return null;
  return (
    <main className="auth">
      <form className="card" onSubmit={submit}>
        <BrandMark name={inv?.branding.productName ?? 'OpenReach'} logoUrl={inv?.branding.logoUrl} />
        {!inv ? (
          <>
            <div>
              <h1>This invite can't be used</h1>
              <p className="muted" style={{ margin: '6px 0 0' }}>
                It may have expired, been used already, or been replaced by a newer link. Ask whoever invited you for a new one.
              </p>
            </div>
            <Button variant="primary" onClick={() => navigate('/', { replace: true })} style={{ justifyContent: 'center' }}>
              {me ? 'Go to the app' : 'Sign in'}
            </Button>
          </>
        ) : (
          <>
            <div>
              <h1>Join {inv.workspaceName}</h1>
              <p className="muted" style={{ margin: '6px 0 0' }}>
                You're invited as {ROLE_TEXT[inv.role]} with {inv.email}.
              </p>
            </div>
            {inv.existingUser && !inv.signedIn && (
              <Field label="Your password" hint={`You already have an account for ${inv.email}; enter its password to join.`}>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus autoComplete="current-password" />
              </Field>
            )}
            {!inv.existingUser && (
              <>
                <Field label="Your name">
                  <input type="text" value={name} onChange={(e) => setName(e.target.value)} required autoFocus autoComplete="name" />
                </Field>
                <Field label="Email">
                  <input type="email" value={inv.email} readOnly />
                </Field>
                <Field label="Choose a password" hint="At least 8 characters">
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
                </Field>
              </>
            )}
            {me && !inv.signedIn && <p className="muted" style={{ margin: 0 }}>You're signed in as {me.email}; accepting signs you in as {inv.email}.</p>}
            <ErrorNote error={error} />
            <Button variant="primary" busy={busy} type="submit" style={{ justifyContent: 'center' }}>
              {inv.existingUser ? `Join ${inv.workspaceName}` : 'Create account and join'}
            </Button>
          </>
        )}
      </form>
    </main>
  );
}

import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, useApi, type BillingInfo, type BillingPlan, type LimitKey } from '../api';
import { Button, ErrorNote, Meter, Pill, useAction } from '../components/ui';
import { dateTime } from '../format';

// Hosted installs only: the paying workspace's plan, usage against its limits, and Stripe Checkout / the
// Customer Portal (both open on Stripe's own pages).

const LIMITS: { key: LimitKey; label: string; monthly?: boolean }[] = [
  { key: 'linkedinAccounts', label: 'LinkedIn accounts' },
  { key: 'mailboxes', label: 'Mailboxes' },
  { key: 'seats', label: 'Seats' },
  { key: 'clientWorkspaces', label: 'Client workspaces' },
  { key: 'aiCreditsMonthly', label: 'AI credits', monthly: true },
  { key: 'enrichmentCreditsMonthly', label: 'Enrichment credits', monthly: true },
];

const STATUS_LABELS: Record<BillingInfo['status'], string> = {
  none: 'No subscription',
  trialing: 'Trial',
  active: 'Active',
  past_due: 'Payment failed',
  unpaid: 'Unpaid',
  canceled: 'Canceled',
  incomplete: 'Waiting for payment',
  incomplete_expired: 'Payment expired',
  paused: 'Paused',
};
const STATUS_TONE: Partial<Record<BillingInfo['status'], string>> = { trialing: 'active', past_due: 'failed', unpaid: 'failed', incomplete: 'pending', paused: 'paused' };

const amount = (n: number | null, monthly?: boolean) => (n === null ? 'Unlimited' : `${n.toLocaleString()}${monthly ? ' a month' : ''}`);

export default function Billing() {
  const billing = useApi<BillingInfo>('/api/billing');
  const [params] = useSearchParams();
  const returned = params.get('status');
  const { busy, run } = useAction();
  const { reload } = billing;

  // Back from Checkout: Stripe confirms through the webhook, usually within seconds.
  useEffect(() => {
    if (returned !== 'success') return;
    const t = setInterval(() => void reload(), 3000);
    const stop = setTimeout(() => clearInterval(t), 30_000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [returned, reload]);

  // Both answers are Stripe-hosted pages.
  const open = (key: string, path: string, body: unknown = {}) =>
    run(key, async () => {
      const r = await api<{ url: string }>(path, { body });
      window.location.assign(r.url);
    });

  const b = billing.data;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Billing</h1>
          <p>Plan and usage for {b?.workspaceName || 'your workspace'}. Client workspaces count toward their agency's plan.</p>
        </div>
        {b?.hasCustomer && (
          <Button busy={busy === 'portal'} onClick={() => open('portal', '/api/billing/portal')}>
            Manage billing
          </Button>
        )}
      </div>
      <ErrorNote error={billing.error} />
      {b && (
        <div className="stack">
          {returned === 'success' && <div className="note">Thanks! Your plan changes here as soon as Stripe confirms the payment.</div>}
          {returned === 'canceled' && <div className="note">Checkout was canceled. Nothing changed.</div>}
          {!b.enabled && <div className="note">Billing is off on this server: nothing is limited.</div>}
          {b.enabled && !b.webhookConfigured && (
            <div className="note note-warning">STRIPE_WEBHOOK_SECRET is not set on the server, so payments won't update your plan. Ask whoever runs this installation to set it.</div>
          )}
          {b.enabled && !b.publicUrlConfigured && <div className="note note-warning">PUBLIC_URL is not set on the server, so Checkout and the billing portal can't open.</div>}
          {b.duplicateSubscription && (
            <div className="note note-error" role="alert">
              This workspace has two active subscriptions, so it is billed twice. Open Manage billing and cancel the one you don't want.
            </div>
          )}
          {b.status === 'past_due' || b.status === 'unpaid' ? (
            <div className="note note-error" role="alert">
              The last payment failed, so the {b.plans.find((p) => p.default)?.name ?? 'free'} plan's limits apply until it goes through. Nothing was deleted or paused. Update your card under
              Manage billing.
            </div>
          ) : null}

          <div className="card">
            <div className="spread">
              <div>
                <div className="muted">Current plan</div>
                <h2 style={{ margin: '4px 0' }}>{b.plan?.name ?? 'No plan'}</h2>
                <div className="row">
                  <Pill status={STATUS_TONE[b.status] ?? b.status}>{STATUS_LABELS[b.status] ?? b.status}</Pill>
                  {b.currentPeriodEnd && (
                    <span className="muted">
                      {b.cancelAtPeriodEnd ? 'Ends' : 'Renews'} {dateTime(b.currentPeriodEnd)}
                    </span>
                  )}
                </div>
              </div>
            </div>
            {!b.plan && b.enabled && <p className="muted">Choose a plan below to add LinkedIn accounts, mailboxes and teammates.</p>}
          </div>

          <div className="card">
            <h2>Usage</h2>
            <div className="grid grid-3 billing-usage">
              {LIMITS.map((l) => (
                <Meter key={l.key} label={l.monthly ? `${l.label} this month` : l.label} used={b.usage[l.key].used} limit={b.usage[l.key].allowed} period="" />
              ))}
            </div>
          </div>

          {b.plans.length > 0 && (
            <div className="grid grid-3">
              {b.plans.map((p) => (
                <PlanCard
                  key={p.id}
                  plan={p}
                  current={b.plan?.id === p.id}
                  action={
                    !p.purchasable ? null : b.canCheckout ? (
                      <Button variant="primary" busy={busy === `plan-${p.id}`} onClick={() => open(`plan-${p.id}`, '/api/billing/checkout', { planId: p.id })}>
                        Choose {p.name}
                      </Button>
                    ) : b.hasCustomer ? (
                      <Button busy={busy === 'portal'} onClick={() => open('portal', '/api/billing/portal')}>
                        Switch in billing portal
                      </Button>
                    ) : null
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function PlanCard({ plan, current, action }: { plan: BillingPlan; current: boolean; action: React.ReactNode }) {
  return (
    <div className={`card plan-card${current ? ' current' : ''}`}>
      <div className="spread">
        <h3>{plan.name}</h3>
        {current && <Pill status="active">Current plan</Pill>}
      </div>
      <ul className="plan-limits" aria-label={`${plan.name} limits`}>
        {LIMITS.map((l) => (
          <li key={l.key}>
            <span className="muted">{l.label}</span>
            <span className="num">{amount(plan.limits[l.key], l.monthly)}</span>
          </li>
        ))}
      </ul>
      {plan.default && <p className="muted">Applies to workspaces without a subscription.</p>}
      {!current && action}
    </div>
  );
}

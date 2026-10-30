import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, type Account, type Campaign } from '../api';
import { Funnel, LineChart } from '../components/LineChart';
import { Empty, Meter, Pill, Stat } from '../components/ui';
import { ACTION_LABELS, pct, timeAgo } from '../format';

interface Analytics {
  totals: Record<string, number>;
  series: Record<string, any>[];
  funnel: { contacted: number; invited: number; accepted: number; messaged: number; replied: number };
  acceptanceRate: number;
  replyRate: number;
}

const SERIES = [
  { key: 'connect', label: 'Invites sent', color: 'var(--series-1)' },
  { key: 'accepted', label: 'Accepted', color: 'var(--series-2)' },
  { key: 'message', label: 'Messages', color: 'var(--series-3)' },
  { key: 'replied', label: 'Replies', color: 'var(--series-4)' },
];

export default function Dashboard() {
  const [days, setDays] = useState(30);
  const analytics = useApi<Analytics>(`/api/analytics?days=${days}`, 20_000);
  const accounts = useApi<Account[]>('/api/accounts', 20_000);
  const campaigns = useApi<Campaign[]>('/api/campaigns', 20_000);
  const feed = useApi<any[]>('/api/activity?limit=12', 10_000);
  const a = analytics.data;

  if (accounts.data && !accounts.data.length) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>Welcome to OpenReach</h1>
            <p>Three steps to your first campaign.</p>
          </div>
        </div>
        <div className="grid grid-3">
          <div className="card">
            <h2>1. Connect LinkedIn</h2>
            <p className="muted">Add your LinkedIn session, or start with a simulated account to try everything safely.</p>
            <Link className="btn btn-primary" to="/accounts">
              Add an account
            </Link>
          </div>
          <div className="card">
            <h2>2. Import leads</h2>
            <p className="muted">Upload a CSV or paste a LinkedIn / Sales Navigator search URL.</p>
            <Link className="btn" to="/leads">
              Go to leads
            </Link>
          </div>
          <div className="card">
            <h2>3. Build a sequence</h2>
            <p className="muted">Chain profile visits, invites, messages and waits, with branches for who accepts.</p>
            <Link className="btn" to="/campaigns">
              Create a campaign
            </Link>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>Outreach across all campaigns and LinkedIn accounts.</p>
        </div>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }} aria-label="Time range">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Invites sent" value={a?.totals.connect ?? 0} sub={`${a?.totals.view_profile ?? 0} profiles viewed`} />
        <Stat label="Acceptance rate" value={pct(a?.acceptanceRate ?? 0)} sub={`${a?.funnel.accepted ?? 0} accepted`} />
        <Stat label="Messages sent" value={a?.totals.message ?? 0} sub={`${a?.totals.email ?? 0} emails`} />
        <Stat label="Reply rate" value={pct(a?.replyRate ?? 0)} sub={`${a?.funnel.replied ?? 0} people replied`} />
      </div>

      <div className="grid grid-main-side" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <h2>Daily activity</h2>
          </div>
          {a && <LineChart data={a.series} series={SERIES} xKey="day" formatX={(d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} />}
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Funnel</h2>
          </div>
          {a && (
            <Funnel
              stages={[
                { label: 'Contacted', value: a.funnel.contacted },
                { label: 'Invited', value: a.funnel.invited },
                { label: 'Accepted', value: a.funnel.accepted, note: pct(a.acceptanceRate) },
                { label: 'Messaged', value: a.funnel.messaged },
                { label: 'Replied', value: a.funnel.replied, note: pct(a.replyRate) },
              ]}
            />
          )}
        </div>
      </div>

      <div className="grid grid-3" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-head">
            <h2>LinkedIn accounts</h2>
            <Link to="/accounts">Manage</Link>
          </div>
          <div className="stack">
            {accounts.data?.map((acc) => (
              <div key={acc.id} className="stack" style={{ gap: 8 }}>
                <div className="spread">
                  <strong>{acc.name}</strong>
                  <Pill status={acc.status} />
                </div>
                <Meter label="Invites" used={acc.usedToday.connect ?? 0} limit={acc.effectiveLimits.connect} />
                <Meter label="Messages" used={acc.usedToday.message ?? 0} limit={acc.effectiveLimits.message} />
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {acc.working ? 'In working hours' : `Resumes ${timeAgo(acc.nextWorkingAt)}`}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Campaigns</h2>
            <Link to="/campaigns">All campaigns</Link>
          </div>
          {!campaigns.data?.length && <Empty title="No campaigns yet" />}
          <div className="stack">
            {campaigns.data?.slice(0, 6).map((c) => (
              <Link key={c.id} to={`/campaigns/${c.id}`} style={{ color: 'inherit' }}>
                <div className="spread">
                  <span className="cell-title">{c.name}</span>
                  <Pill status={c.status} />
                </div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {c.stats.total} leads · {pct(c.stats.acceptanceRate)} accepted · {pct(c.stats.replyRate)} replied
                </div>
              </Link>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Live activity</h2>
          </div>
          {!feed.data?.length && <p className="muted">Nothing yet. Activity appears here as campaigns run.</p>}
          <div>
            {feed.data?.map((f) => (
              <div className="feed-item" key={f.id}>
                <span className={`feed-dot ${f.status}`} aria-hidden />
                <div style={{ minWidth: 0 }}>
                  <div>
                    <strong>{ACTION_LABELS[f.type as keyof typeof ACTION_LABELS] ?? f.type}</strong>
                    {f.leadName?.trim() && <> · {f.leadName}</>}
                    {f.status !== 'ok' && <span className="muted"> ({f.status})</span>}
                  </div>
                  <div className="muted cell-sub">
                    {timeAgo(f.createdAt)}
                    {f.campaignName && ` · ${f.campaignName}`}
                    {f.detail && f.status !== 'ok' && ` · ${f.detail}`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

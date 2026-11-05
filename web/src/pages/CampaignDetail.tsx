import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, REPLY_CATEGORIES, useApi, type AbTestReport, type Account, type Mailbox, type Campaign, type CampaignLead, type LeadList, type ReplyCategory, type SeqNode, type Sequence, type VariantId } from '../api';
import { Funnel, LineChart } from '../components/LineChart';
import { AiVariablesEditor } from '../components/Ai';
import { SequenceBuilder, summary } from '../components/SequenceBuilder';
import { Button, CheckList, Empty, Field, Pager, Pill, Stat, Tabs, Toggle, useAction } from '../components/ui';
import { ACTION_LABELS, CATEGORY_LABELS, CONDITION_LABELS, fullName, pct, senderSummary, timeAgo } from '../format';

type Tab = 'sequence' | 'leads' | 'results' | 'settings';

export default function CampaignDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const campaign = useApi<Campaign>(`/api/campaigns/${id}`, 15_000);
  const [tab, setTab] = useState<Tab>('sequence');
  const [draft, setDraft] = useState<Sequence | null>(null);
  const { busy, run } = useAction();
  const c = campaign.data;

  useEffect(() => {
    if (c?.sequence && !draft) setDraft(c.sequence);
  }, [c, draft]);

  if (campaign.error) return <Empty title="Campaign not found" action={<Link to="/campaigns">Back to campaigns</Link>} />;
  if (!c || !draft) return null;

  const dirty = JSON.stringify(draft) !== JSON.stringify(c.sequence);
  const save = () =>
    run(
      'save',
      async () => {
        const updated = await api<Campaign>(`/api/campaigns/${c.id}`, { method: 'PATCH', body: { sequence: draft } });
        campaign.setData(updated);
        setDraft(updated.sequence!);
      },
      'Sequence saved',
    );
  const toggle = () =>
    run('toggle', async () => {
      if (dirty) await api(`/api/campaigns/${c.id}`, { method: 'PATCH', body: { sequence: draft } });
      await api(`/api/campaigns/${c.id}/${c.status === 'active' ? 'pause' : 'start'}`, { body: {} });
      await campaign.reload();
    });

  return (
    <>
      <div className="page-head">
        <div>
          <div className="row">
            <Link to="/campaigns" className="muted">
              Campaigns
            </Link>
            <span className="muted">/</span>
          </div>
          <div className="row" style={{ marginTop: 4 }}>
            <h1>{c.name}</h1>
            <Pill status={c.status} />
          </div>
          <p>
            {c.accounts.length ? (
              <>
                Runs from <strong title={c.accounts.map((a) => a.name).join(', ')}>{senderSummary(c.accounts)}</strong>
                {c.accounts
                  .filter((a) => a.status !== 'active')
                  .map((a) => (
                    <span key={a.id}>
                      {' '}
                      · {a.name} is {a.status.replace('_', ' ')}
                    </span>
                  ))}
              </>
            ) : (
              'No LinkedIn account selected'
            )}
            {!!c.mailboxes.length && (
              <>
                {' · '}email from <strong title={c.mailboxes.map((m) => m.fromEmail).join(', ')}>{senderSummary(c.mailboxes)}</strong>
              </>
            )}
            {' · '}
            {c.stats.total} leads
          </p>
        </div>
        <div className="row">
          {dirty && (
            <Button busy={busy === 'save'} onClick={save}>
              Save changes
            </Button>
          )}
          <Button variant={c.status === 'active' ? 'default' : 'primary'} busy={busy === 'toggle'} onClick={toggle}>
            {c.status === 'active' ? 'Pause campaign' : c.status === 'draft' ? 'Launch campaign' : 'Resume campaign'}
          </Button>
        </div>
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'sequence', label: `Sequence${dirty ? ' •' : ''}` },
          { id: 'leads', label: `Leads (${c.stats.total})` },
          { id: 'results', label: 'Results' },
          { id: 'settings', label: 'Settings' },
        ]}
      />

      {tab === 'sequence' && (
        <div className="stack">
          {!!c.problems?.length && !dirty && (
            <div className="note note-error">
              {c.problems.map((p) => (
                <div key={p}>{p}</div>
              ))}
            </div>
          )}
          {!!c.warnings?.length && !dirty && (
            <div className="note note-warning">
              {c.warnings.map((p) => (
                <div key={p}>{p}</div>
              ))}
            </div>
          )}
          <SequenceBuilder value={draft} onChange={setDraft} counts={c.stats.atNode} campaignId={c.id} aiVariables={c.settings.aiVariables} noteLimit={c.settings.noteLimit} />
        </div>
      )}
      {tab === 'leads' && <CampaignLeads campaign={c} onChange={campaign.reload} />}
      {tab === 'results' && <Results campaign={c} />}
      {tab === 'settings' && <CampaignSettingsTab campaign={c} onSaved={campaign.reload} onDeleted={() => nav('/campaigns')} />}
    </>
  );
}

function stepLabel(seq: Sequence | undefined, nodeId: string | null) {
  const n = nodeId && seq?.nodes[nodeId];
  if (!n) return '—';
  return n.type === 'condition' ? CONDITION_LABELS[n.kind] + '?' : n.type === 'wait' ? `Wait ${summary(n)}` : ACTION_LABELS[n.type];
}

function CampaignLeads({ campaign, onChange }: { campaign: Campaign; onChange: () => void }) {
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const leads = useApi<{ total: number; items: CampaignLead[] }>(`/api/campaigns/${campaign.id}/leads?page=${page}&pageSize=50${state ? `&state=${state}` : ''}`, 15_000);
  const lists = useApi<LeadList[]>('/api/lists');
  const [listId, setListId] = useState<number | ''>('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const { busy, run } = useAction();

  const add = () =>
    run('add', async () => {
      const r = await api(`/api/campaigns/${campaign.id}/leads`, { body: { listId: Number(listId) } });
      const skipped = [
        r.alreadyInCampaign && `${r.alreadyInCampaign} already here`,
        r.inOtherCampaign && `${r.inOtherCampaign} in another campaign`,
        r.blacklisted && `${r.blacklisted} blacklisted`,
        r.suppressed && `${r.suppressed} opted out`,
        r.alreadyConnected && `${r.alreadyConnected} already connected`,
      ].filter(Boolean);
      alert(`Added ${r.added} lead${r.added === 1 ? '' : 's'}.${skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''}`);
      await leads.reload();
      onChange();
    });

  const remove = () =>
    run('remove', async () => {
      await api(`/api/campaigns/${campaign.id}/leads/remove`, { body: { leadIds: [...selected] } });
      setSelected(new Set());
      await leads.reload();
      onChange();
    });

  return (
    <div className="stack">
      <div className="card">
        <div className="spread" style={{ flexWrap: 'wrap' }}>
          <div className="row">
            <select value={listId} onChange={(e) => setListId(e.target.value ? Number(e.target.value) : '')} style={{ width: 260 }} aria-label="Lead list">
              <option value="">Choose a lead list…</option>
              {lists.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.leads})
                </option>
              ))}
            </select>
            <Button variant="primary" disabled={!listId} busy={busy === 'add'} onClick={add}>
              Add leads
            </Button>
            <Link to="/leads" className="muted">
              Import leads
            </Link>
          </div>
          <div className="row">
            {!!selected.size && (
              <Button variant="danger" busy={busy === 'remove'} onClick={remove}>
                Remove {selected.size}
              </Button>
            )}
            <select value={state} onChange={(e) => (setState(e.target.value), setPage(1))} style={{ width: 160 }} aria-label="Filter by state">
              <option value="">All states</option>
              <option value="active">In progress</option>
              <option value="done">Finished</option>
              <option value="replied">Replied</option>
              <option value="failed">Failed</option>
              <option value="skipped">Skipped</option>
            </select>
          </div>
        </div>
      </div>
      <div className="card card-flush">
        {leads.data && !leads.data.total ? (
          <Empty title="No leads in this campaign">Pick a lead list above to add people. Duplicates, blacklisted people and leads busy in other campaigns are skipped automatically.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 32 }} />
                  <th>Lead</th>
                  <th>State</th>
                  <th>Current step</th>
                  <th>Next</th>
                  <th>Sender</th>
                  <th>Connection</th>
                </tr>
              </thead>
              <tbody>
                {leads.data?.items.map((r) => (
                  <tr key={r.lead.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${fullName(r.lead)}`}
                        checked={selected.has(r.lead.id)}
                        onChange={(e) => {
                          const s = new Set(selected);
                          e.target.checked ? s.add(r.lead.id) : s.delete(r.lead.id);
                          setSelected(s);
                        }}
                      />
                    </td>
                    <td>
                      <a href={r.lead.profileUrl} target="_blank" rel="noreferrer" className="cell-title">
                        {fullName(r.lead)}
                      </a>
                      <div className="cell-sub">{r.lead.headline || r.lead.company}</div>
                    </td>
                    <td>
                      <Pill status={r.state === 'active' ? 'running' : r.state}>{r.state === 'active' ? 'In progress' : undefined}</Pill>
                    </td>
                    <td>
                      {r.state === 'active' ? stepLabel(campaign.sequence, r.nodeId) : '—'}
                      {r.lastError && <div className="cell-sub" style={{ color: 'var(--critical-text)' }}>{r.lastError}</div>}
                    </td>
                    <td className="muted">{r.state === 'active' ? timeAgo(r.nextRunAt) : '—'}</td>
                    <td className={r.sender || r.mailbox ? undefined : 'muted'} title={r.sender || r.mailbox ? undefined : 'Assigned when its first LinkedIn or email step runs'}>
                      {r.sender?.name ?? (r.mailbox ? '' : 'Not assigned yet')}
                      {r.mailbox && <div className={r.sender ? 'cell-sub' : undefined}>{r.mailbox.name}</div>}
                      {r.lead.emailStatus === 'invalid' && <div className="cell-sub" style={{ color: 'var(--critical-text)' }} title={r.lead.emailStatusReason ?? undefined}>Email bounced</div>}
                    </td>
                    <td>
                      <Pill status={r.lead.connectionStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {leads.data && <Pager page={page} pageSize={50} total={leads.data.total} onPage={setPage} />}
      </div>
    </div>
  );
}

function Results({ campaign }: { campaign: Campaign }) {
  const analytics = useApi<any>(`/api/analytics?days=30&campaignId=${campaign.id}`, 20_000);
  const feed = useApi<any[]>(`/api/activity?limit=40&campaignId=${campaign.id}`, 10_000);
  const s = campaign.stats;
  return (
    <div className="stack">
      <div className="grid grid-4">
        <Stat label="Leads" value={s.total} sub={`${s.active} in progress`} />
        <Stat label="Invites sent" value={s.funnel.invited} sub={`${s.funnel.viewed} profiles viewed`} />
        <Stat label="Acceptance rate" value={pct(s.acceptanceRate)} sub={`${s.funnel.accepted} accepted`} />
        <Stat label="Reply rate" value={pct(s.replyRate)} sub={`${s.funnel.replied} replied`} />
      </div>
      <div className="grid grid-main-side">
        <div className="card">
          <h2 style={{ marginBottom: 12 }}>Last 30 days</h2>
          {analytics.data && (
            <LineChart
              data={analytics.data.series}
              xKey="day"
              series={[
                { key: 'connect', label: 'Invites sent', color: 'var(--series-1)' },
                { key: 'accepted', label: 'Accepted', color: 'var(--series-2)' },
                { key: 'message', label: 'Messages', color: 'var(--series-3)' },
                { key: 'replied', label: 'Replies', color: 'var(--series-4)' },
              ]}
              formatX={(d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            />
          )}
        </div>
        <div className="card">
          <h2 style={{ marginBottom: 12 }}>Funnel</h2>
          <Funnel
            stages={[
              { label: 'Leads', value: s.total },
              { label: 'Invited', value: s.funnel.invited },
              { label: 'Accepted', value: s.funnel.accepted, note: pct(s.acceptanceRate) },
              { label: 'Messaged', value: s.funnel.messaged },
              { label: 'Replied', value: s.funnel.replied, note: pct(s.replyRate) },
            ]}
          />
        </div>
      </div>
      <AbTests campaign={campaign} />
      {!!s.bySender.length && (
        <div className="card card-flush">
          <h2 style={{ padding: '16px 16px 4px' }}>By sender</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th className="num">Leads</th>
                  <th className="num">Invited</th>
                  <th className="num">Accepted</th>
                  <th className="num">Messaged</th>
                  <th className="num">Replied</th>
                </tr>
              </thead>
              <tbody>
                {s.bySender.map((r) => (
                  <tr key={r.accountId}>
                    <td>
                      <div className="row">
                        <span className="cell-title">{r.name}</span>
                        {r.status !== 'active' && <Pill status={r.status} />}
                      </div>
                      {!campaign.accountIds.includes(r.accountId) && <div className="cell-sub">No longer a sender; finishing its conversations</div>}
                    </td>
                    <td className="num">
                      {r.leads} <span className="muted">({r.active} in progress)</span>
                    </td>
                    <td className="num">{r.invited}</td>
                    <td className="num">
                      {r.accepted} <span className="muted">({pct(r.acceptanceRate)})</span>
                    </td>
                    <td className="num">{r.messaged}</td>
                    <td className="num">
                      {r.replied} <span className="muted">({pct(r.replyRate)})</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {!!s.byMailbox.length && (
        <div className="card card-flush">
          <h2 style={{ padding: '16px 16px 4px' }}>By mailbox</h2>
          <p className="muted" style={{ padding: '0 16px', margin: 0 }}>
            {s.email.sent} leads emailed · {s.email.bounced} bounced
            {(campaign.settings.trackOpens || campaign.settings.trackClicks) && ` · ${s.email.opened} opened · ${s.email.clicked} clicked (indications only: privacy proxies and scanners open mail too)`}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Mailbox</th>
                  <th className="num">Leads</th>
                  <th className="num">Emailed</th>
                  <th className="num">Replied</th>
                  <th className="num">Bounced</th>
                </tr>
              </thead>
              <tbody>
                {s.byMailbox.map((r) => (
                  <tr key={r.mailboxId}>
                    <td>
                      <div className="row">
                        <span className="cell-title">{r.name}</span>
                        {r.status !== 'active' && <Pill status={r.status} />}
                      </div>
                      {!campaign.mailboxIds.includes(r.mailboxId) && <div className="cell-sub">No longer used here; finishing its threads</div>}
                    </td>
                    <td className="num">{r.leads}</td>
                    <td className="num">{r.sent}</td>
                    <td className="num">
                      {r.replied} <span className="muted">({pct(r.replyRate)})</span>
                    </td>
                    <td className="num">{r.bounced}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="card">
        <h2 style={{ marginBottom: 8 }}>Activity</h2>
        {!feed.data?.length && <p className="muted">Nothing has happened in this campaign yet.</p>}
        {feed.data?.map((f) => (
          <div className="feed-item" key={f.id}>
            <span className={`feed-dot ${f.status}`} aria-hidden />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="spread">
                <span>
                  <strong>{ACTION_LABELS[f.type as keyof typeof ACTION_LABELS] ?? f.type}</strong>
                  {f.leadName?.trim() && <> · {f.leadName}</>}
                  {f.variant && f.type !== 'ab_winner' && <span className="muted"> · variant {f.variant}</span>}
                  {f.status !== 'ok' && <span className="muted"> ({f.status})</span>}
                </span>
                <span className="muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                  {timeAgo(f.createdAt)}
                </span>
              </div>
              {f.detail && <div className="cell-sub" style={{ maxWidth: '100%' }}>{f.detail}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// The text a variant sends, for the results table.
function variantText(node: SeqNode | undefined, id: VariantId): string {
  if (!node || (node.type !== 'connect' && node.type !== 'message' && node.type !== 'email' && node.type !== 'inmail')) return '';
  const v = (node.variants as { id: VariantId; note?: string; text?: string; subject?: string }[] | undefined)?.find((x) => x.id === id);
  if (!v) return '';
  return (v.note ?? v.text ?? v.subject ?? '').trim() || (node.type === 'connect' ? 'No note' : '');
}

// One card per A/B tested step: sends and rates per variant, the winner (or the leader once the
// gap is statistically clear), and buttons to choose a variant by hand.
function AbTests({ campaign }: { campaign: Campaign }) {
  const report = useApi<{ nodes: AbTestReport[] }>(`/api/campaigns/${campaign.id}/variants`, 20_000);
  const { busy, run } = useAction();
  if (!report.data?.nodes.length) return null;

  const choose = (t: AbTestReport, variant: VariantId | null) =>
    run(
      `${t.nodeId}:${variant}`,
      async () => report.setData(await api(`/api/campaigns/${campaign.id}/nodes/${t.nodeId}/winner`, { body: { variant } })),
      variant
        ? `Every new lead at this step now gets variant ${variant}`
        : `Leads are split between the variants again${t.autoPickAfter ? '; no winner will be picked automatically' : ''}`,
    );

  return (
    <>
      {report.data.nodes.map((t) => {
        const node = campaign.sequence?.nodes[t.nodeId];
        const metricLabel = t.metric === 'accepted' ? 'acceptance rate' : 'reply rate';
        const sent = t.variants.reduce((n, v) => n + v.sent, 0);
        const called = t.variants.some((v) => v.leader && v.significant);
        return (
          <div className="card card-flush" key={t.nodeId}>
            <div className="spread" style={{ padding: '16px 16px 4px', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <h2>A/B test: {stepLabel(campaign.sequence, t.nodeId)}</h2>
                <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>
                  Compared by {metricLabel} · {sent} sent
                  {t.winner
                    ? ` · Variant ${t.winner} ${t.decidedBy === 'auto' ? 'was picked automatically' : 'was chosen by hand'}; new leads all get it. Editing or removing it in the sequence ends the pick.`
                    : t.autoPickAfter && t.decidedBy === 'user'
                      ? ' · Leads were split again by hand, so no winner is picked automatically. Change the auto-pick setting to turn it back on.'
                      : t.autoPickAfter
                        ? ` · Once ${t.autoPickAfter} are sent, the variant ahead is picked automatically.`
                        : ''}
                  {!t.winner && !called && sent > 0 && ' Not enough data to call a winner yet: each variant needs 20 sends and a clear gap.'}
                </p>
              </div>
              {t.winner && (
                <Button size="sm" busy={busy === `${t.nodeId}:null`} onClick={() => choose(t, null)}>
                  Split leads again
                </Button>
              )}
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Variant</th>
                    <th className="num">Sent</th>
                    {t.nodeType === 'connect' && <th className="num">Accepted</th>}
                    <th className="num">Replied</th>
                    <th className="num">{t.metric === 'accepted' ? 'Acceptance' : 'Reply rate'}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {t.variants.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <div className="row">
                          <span className="cell-title">Variant {v.id}</span>
                          {t.winner === v.id ? <Pill status="winner">Winner</Pill> : !t.winner && v.leader && v.significant ? <Pill status="leading">Leading</Pill> : null}
                        </div>
                        <div className="cell-sub variant-text" title={variantText(node, v.id)}>
                          {variantText(node, v.id)}
                        </div>
                      </td>
                      <td className="num">{v.sent}</td>
                      {t.nodeType === 'connect' && <td className="num">{v.accepted}</td>}
                      <td className="num">{v.replied}</td>
                      <td className="num">
                        <strong>{pct(v.rate)}</strong>
                        {!t.winner && v.leader && !v.significant && <div className="cell-sub">ahead so far</div>}
                      </td>
                      <td className="num">
                        {t.winner !== v.id && (
                          <Button size="sm" variant="ghost" busy={busy === `${t.nodeId}:${v.id}`} onClick={() => choose(t, v.id)}>
                            Use this variant
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </>
  );
}

function CampaignSettingsTab({ campaign, onSaved, onDeleted }: { campaign: Campaign; onSaved: () => void; onDeleted: () => void }) {
  const accounts = useApi<Account[]>('/api/accounts');
  const mailboxes = useApi<Mailbox[]>('/api/mailboxes');
  const [form, setForm] = useState({ name: campaign.name, accountIds: campaign.accountIds, mailboxIds: campaign.mailboxIds, ...campaign.settings });
  const { busy, run } = useAction();
  const nav = useNavigate();

  const save = () =>
    run(
      'save',
      async () => {
        const { name, accountIds, mailboxIds, ...settings } = form;
        await api(`/api/campaigns/${campaign.id}`, { method: 'PATCH', body: { name, accountIds, mailboxIds, settings } });
        onSaved();
      },
      'Settings saved',
    );

  return (
    <div className="stack">
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="card stack">
          <Field label="Campaign name">
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <CheckList
            label="Send from"
            options={(accounts.data ?? []).map((a) => ({ value: a.id, label: a.name, sub: a.driver === 'simulator' ? 'Simulated' : undefined, status: a.status }))}
            value={form.accountIds}
            onChange={(accountIds) => setForm({ ...form, accountIds })}
            empty="No LinkedIn accounts yet. Add one on the LinkedIn accounts page."
            hint="New leads go to the account with the most room left today; each account keeps to its own limits and hours. A lead stays with the account that first contacted it, even if you remove that account here."
          />
          <CheckList
            label="Send email from"
            options={(mailboxes.data ?? []).map((m) => ({ value: m.id, label: m.name, sub: m.simulated ? `${m.fromEmail} · simulated` : m.fromEmail, status: m.status }))}
            value={form.mailboxIds}
            onChange={(mailboxIds) => setForm({ ...form, mailboxIds })}
            empty="No mailboxes yet. An admin can add one on the Mailboxes page."
            hint="Email steps rotate across these mailboxes: each lead stays with the mailbox that first emailed it, and every mailbox keeps to its own daily limit, warm-up and sending hours."
          />
          <Toggle checked={form.trackOpens} onChange={(v) => setForm({ ...form, trackOpens: v })} label="Track email opens" hint="Adds an invisible image to each email. Off by default." />
          <Toggle checked={form.trackClicks} onChange={(v) => setForm({ ...form, trackClicks: v })} label="Track link clicks" hint="Sends links through this server first. Off by default." />
          {(form.trackOpens || form.trackClicks) && (
            <div className="note">
              Tracking records when someone opens an email or clicks a link, which is personal data: make sure you have a lawful basis (for example under GDPR) and mention it in your privacy notice. Tracking images and rewritten links can also hurt deliverability, and mail privacy features and scanners make the numbers approximate. It needs PUBLIC_URL on the server.
            </div>
          )}
          <Toggle checked={form.stopOnReply} onChange={(v) => setForm({ ...form, stopOnReply: v })} label="Stop when a lead replies" hint="Recommended. Replies are picked up from the LinkedIn inbox and from the campaign's mailboxes." />
          {form.stopOnReply && (
            <CheckList<ReplyCategory>
              label="Keep going after these replies"
              options={REPLY_CATEGORIES.filter((c) => c !== 'unsubscribe' && c !== 'not_interested').map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
              value={form.continueOnCategories ?? []}
              onChange={(continueOnCategories) => setForm({ ...form, continueOnCategories })}
              hint="Leave empty to stop on any reply. With categories chosen, a lead who replies waits until the reply is classified: these categories carry on (branch on them with an “If reply is…” step, for example wait out an out-of-office), anything else stops. A reply still unclassified after the reply hold time stops it too. “Not interested” and unsubscribe replies always stop the lead, and sure ones stop it everywhere."
            />
          )}
          <Toggle checked={form.skipIfInOtherCampaign} onChange={(v) => setForm({ ...form, skipIfInOtherCampaign: v })} label="Skip leads already running in another campaign" />
          <Toggle checked={form.skipAlreadyConnected} onChange={(v) => setForm({ ...form, skipAlreadyConnected: v })} label="Skip people you're already connected to" />
          <Field label="Invitation note limit" hint="300 for most accounts. Use 200 for free accounts that get cut off.">
            <select value={form.noteLimit} onChange={(e) => setForm({ ...form, noteLimit: Number(e.target.value) })}>
              <option value={300}>300 characters</option>
              <option value={200}>200 characters</option>
            </select>
          </Field>
          <div>
            <Button variant="primary" busy={busy === 'save'} onClick={save}>
              Save settings
            </Button>
          </div>
        </div>
        <div className="card stack">
          <h2>Manage</h2>
          <div className="row">
            <Button
              busy={busy === 'dup'}
              onClick={() =>
                run('dup', async () => {
                  const r = await api(`/api/campaigns/${campaign.id}/duplicate`, { body: {} });
                  nav(`/campaigns/${r.id}`);
                })
              }
            >
              Duplicate campaign
            </Button>
            <a className="btn" href={`/api/leads/export.csv?campaignId=${campaign.id}`}>
              Export leads (CSV)
            </a>
          </div>
          <hr style={{ border: 'none', borderTop: '1px solid var(--line)', width: '100%' }} />
          <p className="muted" style={{ margin: 0 }}>
            Deleting removes the campaign and its progress. Leads and the activity history stay.
          </p>
          <div>
            <Button
              variant="danger"
              busy={busy === 'del'}
              onClick={() =>
                confirm(`Delete "${campaign.name}"?`) &&
                run('del', async () => {
                  await api(`/api/campaigns/${campaign.id}`, { method: 'DELETE' });
                  onDeleted();
                })
              }
            >
              Delete campaign
            </Button>
          </div>
        </div>
      </div>
      <div className="card stack">
        <h2>AI variables</h2>
        <AiVariablesEditor campaignId={campaign.id} value={form.aiVariables} onChange={(aiVariables) => setForm({ ...form, aiVariables })} />
        <div>
          <Button variant="primary" busy={busy === 'save'} onClick={save}>
            Save settings
          </Button>
        </div>
      </div>
    </div>
  );
}

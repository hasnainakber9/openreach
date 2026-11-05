import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, CALL_OUTCOMES, serverNow, useApi, type Campaign, type CallOutcome, type Lead, type Task, type TaskCounts, type TaskKind, type TeamMember } from '../api';
import { Icon } from '../components/Icon';
import { Button, Empty, Field, Modal, Pager, Pill, Stat, useAction } from '../components/ui';
import { dateTime, OUTCOME_LABELS, TASK_KIND_LABELS, timeAgo } from '../format';
import type { Me } from '../App';

type StatusFilter = 'open' | 'overdue' | 'done' | 'skipped' | 'all';
const PAGE_SIZE = 50;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const taskCountsPath = `/api/tasks/counts?tz=${encodeURIComponent(TZ)}`;

export default function Tasks({ me }: { me: Me }) {
  const [status, setStatus] = useState<StatusFilter>('open');
  const [assignee, setAssignee] = useState('all');
  const [campaignId, setCampaignId] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const [closing, setClosing] = useState<{ task: Task; action: 'complete' | 'skip' } | null>(null);
  const [creating, setCreating] = useState(false);
  const writer = me.role !== 'client';

  const params = new URLSearchParams({ status, assignee, page: String(page), pageSize: String(PAGE_SIZE) });
  if (campaignId) params.set('campaignId', campaignId);
  if (kind) params.set('kind', kind);
  const list = useApi<{ total: number; items: Task[] }>(`/api/tasks?${params}`, 20_000);
  const counts = useApi<TaskCounts>(taskCountsPath, 20_000);
  const team = useApi<TeamMember[]>('/api/team');
  const campaigns = useApi<Campaign[]>('/api/campaigns');
  const filter = (set: (v: any) => void) => (v: any) => (set(v), setPage(1));
  const reload = async () => void (await Promise.all([list.reload(), counts.reload()]));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Tasks</h1>
          <p>Calls and manual steps from your sequences, plus one-off to-dos. A lead waits at a task step until its task is done or skipped.</p>
        </div>
        {writer && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            New task
          </Button>
        )}
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Due today" value={counts.data?.dueToday ?? 0} sub="including overdue" />
        <Stat label="Overdue" value={counts.data?.overdue ?? 0} />
        <Stat label="Assigned to you" value={counts.data?.mine ?? 0} sub="open" />
        <Stat label="Open" value={counts.data?.open ?? 0} />
      </div>

      <div className="card card-flush">
        <div className="row" style={{ padding: 12, borderBottom: '1px solid var(--line)' }}>
          <select value={status} onChange={(e) => filter(setStatus)(e.target.value)} aria-label="Status" style={{ width: 'auto' }}>
            <option value="open">Open</option>
            <option value="overdue">Overdue</option>
            <option value="done">Done</option>
            <option value="skipped">Skipped</option>
            <option value="all">All</option>
          </select>
          <select value={assignee} onChange={(e) => filter(setAssignee)(e.target.value)} aria-label="Assignee" style={{ width: 'auto' }}>
            <option value="all">Everyone</option>
            <option value="me">Assigned to me</option>
            <option value="unassigned">Unassigned</option>
            {team.data
              ?.filter((u) => u.id !== me.id)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
          <select value={campaignId} onChange={(e) => filter(setCampaignId)(e.target.value)} aria-label="Campaign" style={{ width: 'auto' }}>
            <option value="">All campaigns</option>
            {campaigns.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select value={kind} onChange={(e) => filter(setKind)(e.target.value)} aria-label="Kind of task" style={{ width: 'auto' }}>
            <option value="">All kinds</option>
            {Object.entries(TASK_KIND_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        {list.data && !list.data.total ? (
          <Empty title={status === 'open' ? 'Nothing to do' : 'No tasks match these filters'}>
            {status === 'open' && 'Add a Manual task step to a sequence (calls, LinkedIn or email by hand), or create a one-off task.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Lead</th>
                  <th>Due</th>
                  <th>Assignee</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {list.data?.items.map((t) => (
                  <TaskRowView key={t.id} t={t} writer={writer} onClose={(action) => setClosing({ task: t, action })} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.data && <Pager page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />}
      </div>

      {closing && <CloseTaskModal task={closing.task} action={closing.action} onClose={() => setClosing(null)} onDone={reload} />}
      {creating && <NewTaskModal team={team.data ?? []} onClose={() => setCreating(false)} onDone={reload} />}
    </>
  );
}

// tel:, mailto: or the LinkedIn profile, whichever the task needs.
function contactLink(t: Task) {
  const l = t.lead;
  if (!l) return null;
  if (t.kind === 'call' && l.phone) return { href: `tel:${l.phone.replace(/[^\d+]/g, '')}`, label: l.phone, icon: 'call' };
  if (t.kind === 'manual_email' && l.email) return { href: `mailto:${l.email}`, label: l.email, icon: 'email' };
  if (l.profileUrl) return { href: l.profileUrl, label: 'Open profile', icon: 'view_profile', external: true };
  return null;
}

function TaskRowView({ t, writer, onClose }: { t: Task; writer: boolean; onClose: (action: 'complete' | 'skip') => void }) {
  const link = contactLink(t);
  return (
    <tr>
      <td>
        <div className="cell-title row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <span className="muted" aria-hidden>
            <Icon name={t.kind === 'call' ? 'call' : t.kind === 'manual_email' ? 'email' : t.kind === 'manual_linkedin' ? 'message' : 'task'} size={12} />
          </span>
          {t.title}
        </div>
        <div className="cell-sub">
          {TASK_KIND_LABELS[t.kind]}
          {t.campaign && (
            <>
              {' · '}
              <Link to={`/campaigns/${t.campaign.id}`}>{t.campaign.name}</Link>
            </>
          )}
        </div>
        {t.instructions && <div className="cell-sub task-instructions">{t.instructions}</div>}
        {t.status !== 'open' && (t.outcome || t.notes) && (
          <div className="cell-sub">
            {t.outcome && <strong>{OUTCOME_LABELS[t.outcome]}</strong>}
            {t.outcome && t.notes && ' · '}
            {t.notes}
          </div>
        )}
      </td>
      <td>
        {t.lead ? (
          <>
            <div className="cell-title">{t.lead.name}</div>
            {link && (
              <a className="cell-sub row" style={{ gap: 4 }} href={link.href} {...(link.external ? { target: '_blank', rel: 'noreferrer' } : {})}>
                <Icon name={link.icon} size={11} />
                {link.label}
              </a>
            )}
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        <div title={dateTime(t.dueAt)}>{timeAgo(t.dueAt)}</div>
        {t.status === 'open' && t.autoSkipAt && <div className="cell-sub">Skips {timeAgo(t.autoSkipAt)}</div>}
      </td>
      <td>{t.assignee?.name ?? <span className="muted">Unassigned</span>}</td>
      <td>
        <Pill status={t.overdue ? 'overdue' : t.status} />
        {t.completedAt && <div className="cell-sub">{timeAgo(t.completedAt)}</div>}
      </td>
      <td>
        {writer && t.status === 'open' && (
          <div className="row" style={{ gap: 4, flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
            <Button size="sm" onClick={() => onClose('complete')} aria-label={`Complete: ${t.title}`}>
              Complete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onClose('skip')} aria-label={`Skip: ${t.title}`}>
              Skip
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

function CloseTaskModal({ task, action, onClose, onDone }: { task: Task; action: 'complete' | 'skip'; onClose: () => void; onDone: () => Promise<void> }) {
  const [outcome, setOutcome] = useState<CallOutcome | ''>('');
  const [notes, setNotes] = useState('');
  const { busy, run } = useAction();
  const submit = () =>
    run(
      'save',
      async () => {
        const body = action === 'complete' ? { outcome: outcome || null, ...(notes.trim() ? { notes: notes.trim() } : {}) } : notes.trim() ? { notes: notes.trim() } : {};
        await api(`/api/tasks/${task.id}/${action}`, { body });
        await onDone();
        onClose();
      },
      action === 'complete' ? 'Task done' : 'Task skipped',
    );
  return (
    <Modal
      title={action === 'complete' ? `Complete: ${task.title}` : `Skip: ${task.title}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy === 'save'} onClick={submit}>
            {action === 'complete' ? 'Mark as done' : 'Skip task'}
          </Button>
        </>
      }
    >
      <div className="stack">
        {task.campaign && <p className="muted" style={{ margin: 0 }}>The lead then moves on to the next step of {task.campaign.name}.</p>}
        {action === 'complete' && task.kind === 'call' && (
          <Field label="Call outcome">
            <select value={outcome} onChange={(e) => setOutcome(e.target.value as CallOutcome | '')}>
              <option value="">Not recorded</option>
              {CALL_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {OUTCOME_LABELS[o]}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Notes" hint="Optional. Shown with the task and in the activity feed.">
          <textarea value={notes} rows={3} maxLength={4000} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function NewTaskModal({ team, onClose, onDone }: { team: TeamMember[]; onClose: () => void; onDone: () => Promise<void> }) {
  const [search, setSearch] = useState('');
  const [leadId, setLeadId] = useState<number | null>(null);
  const [form, setForm] = useState({ kind: 'call' as TaskKind, title: '', instructions: '', due: toLocalInput(serverNow() + 60 * 60 * 1000), assigneeId: '' });
  const leads = useApi<{ items: Lead[] }>(search.trim().length >= 2 ? `/api/leads?q=${encodeURIComponent(search.trim())}&pageSize=10` : null);
  const { busy, run } = useAction();
  const submit = () =>
    run(
      'save',
      async () => {
        await api('/api/tasks', {
          body: { leadId, kind: form.kind, title: form.title, instructions: form.instructions, dueAt: new Date(form.due).getTime(), assigneeId: form.assigneeId ? Number(form.assigneeId) : null },
        });
        await onDone();
        onClose();
      },
      'Task created',
    );
  return (
    <Modal
      title="New task"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy === 'save'} disabled={!leadId || !form.title.trim() || !form.due} onClick={submit}>
            Create task
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Lead" hint="Type at least two letters of a name or company.">
          <input type="search" value={search} onChange={(e) => (setSearch(e.target.value), setLeadId(null))} placeholder="Search leads" />
        </Field>
        {!!leads.data?.items.length && (
          <Field label="Pick the lead">
            <select value={leadId ?? ''} onChange={(e) => setLeadId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Choose…</option>
              {leads.data.items.map((l) => (
                <option key={l.id} value={l.id}>
                  {`${l.firstName} ${l.lastName}`.trim() || l.profileUrl}
                  {l.company ? ` (${l.company})` : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="grid grid-2">
          <Field label="Kind">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as TaskKind })}>
              {Object.entries(TASK_KIND_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Due">
            <input type="datetime-local" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
          </Field>
        </div>
        <Field label="Title">
          <input type="text" value={form.title} maxLength={200} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Call about the pilot" />
        </Field>
        <Field label="Instructions">
          <textarea value={form.instructions} rows={3} maxLength={4000} onChange={(e) => setForm({ ...form, instructions: e.target.value })} />
        </Field>
        <Field label="Assign to">
          <select value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}>
            <option value="">Nobody</option>
            {team.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

// <input type="datetime-local"> wants local time without a zone.
function toLocalInput(ms: number) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

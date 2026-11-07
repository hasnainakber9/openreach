import { useState } from 'react';
import { api, useApi, type PipelineSettings as Settings, type Stage, type StageKind, type Tag } from '../api';
import type { Me } from '../App';
import { Button, ColorTag, ConfirmButton, Field, Modal, Toggle, useAction } from '../components/ui';

const KIND_LABELS: Record<StageKind, string> = { open: 'In progress', won: 'Won', lost: 'Lost' };

// Settings → Pipeline: stages (admins), automation options and tags.
export default function PipelineSettings({ me }: { me: Me }) {
  const admin = me.role === 'owner' || me.role === 'admin';
  return (
    <div className="stack">
      <Stages admin={admin} />
      <Tags admin={admin} canCreate={me.role !== 'client'} />
    </div>
  );
}

function Stages({ admin }: { admin: boolean }) {
  const stages = useApi<Stage[]>('/api/pipeline/stages');
  const settings = useApi<Settings>('/api/pipeline/settings');
  const [adding, setAdding] = useState({ name: '', color: '#64748b', kind: 'open' as StageKind });
  const [removing, setRemoving] = useState<Stage | null>(null);
  const { busy, run } = useAction();
  const list = stages.data ?? [];

  const order = (from: number, to: number) =>
    run(`order-${from}`, async () => {
      const ids = list.map((s) => s.id);
      const [id] = ids.splice(from, 1);
      ids.splice(to, 0, id);
      stages.setData(await api<Stage[]>('/api/pipeline/stages/order', { method: 'PUT', body: { ids } }));
      await stages.reload();
    });
  const add = () =>
    run(
      'add',
      async () => {
        await api('/api/pipeline/stages', { body: { name: adding.name.trim(), color: adding.color, kind: adding.kind } });
        setAdding({ name: '', color: '#64748b', kind: 'open' });
        await stages.reload();
      },
      'Stage added',
    );
  const setAutoLost = (autoLost: boolean) =>
    run('autoLost', async () => {
      settings.setData(await api<Settings>('/api/pipeline/settings', { method: 'PUT', body: { autoLost } }));
    });

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Pipeline stages</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Leads start in the first stage. They move forward on their own (first message or invite → Contacted, a reply → Replied, an interested reply → Interested, a booked meeting → Meeting booked), never backwards and never out of a
            won or lost stage. Renamed stages keep their automation.
          </p>
        </div>
      </div>
      <ol className="stage-list">
        {list.map((s, i) => (
          // The first stage must stay an in-progress one (new leads start there), so moves that would put a won/lost stage on top are off.
          <StageRow
            key={`${s.id}-${s.name}-${s.color}-${s.kind}`}
            stage={s}
            admin={admin}
            first={i === 0}
            canUp={i > 0 && (i > 1 || s.kind === 'open')}
            canDown={i < list.length - 1 && (i > 0 || list[1].kind === 'open')}
            busy={busy}
            onUp={() => order(i, i - 1)}
            onDown={() => order(i, i + 1)}
            onSaved={stages.reload}
            onDelete={() => setRemoving(s)}
            canDelete={list.length > 1 && (i > 0 || list[1].kind === 'open')}
          />
        ))}
      </ol>
      {admin && (
        <div className="row stage-add" style={{ marginTop: 12 }}>
          <input type="text" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="New stage name" aria-label="New stage name" maxLength={50} style={{ maxWidth: 220 }} />
          <input type="color" value={adding.color} onChange={(e) => setAdding({ ...adding, color: e.target.value })} aria-label="New stage color" className="color-input" />
          <select value={adding.kind} onChange={(e) => setAdding({ ...adding, kind: e.target.value as StageKind })} aria-label="New stage type" style={{ width: 140 }}>
            {Object.entries(KIND_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <Button disabled={!adding.name.trim()} busy={busy === 'add'} onClick={add}>
            Add stage
          </Button>
        </div>
      )}
      <div style={{ marginTop: 16 }}>
        <Toggle
          checked={settings.data?.autoLost ?? false}
          onChange={(v) => admin && setAutoLost(v)}
          label="Move “not interested” replies to Lost"
          hint={admin ? 'Off by default: a polite “not right now” is easy to misread. You can always move a lead by hand.' : 'Only admins can change this.'}
        />
      </div>
      {removing && <DeleteStage stage={removing} stages={list} onClose={() => setRemoving(null)} onDone={() => (setRemoving(null), void stages.reload())} />}
    </div>
  );
}

function StageRow({
  stage: s,
  admin,
  first,
  canUp,
  canDown,
  busy,
  canDelete,
  onUp,
  onDown,
  onSaved,
  onDelete,
}: {
  stage: Stage;
  admin: boolean;
  first: boolean;
  canUp: boolean;
  canDown: boolean;
  busy: string | null;
  canDelete: boolean;
  onUp: () => void;
  onDown: () => void;
  onSaved: () => Promise<void>;
  onDelete: () => void;
}) {
  const [f, setF] = useState({ name: s.name, color: s.color, kind: s.kind });
  const { busy: saving, run } = useAction();
  const dirty = f.name !== s.name || f.color !== s.color || f.kind !== s.kind;
  const save = () =>
    run('save', async () => {
      await api(`/api/pipeline/stages/${s.id}`, { method: 'PATCH', body: { name: f.name.trim(), color: f.color, kind: f.kind } });
      await onSaved();
    });
  if (!admin)
    return (
      <li className="stage-row">
        <ColorTag color={s.color}>{s.name}</ColorTag>
        <span className="muted">{KIND_LABELS[s.kind]}</span>
        <span className="muted num" style={{ marginLeft: 'auto' }}>
          {s.leads ?? 0} leads
        </span>
      </li>
    );
  return (
    <li className="stage-row">
      <span className="row" style={{ gap: 2 }}>
        <button type="button" className="icon-btn" onClick={onUp} disabled={!canUp || !!busy} aria-label={`Move ${s.name} up`}>
          ↑
        </button>
        <button type="button" className="icon-btn" onClick={onDown} disabled={!canDown || !!busy} aria-label={`Move ${s.name} down`}>
          ↓
        </button>
      </span>
      <input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} aria-label={`Color of ${s.name}`} className="color-input" />
      <input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label={`Name of stage ${s.name}`} maxLength={50} style={{ maxWidth: 220 }} />
      <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as StageKind })} aria-label={`Type of ${s.name}`} style={{ width: 130 }}>
        {Object.entries(KIND_LABELS).map(([k, label]) => (
          <option key={k} value={k} disabled={first && k !== 'open'}>
            {label}
          </option>
        ))}
      </select>
      <span className="muted num">{s.leads ?? 0} leads</span>
      <span className="row" style={{ marginLeft: 'auto', gap: 6 }}>
        {dirty && (
          <Button size="sm" variant="primary" disabled={!f.name.trim()} busy={saving === 'save'} onClick={save}>
            Save
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={!canDelete} onClick={onDelete}>
          Delete
        </Button>
      </span>
    </li>
  );
}

function DeleteStage({ stage, stages, onClose, onDone }: { stage: Stage; stages: Stage[]; onClose: () => void; onDone: () => void }) {
  const others = stages.filter((s) => s.id !== stage.id);
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? 0);
  const { busy, run } = useAction();
  const remove = () =>
    run(
      'del',
      async () => {
        await api(`/api/pipeline/stages/${stage.id}`, { method: 'DELETE', body: { moveTo } });
        onDone();
      },
      'Stage deleted',
    );
  return (
    <Modal
      title={`Delete “${stage.name}”`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" busy={busy === 'del'} onClick={remove}>
            Delete stage
          </Button>
        </>
      }
    >
      <Field label={`Move its ${stage.leads ?? 0} lead${stage.leads === 1 ? '' : 's'} to`} hint="Each move is recorded in the lead's timeline.">
        <select value={moveTo} onChange={(e) => setMoveTo(Number(e.target.value))}>
          {others.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      {['contacted', 'replied', 'interested', 'meeting', 'lost'].includes(stage.slug) && <div className="note note-warning">Automation that moves leads into this stage stops once it is deleted.</div>}
    </Modal>
  );
}

function Tags({ admin, canCreate }: { admin: boolean; canCreate: boolean }) {
  const tags = useApi<Tag[]>('/api/tags');
  const [name, setName] = useState('');
  const [color, setColor] = useState('#3b82f6');
  const { busy, run } = useAction();
  const create = () =>
    run(
      'add',
      async () => {
        await api('/api/tags', { body: { name: name.trim(), color } });
        setName('');
        await tags.reload();
      },
      'Tag created',
    );
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Tags</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Label leads for filtering and bulk actions. Renaming or deleting a tag updates every lead that has it{admin ? '' : ' (admins only)'}.
          </p>
        </div>
      </div>
      {!tags.data?.length && <p className="muted">No tags yet. Add them here, on a lead, or in bulk from the Leads page.</p>}
      <ul className="stage-list">
        {tags.data?.map((t) => (
          <TagRow key={`${t.id}-${t.name}-${t.color}`} tag={t} admin={admin} onChanged={tags.reload} />
        ))}
      </ul>
      {canCreate && (
        <div className="row" style={{ marginTop: 12 }}>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="New tag" aria-label="New tag name" maxLength={50} style={{ maxWidth: 220 }} onKeyDown={(e) => e.key === 'Enter' && name.trim() && create()} />
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="New tag color" className="color-input" />
          <Button disabled={!name.trim()} busy={busy === 'add'} onClick={create}>
            Add tag
          </Button>
        </div>
      )}
    </div>
  );
}

function TagRow({ tag: t, admin, onChanged }: { tag: Tag; admin: boolean; onChanged: () => Promise<void> }) {
  const [f, setF] = useState({ name: t.name, color: t.color });
  const { busy, run } = useAction();
  const dirty = f.name !== t.name || f.color !== t.color;
  const save = () =>
    run('save', async () => {
      await api(`/api/tags/${t.id}`, { method: 'PATCH', body: { ...(f.name !== t.name ? { name: f.name.trim() } : {}), color: f.color } });
      await onChanged();
    });
  const remove = () =>
    run('del', async () => {
      await api(`/api/tags/${t.id}`, { method: 'DELETE' });
      await onChanged();
    });
  if (!admin)
    return (
      <li className="stage-row">
        <ColorTag color={t.color}>{t.name}</ColorTag>
        <span className="muted num" style={{ marginLeft: 'auto' }}>
          {t.leads} leads
        </span>
      </li>
    );
  return (
    <li className="stage-row">
      <input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} aria-label={`Color of tag ${t.name}`} className="color-input" />
      <input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label={`Name of tag ${t.name}`} maxLength={50} style={{ maxWidth: 220 }} />
      <span className="muted num">{t.leads} leads</span>
      <span className="row" style={{ marginLeft: 'auto', gap: 6 }}>
        {dirty && (
          <Button size="sm" variant="primary" disabled={!f.name.trim()} busy={busy === 'save'} onClick={save}>
            Save
          </Button>
        )}
        <ConfirmButton size="sm" variant="ghost" busy={busy === 'del'} onConfirm={remove} confirmLabel={t.leads ? `Remove from ${t.leads} leads?` : 'Delete?'}>
          Delete
        </ConfirmButton>
      </span>
    </li>
  );
}

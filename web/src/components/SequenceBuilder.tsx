import { useEffect, useRef, useState } from 'react';
import { api, type ConditionKind, type SeqNode, type Sequence } from '../api';
import { ACTION_LABELS, CONDITION_LABELS } from '../format';
import { Icon } from './Icon';
import { Button, Field } from './ui';

// Where a new step can go: the sequence start, or one of a node's outgoing pointers.
type Slot = { parent: null } | { parent: string; key: 'next' | 'yes' | 'no' };

const PALETTE: { type: SeqNode['type']; kind?: ConditionKind; label: string }[] = [
  { type: 'view_profile', label: ACTION_LABELS.view_profile },
  { type: 'connect', label: ACTION_LABELS.connect },
  { type: 'message', label: ACTION_LABELS.message },
  { type: 'wait', label: ACTION_LABELS.wait },
  { type: 'follow', label: ACTION_LABELS.follow },
  { type: 'like_post', label: ACTION_LABELS.like_post },
  { type: 'endorse', label: ACTION_LABELS.endorse },
  { type: 'email', label: ACTION_LABELS.email },
  { type: 'withdraw_invite', label: ACTION_LABELS.withdraw_invite },
  { type: 'condition', kind: 'accepted_within', label: 'If invite accepted' },
  { type: 'condition', kind: 'is_connected', label: 'If already connected' },
  { type: 'condition', kind: 'has_email', label: 'If email known' },
  { type: 'condition', kind: 'replied', label: 'If replied' },
];

const VARIABLES = ['firstName', 'lastName', 'company', 'title', 'headline', 'location'];

const newId = () => 'n' + Math.random().toString(36).slice(2, 8);

function makeNode(type: SeqNode['type'], kind: ConditionKind = 'accepted_within'): SeqNode {
  const id = newId();
  switch (type) {
    case 'connect':
      return { id, type, note: 'Hi {{firstName}}, ', next: null };
    case 'message':
      return { id, type, text: 'Hi {{firstName}}, ', next: null };
    case 'email':
      return { id, type, subject: 'Quick question, {{firstName}}', body: 'Hi {{firstName}},\n\n', next: null };
    case 'wait':
      return { id, type, days: 1, hours: 0, next: null };
    case 'endorse':
      return { id, type, count: 3, next: null };
    case 'condition':
      return { id, type, kind, withinDays: 7, yes: null, no: null };
    default:
      return { id, type, next: null } as SeqNode;
  }
}

function getPtr(seq: Sequence, slot: Slot): string | null {
  if (slot.parent === null) return seq.start;
  return ((seq.nodes[slot.parent] as any)?.[slot.key] ?? null) as string | null;
}

function setPtr(seq: Sequence, slot: Slot, target: string | null): Sequence {
  if (slot.parent === null) return { ...seq, start: target };
  return { ...seq, nodes: { ...seq.nodes, [slot.parent]: { ...seq.nodes[slot.parent], [slot.key]: target } as SeqNode } };
}

function findSlot(seq: Sequence, id: string): Slot {
  if (seq.start === id) return { parent: null };
  for (const n of Object.values(seq.nodes)) {
    for (const key of ['next', 'yes', 'no'] as const) if ((n as any)[key] === id) return { parent: n.id, key };
  }
  return { parent: null };
}

function subtree(seq: Sequence, id: string | null, out = new Set<string>()): Set<string> {
  if (!id || out.has(id) || !seq.nodes[id]) return out;
  out.add(id);
  const n = seq.nodes[id];
  if (n.type === 'condition') {
    subtree(seq, n.yes, out);
    subtree(seq, n.no, out);
  } else subtree(seq, n.next, out);
  return out;
}

export function summary(n: SeqNode): string {
  switch (n.type) {
    case 'connect':
      return n.note.trim() ? n.note : 'Invite without a note';
    case 'message':
      return n.text;
    case 'email':
      return n.subject;
    case 'wait':
      return [n.days ? `${n.days} day${n.days === 1 ? '' : 's'}` : '', n.hours ? `${n.hours} hour${n.hours === 1 ? '' : 's'}` : ''].filter(Boolean).join(' ') || 'No delay';
    case 'endorse':
      return `Up to ${n.count} skills`;
    case 'condition':
      return n.kind === 'accepted_within' ? `Waits up to ${n.withinDays} days` : 'Checked instantly';
    case 'view_profile':
      return 'Visits their profile so they see you';
    case 'follow':
      return 'Follows their activity';
    case 'like_post':
      return 'Likes their most recent post';
    case 'withdraw_invite':
      return 'Withdraws a pending invitation';
  }
}

export function SequenceBuilder({ value, onChange, counts = {} }: { value: Sequence; onChange: (s: Sequence) => void; counts?: Record<string, number> }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null); // serialized slot
  const seq = value;
  const node = selected ? seq.nodes[selected] : null;

  const insert = (slot: Slot, type: SeqNode['type'], kind?: ConditionKind) => {
    const n = makeNode(type, kind);
    const after = getPtr(seq, slot);
    if (n.type === 'condition') n.yes = after;
    else n.next = after;
    onChange(setPtr({ ...seq, nodes: { ...seq.nodes, [n.id]: n } }, slot, n.id));
    setAdding(null);
    setSelected(n.id);
  };

  const update = (n: SeqNode) => onChange({ ...seq, nodes: { ...seq.nodes, [n.id]: n } });

  const remove = (id: string) => {
    const n = seq.nodes[id];
    const slot = findSlot(seq, id);
    const nodes = { ...seq.nodes };
    let target: string | null;
    if (n.type === 'condition') {
      // Keep the "yes" path, drop the "no" path.
      for (const d of subtree(seq, n.no)) delete nodes[d];
      target = n.yes;
    } else target = n.next;
    delete nodes[id];
    onChange(setPtr({ ...seq, nodes }, slot, target));
    setSelected(null);
  };

  const chain = (slot: Slot): React.ReactNode => {
    const key = slot.parent === null ? 'start' : `${slot.parent}:${slot.key}`;
    const target = getPtr(seq, slot);
    const n = target ? seq.nodes[target] : null;
    return (
      <>
        <div className="connector" />
        <div style={{ position: 'relative' }}>
          <button className="add-step" aria-label="Add a step here" title="Add a step here" onClick={() => setAdding(adding === key ? null : key)}>
            +
          </button>
          {adding === key && (
            <div className="card" style={{ position: 'absolute', zIndex: 10, top: 30, left: '50%', transform: 'translateX(-50%)', width: 320, boxShadow: 'var(--shadow)', padding: 10 }}>
              <div className="palette">
                {PALETTE.map((p) => (
                  <button key={p.label} onClick={() => insert(slot, p.type, p.kind)}>
                    <span className={`node-icon`} style={{ width: 20, height: 20 }}>
                      <Icon name={p.type} size={12} />
                    </span>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="connector" />
        {!n ? (
          <div className="flow-end">End</div>
        ) : (
          <>
            <button className={`node node-${n.type} ${selected === n.id ? 'selected' : ''}`} onClick={() => setSelected(n.id)}>
              {!!counts[n.id] && <span className="node-count" title={`${counts[n.id]} leads at this step`}>{counts[n.id]}</span>}
              <div className="node-head">
                <span className="node-icon">
                  <Icon name={n.type} />
                </span>
                {n.type === 'condition' ? CONDITION_LABELS[n.kind] + '?' : ACTION_LABELS[n.type]}
              </div>
              <div className="node-summary">{summary(n)}</div>
            </button>
            {n.type === 'condition' ? (
              <>
                <div className="connector" />
                <div className="branches">
                  {(['yes', 'no'] as const).map((b) => (
                    <div className={`branch branch-${b}`} key={b}>
                      <span className="branch-label">{b === 'yes' ? 'Yes' : 'No'}</span>
                      {chain({ parent: n.id, key: b })}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              chain({ parent: n.id, key: 'next' })
            )}
          </>
        )}
      </>
    );
  };

  return (
    <div className="builder">
      <div className="canvas" onClick={(e) => e.target === e.currentTarget && (setSelected(null), setAdding(null))}>
        <div className="flow">
          <div className="flow-start">Lead added to campaign</div>
          {chain({ parent: null })}
        </div>
      </div>
      <div className="inspector">
        <div className="card">
          {node ? (
            <NodeEditor key={node.id} node={node} onChange={update} onDelete={() => remove(node.id)} />
          ) : (
            <div className="stack">
              <h2>Build your sequence</h2>
              <p className="muted" style={{ margin: 0 }}>
                Press <strong>+</strong> anywhere in the flow to add a step there. Click a step to edit it. Conditions split the flow into a <em>Yes</em> and a <em>No</em> path.
              </p>
              <div className="note">
                Messages can only reach 1st-degree connections, so put them on the <strong>Yes</strong> side of an “If invite accepted” condition. Leads that reply leave the campaign automatically (change this in Settings).
              </div>
              <div>
                <div className="field-label" style={{ marginBottom: 6 }}>
                  Personalization
                </div>
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  Use <code>{'{{firstName}}'}</code> for lead fields, <code>{'{{company|your team}}'}</code> for a fallback, and <code>{'{Hi|Hello}'}</code> to vary wording between sends. Any CSV column you imported is available as a variable too.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NodeEditor({ node, onChange, onDelete }: { node: SeqNode; onChange: (n: SeqNode) => void; onDelete: () => void }) {
  const title = node.type === 'condition' ? 'Condition' : ACTION_LABELS[node.type];
  return (
    <div className="stack">
      <div className="spread">
        <h2 className="row" style={{ gap: 8 }}>
          <span className="node-icon">
            <Icon name={node.type} />
          </span>
          {title}
        </h2>
        <Button size="sm" variant="danger" onClick={() => (node.type !== 'condition' || confirm('Delete this condition and everything on its "No" path?')) && onDelete()}>
          Delete
        </Button>
      </div>

      {node.type === 'connect' && (
        <TemplateField label="Invitation note" hint="Optional. LinkedIn allows 300 characters (200 on some free accounts); longer notes are shortened." value={node.note} limit={300} onChange={(note) => onChange({ ...node, note })} />
      )}
      {node.type === 'message' && <TemplateField label="Message" value={node.text} onChange={(text) => onChange({ ...node, text })} rows={6} />}
      {node.type === 'email' && (
        <>
          <TemplateField label="Subject" value={node.subject} onChange={(subject) => onChange({ ...node, subject })} rows={1} />
          <TemplateField label="Body" value={node.body} onChange={(body) => onChange({ ...node, body })} rows={7} hint="Sent through the account's SMTP settings to leads with a known email address." />
        </>
      )}
      {node.type === 'wait' && (
        <div className="grid grid-2">
          <Field label="Days">
            <input type="number" min={0} max={90} value={node.days} onChange={(e) => onChange({ ...node, days: Math.max(0, Number(e.target.value)) })} />
          </Field>
          <Field label="Hours">
            <input type="number" min={0} max={23} value={node.hours} onChange={(e) => onChange({ ...node, hours: Math.max(0, Math.min(23, Number(e.target.value))) })} />
          </Field>
        </div>
      )}
      {node.type === 'endorse' && (
        <Field label="Skills to endorse" hint="Only works for 1st-degree connections.">
          <input type="number" min={1} max={5} value={node.count} onChange={(e) => onChange({ ...node, count: Math.max(1, Math.min(5, Number(e.target.value))) })} />
        </Field>
      )}
      {node.type === 'condition' && (
        <>
          <Field label="Check">
            <select value={node.kind} onChange={(e) => onChange({ ...node, kind: e.target.value as ConditionKind })}>
              {Object.entries(CONDITION_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          {node.kind === 'accepted_within' && (
            <Field label="Wait for acceptance (days)" hint="Leads who accept go down Yes as soon as it's detected. The rest go down No when this time runs out.">
              <input type="number" min={1} max={90} value={node.withinDays} onChange={(e) => onChange({ ...node, withinDays: Math.max(1, Number(e.target.value)) })} />
            </Field>
          )}
        </>
      )}
      {['view_profile', 'follow', 'like_post', 'withdraw_invite'].includes(node.type) && <p className="muted" style={{ margin: 0 }}>{summary(node)}. Nothing to configure.</p>}
    </div>
  );
}

function TemplateField({ label, value, onChange, hint, limit, rows = 4 }: { label: string; value: string; onChange: (v: string) => void; hint?: string; limit?: number; rows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState<{ text: string; length: number; unknown: string[]; sampleLead: string } | null>(null);

  useEffect(() => {
    if (!value.trim()) return setPreview(null);
    const t = setTimeout(() => {
      api('/api/templates/preview', { body: { template: value } }).then(setPreview).catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [value]);

  const insertVar = (v: string) => {
    const el = ref.current;
    const token = `{{${v}}}`;
    const at = el?.selectionStart ?? value.length;
    onChange(value.slice(0, at) + token + value.slice(el?.selectionEnd ?? at));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <Field label={label} hint={hint}>
        <textarea ref={ref} value={value} rows={rows} style={rows === 1 ? { minHeight: 0 } : undefined} onChange={(e) => onChange(e.target.value)} />
      </Field>
      <div className="row" style={{ gap: 4 }}>
        {VARIABLES.map((v) => (
          <button type="button" className="chip" key={v} onClick={() => insertVar(v)}>
            {v}
          </button>
        ))}
      </div>
      {preview && (
        <div>
          <div className="field-hint" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
            <span>Preview for {preview.sampleLead}</span>
            {limit && <span style={{ color: preview.length > limit ? 'var(--critical-text)' : undefined }}>{preview.length}/{limit}</span>}
          </div>
          <div className="preview">{preview.text}</div>
          {!!preview.unknown.length && (
            <div className="field-error" style={{ marginTop: 4 }}>
              Unknown variable: {preview.unknown.map((u) => `{{${u}}}`).join(', ')}. It will be blank unless the lead has that custom field.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

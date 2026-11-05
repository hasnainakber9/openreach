import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api, REPLY_CATEGORIES, useApi, type AbMetric, type AiDraft, type AiVariable, type ConditionKind, type InMailVia, type ReplyCategory, type SeqNode, type Sequence, type TaskKind, type TeamMember, type VariantId, type VariantNode } from '../api';
import { ACTION_LABELS, CATEGORY_LABELS, CONDITION_LABELS, TASK_KIND_LABELS } from '../format';
import { AiLeadPreview, AiWriterModal, type AiStepPreview } from './Ai';
import { Icon } from './Icon';
import { Button, CheckList, Field, Toggle } from './ui';

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
  { type: 'inmail', label: ACTION_LABELS.inmail },
  { type: 'task', label: ACTION_LABELS.task },
  { type: 'sms', label: ACTION_LABELS.sms },
  { type: 'whatsapp', label: ACTION_LABELS.whatsapp },
  { type: 'find_email', label: ACTION_LABELS.find_email },
  { type: 'condition', kind: 'accepted_within', label: 'If invite accepted' },
  { type: 'condition', kind: 'is_connected', label: 'If already connected' },
  { type: 'condition', kind: 'has_email', label: 'If email known' },
  { type: 'condition', kind: 'replied', label: 'If replied' },
  { type: 'condition', kind: 'is_open_profile', label: 'If open profile' },
  { type: 'condition', kind: 'reply_sentiment', label: 'If reply is…' },
  { type: 'condition', kind: 'email_verified', label: 'If email verified' },
];

// A new "reply is" condition starts with the most common branch.
const DEFAULT_REPLY_CATEGORIES: ReplyCategory[] = ['interested'];

const VARIABLES = ['firstName', 'lastName', 'company', 'title', 'headline', 'location'];

const usesAiVariable = (text: string) => /\{\{\s*ai:/.test(text);

const newId = () => 'n' + Math.random().toString(36).slice(2, 8);

// The campaign the builder edits: its id (template previews, AI writer), its {{ai:name}} variables, its
// invitation note limit, and the lead whose AI text the previews show (shared by every step).
interface BuilderCtx {
  campaignId?: number;
  aiNames: string[];
  noteLimit: number;
  aiPreview: AiStepPreview | null;
  setAiPreview: (p: AiStepPreview | null) => void;
}
const BuilderContext = createContext<BuilderCtx>({ aiNames: [], noteLimit: 300, aiPreview: null, setAiPreview: () => {} });

function makeNode(type: SeqNode['type'], kind: ConditionKind = 'accepted_within'): SeqNode {
  const id = newId();
  switch (type) {
    case 'connect':
      return { id, type, note: 'Hi {{firstName}}, ', next: null };
    case 'message':
      return { id, type, text: 'Hi {{firstName}}, ', next: null };
    case 'email':
      return { id, type, subject: 'Quick question, {{firstName}}', body: 'Hi {{firstName}},\n\n', next: null };
    case 'inmail':
      return { id, type, subject: 'Idea for {{company|your team}}', body: 'Hi {{firstName}},\n\n', via: 'profile', next: null };
    case 'task':
      return { id, type, kind: 'call', title: 'Call {{firstName}}', instructions: '', dueAfterHours: 0, assigneeId: null, autoSkipAfterDays: null, next: null };
    case 'sms':
    case 'whatsapp':
      return { id, type, text: 'Hi {{firstName}}, ', next: null };
    case 'wait':
      return { id, type, days: 1, hours: 0, next: null };
    case 'find_email':
      return { id, type, verify: true, maxWaitHours: 6, next: null };
    case 'endorse':
      return { id, type, count: 3, next: null };
    case 'condition':
      return { id, type, kind, withinDays: 7, ...(kind === 'reply_sentiment' ? { categories: DEFAULT_REPLY_CATEGORIES } : {}), yes: null, no: null };
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

const VARIANT_IDS: VariantId[] = ['A', 'B', 'C', 'D', 'E'];
const MAX_VARIANTS = 5;

// The editable text of a message step (or of one of its variants).
type Content = { note?: string; text?: string; subject?: string; body?: string };
type Variant = Content & { id: VariantId };

const isVariantNode = (n: SeqNode): n is VariantNode => n.type === 'connect' || n.type === 'message' || n.type === 'email' || n.type === 'inmail' || n.type === 'sms';

function contentOf(n: VariantNode): Content {
  if (n.type === 'connect') return { note: n.note };
  if (n.type === 'message' || n.type === 'sms') return { text: n.text };
  return { subject: n.subject, body: n.body };
}

function variantsOf(n: VariantNode): Variant[] | null {
  return n.variants && n.variants.length >= 2 ? [...(n.variants as Variant[])].sort((a, b) => a.id.localeCompare(b.id)) : null;
}

// Writes the step's own fields from `c`, keeping the rest of the node.
function withContent(n: VariantNode, c: Content): VariantNode {
  if (n.type === 'connect') return { ...n, note: c.note ?? '' };
  if (n.type === 'message' || n.type === 'sms') return { ...n, text: c.text ?? '' };
  return { ...n, subject: c.subject ?? '', body: c.body ?? '' };
}

// Stores the variants and mirrors variant A into the single-text fields (what older readers use).
// With fewer than two left, the step goes back to a plain message.
function withVariants(n: VariantNode, variants: Variant[]): VariantNode {
  const sorted = [...variants].sort((a, b) => a.id.localeCompare(b.id));
  const { id: _id, ...first } = sorted[0];
  const base = withContent(n, first);
  if (sorted.length < 2) {
    const { variants: _v, abtest: _a, ...plain } = base;
    return plain as VariantNode;
  }
  const pick = (v: Variant) =>
    n.type === 'connect' ? { id: v.id, note: v.note ?? '' } : n.type === 'message' || n.type === 'sms' ? { id: v.id, text: v.text ?? '' } : { id: v.id, subject: v.subject ?? '', body: v.body ?? '' };
  return { ...base, variants: sorted.map(pick) } as VariantNode;
}

function contentSummary(n: VariantNode): string {
  if (n.type === 'connect') return n.note.trim() ? n.note : 'Invite without a note';
  if (n.type === 'message' || n.type === 'sms') return n.text;
  return n.subject;
}

export function summary(n: SeqNode): string {
  if (isVariantNode(n)) {
    const variants = variantsOf(n);
    return variants ? `A/B: ${variants.length} variants · ${contentSummary(n)}` : contentSummary(n);
  }
  switch (n.type) {
    case 'wait':
      return [n.days ? `${n.days} day${n.days === 1 ? '' : 's'}` : '', n.hours ? `${n.hours} hour${n.hours === 1 ? '' : 's'}` : ''].filter(Boolean).join(' ') || 'No delay';
    case 'endorse':
      return `Up to ${n.count} skills`;
    case 'condition':
      if (n.kind === 'reply_sentiment') return n.categories?.length ? `Yes: ${n.categories.map((c) => CATEGORY_LABELS[c]).join(', ')}` : 'Pick at least one reply category';
      return n.kind === 'accepted_within' ? `Waits up to ${n.withinDays} days` : 'Checked instantly';
    case 'view_profile':
      return 'Visits their profile so they see you';
    case 'follow':
      return 'Follows their activity';
    case 'like_post':
      return 'Likes their most recent post';
    case 'withdraw_invite':
      return 'Withdraws a pending invitation';
    case 'task':
      return `${TASK_KIND_LABELS[n.kind]}: ${n.title}`;
    case 'find_email':
      return `${n.verify ? 'Find and verify' : 'Find'} · waits up to ${n.maxWaitHours} h`;
    case 'whatsapp':
      return n.contentSid ? `Template ${n.contentSid.slice(0, 8)}…` : n.text;
  }
}

export function SequenceBuilder({
  value,
  onChange,
  counts = {},
  campaignId,
  aiVariables = [],
  noteLimit = 300,
}: {
  value: Sequence;
  onChange: (s: Sequence) => void;
  counts?: Record<string, number>;
  campaignId?: number;
  aiVariables?: AiVariable[];
  noteLimit?: number;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [aiPreview, setAiPreview] = useState<AiStepPreview | null>(null);
  // AI text written for older variable definitions would preview something the campaign no longer sends.
  const aiKey = JSON.stringify(aiVariables);
  useEffect(() => setAiPreview(null), [aiKey]);
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
    <BuilderContext.Provider value={{ campaignId, aiNames: aiVariables.map((v) => v.name), noteLimit, aiPreview, setAiPreview }}>
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
                    AI variables such as <code>{'{{ai:icebreaker}}'}</code> are written per lead; define them in the campaign's Settings.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </BuilderContext.Provider>
  );
}

// A draft from the AI writer as the step's text fields.
function draftContent(type: VariantNode['type'], d: AiDraft): Content {
  if (type === 'connect') return { note: d.note ?? d.text ?? '' };
  if (type === 'message' || type === 'sms') return { text: d.text ?? d.note ?? d.body ?? '' };
  return { subject: d.subject ?? '', body: d.body ?? d.text ?? '' };
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

      {isVariantNode(node) && <VariantEditor node={node} onChange={onChange} />}
      {node.type === 'email' && (
        <Toggle
          checked={!!node.replyInThread}
          onChange={(replyInThread) => onChange({ ...node, replyInThread })}
          label="Reply in the same thread"
          hint="Sends this email as a reply to the lead's previous email from the same mailbox (Re: first subject), so it stacks in one conversation. The subject above is then not used. Without an earlier email it starts a new thread."
        />
      )}
      {node.type === 'inmail' && (
        <>
          <Field label="Send from" hint="Sales Navigator writes from the lead's Sales Navigator page; the account needs Sales Navigator.">
            <select value={node.via} onChange={(e) => onChange({ ...node, via: e.target.value as InMailVia })}>
              <option value="profile">LinkedIn profile (Premium InMail)</option>
              <option value="sales_navigator">Sales Navigator</option>
            </select>
          </Field>
          <div className="note">
            InMail reaches people you aren't connected to. It uses the account's InMail credits (Premium or Sales Navigator), except for open profiles, which are free. Without credits, leads who aren't open profiles are skipped. Leads who are already connected get a normal message instead (it counts toward the account's daily message limit).
          </div>
        </>
      )}
      {node.type === 'sms' && (
        <div className="note">
          Sent through the SMS provider under Settings → Integrations (Twilio, or the simulator, which sends nothing) to leads with a phone number, within the
          provider's daily limit and sending hours. People who reply STOP are never texted again.
        </div>
      )}
      {node.type === 'whatsapp' && <WhatsAppEditor node={node} onChange={onChange} />}
      {node.type === 'task' && <TaskEditor node={node} onChange={onChange} />}
      {node.type === 'find_email' && (
        <>
          <Toggle checked={node.verify} onChange={(verify) => onChange({ ...node, verify })} label="Verify the address" hint="Checks found and existing addresses with your email verifier before going on." />
          <Field label="Wait at most (hours)" hint="The lead goes on as soon as the lookup is done, or after this long either way.">
            <input type="number" min={1} max={48} value={node.maxWaitHours} onChange={(e) => onChange({ ...node, maxWaitHours: Math.max(1, Math.min(48, Number(e.target.value) || 1)) })} />
          </Field>
          <div className="note">
            Looks up the lead's work email with the finders under Settings → Integrations, in their order, until one returns an address that passes verification. Leads that already have a verified address go straight on, and addresses people entered are never replaced. Follow it with <em>If email verified</em> to send email only to good addresses.
          </div>
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
            <select
              value={node.kind}
              onChange={(e) => {
                const kind = e.target.value as ConditionKind;
                onChange({ ...node, kind, ...(kind === 'reply_sentiment' && !node.categories?.length ? { categories: DEFAULT_REPLY_CATEGORIES } : {}) });
              }}
            >
              {Object.entries(CONDITION_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          {node.kind === 'reply_sentiment' && (
            <CheckList<ReplyCategory>
              label="Go down Yes when the latest reply is"
              options={REPLY_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
              value={node.categories ?? []}
              onChange={(categories) => onChange({ ...node, categories })}
              hint="Uses the latest reply since the lead joined this campaign, as classified by AI (or set by hand in the inbox). No reply goes down No. A reply that isn't classified yet waits for it, up to the reply hold time. While the campaign stops on replies, only categories under Settings → Keep going after these replies ever get here."
            />
          )}
          {node.kind === 'email_verified' && (
            <span className="field-hint">Yes when the lead's address was verified as valid (or risky, if Settings → Integrations accepts risky addresses). Put a Find email step before this.</span>
          )}
          {node.kind === 'is_open_profile' && (
            <span className="field-hint">Known once a View profile step has visited the lead. Leads not viewed yet go down No, so put a View profile step before this.</span>
          )}
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

// The text fields of a connect/message/email step, one set per A/B variant when the step has them.
function VariantEditor({ node, onChange }: { node: VariantNode; onChange: (n: SeqNode) => void }) {
  const variants = variantsOf(node);
  const [active, setActive] = useState<VariantId>('A');
  const [writing, setWriting] = useState(false);
  const { campaignId, aiNames, aiPreview, setAiPreview } = useContext(BuilderContext);
  const current = variants?.find((v) => v.id === active) ?? variants?.[0];
  const shown = current ?? contentOf(node);
  const aiPreviewControl = !!campaignId && aiNames.length > 0 && [shown.note, shown.text, shown.subject, shown.body].some((t) => t != null && usesAiVariable(t)) && (
    <AiLeadPreview campaignId={campaignId} value={aiPreview} onChange={setAiPreview} />
  );

  const startTest = () => {
    const c = contentOf(node);
    onChange(withVariants(node, [{ id: 'A', ...c }, { id: 'B', ...c }]));
    setActive('B');
  };
  const addVariant = () => {
    if (!variants || !current) return;
    const id = VARIANT_IDS.find((x) => !variants.some((v) => v.id === x))!;
    onChange(withVariants(node, [...variants, { ...current, id }]));
    setActive(id);
  };
  const removeVariant = (id: VariantId) => {
    if (!variants) return;
    const rest = variants.filter((v) => v.id !== id);
    onChange(withVariants(node, rest));
    setActive(rest[0].id);
  };
  const editVariant = (c: Content) => {
    if (variants && current) onChange(withVariants(node, variants.map((v) => (v.id === current.id ? { ...v, ...c } : v))));
  };
  // A draft fills the text being edited; "use all" makes the drafts the step's variants A, B, ...
  const writer = writing && (
    <AiWriterModal
      nodeType={node.type}
      campaignId={campaignId}
      onClose={() => setWriting(false)}
      onUse={(d) => {
        const c = draftContent(node.type, d);
        if (variants && current) editVariant(c);
        else onChange(withContent(node, c));
        setWriting(false);
      }}
      onUseAll={(ds) => {
        onChange(withVariants(node, ds.slice(0, MAX_VARIANTS).map((d, i) => ({ id: VARIANT_IDS[i], ...draftContent(node.type, d) }))));
        setActive('A');
        setWriting(false);
      }}
    />
  );
  const writeButton = (
    <Button size="sm" onClick={() => setWriting(true)}>
      Write with AI
    </Button>
  );

  if (!variants || !current) {
    return (
      <>
        <ContentFields type={node.type} value={contentOf(node)} onChange={(c) => onChange(withContent(node, c))} />
        {aiPreviewControl}
        {writer}
        <div className="stack" style={{ gap: 4 }}>
          <div className="row">
            {writeButton}
            <Button size="sm" onClick={startTest}>
              Add A/B variant
            </Button>
          </div>
          <span className="field-hint">Try up to 5 versions of this text. Each lead gets one of them, and the Results tab compares them.</span>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="variant-bar">
        <div className="variant-tabs" role="tablist" aria-label="A/B variants">
          {variants.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={v.id === current.id}
              aria-label={`Variant ${v.id}`}
              className={v.id === current.id ? 'variant-tab active' : 'variant-tab'}
              onClick={() => setActive(v.id)}
            >
              {v.id}
            </button>
          ))}
        </div>
        {variants.length < MAX_VARIANTS && (
          <Button size="sm" variant="ghost" onClick={addVariant}>
            + Add variant
          </Button>
        )}
      </div>
      <div className="spread">
        <strong>Variant {current.id}</strong>
        <div className="row">
          {writeButton}
          <Button size="sm" variant="ghost" aria-label={`Remove variant ${current.id}`} onClick={() => removeVariant(current.id)}>
            Remove
          </Button>
        </div>
      </div>
      {writer}
      <ContentFields key={current.id} type={node.type} value={current} onChange={editVariant} variantId={current.id} />
      {aiPreviewControl}
      <span className="field-hint">Saving a changed variant starts its results over, and a winner that was changed or removed stops being the winner.</span>
      <AutoPick node={node} onChange={onChange} />
    </>
  );
}

function ContentFields({ type, value, onChange, variantId }: { type: VariantNode['type']; value: Content; onChange: (c: Content) => void; variantId?: VariantId }) {
  const suffix = variantId ? ` (variant ${variantId})` : '';
  const { noteLimit } = useContext(BuilderContext);
  if (type === 'connect') {
    return (
      <TemplateField
        label={`Invitation note${suffix}`}
        hint={`Optional. LinkedIn allows 300 characters (200 on some free accounts); this campaign uses ${noteLimit} (see Settings). Longer notes are shortened.`}
        value={value.note ?? ''}
        limit={noteLimit}
        onChange={(note) => onChange({ ...value, note })}
      />
    );
  }
  if (type === 'message') return <TemplateField label={`Message${suffix}`} value={value.text ?? ''} onChange={(text) => onChange({ ...value, text })} rows={6} />;
  if (type === 'sms') {
    return (
      <TemplateField
        label={`Text message${suffix}`}
        value={value.text ?? ''}
        onChange={(text) => onChange({ ...value, text })}
        rows={4}
        limit={SMS_MAX}
        hint="Over 160 characters (70 with emoji) a text goes out as several SMS segments, each charged."
      />
    );
  }
  if (type === 'inmail') {
    return (
      <>
        <TemplateField label={`Subject${suffix}`} value={value.subject ?? ''} onChange={(subject) => onChange({ ...value, subject })} rows={1} limit={200} />
        <TemplateField label={`Message${suffix}`} value={value.body ?? ''} onChange={(body) => onChange({ ...value, body })} rows={7} limit={1900} />
      </>
    );
  }
  return (
    <>
      <TemplateField label={`Subject${suffix}`} value={value.subject ?? ''} onChange={(subject) => onChange({ ...value, subject })} rows={1} />
      <TemplateField
        label={`Body${suffix}`}
        value={value.body ?? ''}
        onChange={(body) => onChange({ ...value, body })}
        rows={7}
        hint="Sent from the campaign's mailboxes (see Settings) to leads with a known email address, with your signature and an unsubscribe link."
      />
    </>
  );
}

const SMS_MAX = 1600;

function TaskEditor({ node, onChange }: { node: Extract<SeqNode, { type: 'task' }>; onChange: (n: SeqNode) => void }) {
  const team = useApi<TeamMember[]>('/api/team');
  return (
    <>
      <Field label="Kind of task">
        <select value={node.kind} onChange={(e) => onChange({ ...node, kind: e.target.value as TaskKind })}>
          {Object.entries(TASK_KIND_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Title" hint="Variables such as {{firstName}} work here too.">
        <input type="text" value={node.title} maxLength={200} onChange={(e) => onChange({ ...node, title: e.target.value })} />
      </Field>
      <TemplateField label="Instructions" value={node.instructions} onChange={(instructions) => onChange({ ...node, instructions })} rows={4} hint="What to do or say, filled in for each lead." ai={false} />
      <div className="grid grid-2">
        <Field label="Due after (hours)" hint="Counted from when the lead reaches this step.">
          <input type="number" min={0} max={720} value={node.dueAfterHours} onChange={(e) => onChange({ ...node, dueAfterHours: Math.max(0, Math.min(720, Number(e.target.value) || 0)) })} />
        </Field>
        <Field label="Assign to">
          <select value={node.assigneeId ?? ''} onChange={(e) => onChange({ ...node, assigneeId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Nobody (anyone can pick it up)</option>
            {team.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Toggle
        checked={node.autoSkipAfterDays != null}
        onChange={(on) => onChange({ ...node, autoSkipAfterDays: on ? 3 : null })}
        label="Skip automatically"
        hint="If nobody completes the task, it is skipped this many days after it is due and the lead moves on."
      />
      {node.autoSkipAfterDays != null && (
        <Field label="Days after the due date">
          <input
            type="number"
            min={1}
            max={60}
            value={node.autoSkipAfterDays}
            onChange={(e) => onChange({ ...node, autoSkipAfterDays: Math.max(1, Math.min(60, Math.round(Number(e.target.value) || 1))) })}
          />
        </Field>
      )}
      <div className="note">The lead waits at this step until the task is completed or skipped on the Tasks page. A lead that replies or leaves the campaign has its task skipped.</div>
    </>
  );
}

// WhatsApp only delivers free text within 24 hours of the person's last message; outside that window it needs an
// approved template, identified by its Content SID, with the template's variables.
function WhatsAppEditor({ node, onChange }: { node: Extract<SeqNode, { type: 'whatsapp' }>; onChange: (n: SeqNode) => void }) {
  const vars = Object.entries(node.contentVariables ?? {});
  const setVars = (entries: [string, string][]) => onChange({ ...node, contentVariables: entries.length ? Object.fromEntries(entries) : undefined });
  return (
    <>
      <TemplateField
        label="Message"
        value={node.text}
        onChange={(text) => onChange({ ...node, text })}
        rows={4}
        limit={SMS_MAX}
        hint={node.contentSid ? 'Shown in the inbox; WhatsApp delivers the template.' : 'Sent through the SMS provider’s WhatsApp sender to leads with a phone number.'}
      />
      <Field
        label="Approved template (Content SID)"
        hint="Optional. A first WhatsApp message to someone needs an approved template (HX…); free text only reaches people who wrote to you in the last 24 hours."
      >
        <input type="text" value={node.contentSid ?? ''} placeholder="HX…" onChange={(e) => onChange({ ...node, contentSid: e.target.value.trim() || undefined })} />
      </Field>
      {node.contentSid && (
        <div className="stack" style={{ gap: 6 }}>
          <span className="field-label">Template variables</span>
          {vars.map(([k, v], i) => (
            <div className="row" key={i} style={{ flexWrap: 'nowrap' }}>
              <input type="text" value={k} aria-label={`Variable ${i + 1} name`} style={{ width: 70 }} onChange={(e) => setVars(vars.map((x, j) => (j === i ? [e.target.value.replace(/\W/g, ''), x[1]] : x)))} />
              <input type="text" value={v} aria-label={`Variable ${i + 1} value`} placeholder="{{firstName}}" onChange={(e) => setVars(vars.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
              <Button size="sm" variant="ghost" aria-label={`Remove variable ${i + 1}`} onClick={() => setVars(vars.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button size="sm" onClick={() => setVars([...vars, [String(vars.length + 1), '']])}>
              + Add variable
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

// "Pick a winner after N sends": from then on every new lead at this step gets the best variant.
function AutoPick({ node, onChange }: { node: VariantNode; onChange: (n: SeqNode) => void }) {
  const ab = node.abtest ?? { autoPickAfter: null };
  const metric: AbMetric = ab.metric ?? (node.type === 'connect' ? 'accepted' : 'replied');
  const set = (patch: Partial<typeof ab>) => onChange({ ...node, abtest: { ...ab, ...patch } } as VariantNode);
  return (
    <div className="stack" style={{ gap: 8 }}>
      {node.type === 'connect' ? (
        <Field label="Compare variants by">
          <select value={metric} onChange={(e) => set({ metric: e.target.value as AbMetric })}>
            <option value="accepted">Acceptance rate</option>
            <option value="replied">Reply rate</option>
          </select>
        </Field>
      ) : (
        <span className="field-hint">Variants are compared by reply rate.</span>
      )}
      <Toggle
        checked={ab.autoPickAfter != null}
        onChange={(on) => set({ autoPickAfter: on ? 100 : null })}
        label="Pick a winner automatically"
        hint="After enough sends, once one variant is ahead of the rest, every new lead at this step gets it. Leads who already got a variant keep it."
      />
      {ab.autoPickAfter != null && (
        <Field label="After this many sends" hint="20 to 10,000, all variants together.">
          <input
            type="number"
            min={20}
            max={10000}
            value={ab.autoPickAfter}
            onChange={(e) => set({ autoPickAfter: Math.min(10000, Math.max(1, Math.round(Number(e.target.value) || 0))) })}
            onBlur={() => (ab.autoPickAfter ?? 0) < 20 && set({ autoPickAfter: 20 })}
          />
        </Field>
      )}
      {ab.autoPickAfter != null && metric === 'accepted' && (
        <span className="field-hint">Invites take days to be accepted, so a winner picked right after the last send only sees early results. A larger number gives a fairer pick.</span>
      )}
    </div>
  );
}

// `ai`: offer the campaign's {{ai:name}} variables (task instructions don't fill them in).
function TemplateField({ label, value, onChange, hint, limit, rows = 4, ai = true }: { label: string; value: string; onChange: (v: string) => void; hint?: string; limit?: number; rows?: number; ai?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState<{ text: string; length: number; unknown: string[]; sampleLead: string } | null>(null);
  const { campaignId, aiNames, aiPreview } = useContext(BuilderContext);
  const usesAi = ai && !!campaignId && aiNames.length > 0 && usesAiVariable(value);

  useEffect(() => {
    if (!value.trim()) return setPreview(null);
    // With AI text written for a lead, the preview is that lead's message as it would be sent.
    const ai = aiPreview ? { leadId: aiPreview.leadId, aiValues: aiPreview.values } : {};
    const t = setTimeout(() => {
      api('/api/templates/preview', { body: { template: value, campaignId, ...ai } }).then(setPreview).catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [value, campaignId, aiPreview]);

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
        {[...VARIABLES, ...(ai ? aiNames.map((n) => `ai:${n}`) : [])].map((v) => (
          <button type="button" className="chip" key={v} onClick={() => insertVar(v)}>
            {v}
          </button>
        ))}
      </div>
      {preview && (
        <div>
          <div className="field-hint" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
            <span>
              Preview for {preview.sampleLead}
              {usesAi && !aiPreview && ' (AI variables show their fallback)'}
            </span>
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

import { useState } from 'react';
import { api, useApi, type AiBrief, type AiDraft, type AiLength, type AiPreview, type AiTone, type AiVariable, type AiWriteResult, type CampaignLead, type Lead } from '../api';
import { fullName } from '../format';
import { Button, ErrorNote, Field, Modal, ProviderBadge } from './ui';

export type WriterNodeType = 'connect' | 'message' | 'inmail' | 'email';

const TONES: { value: AiTone; label: string }[] = [
  { value: 'friendly', label: 'Friendly' },
  { value: 'professional', label: 'Professional' },
  { value: 'direct', label: 'Direct' },
  { value: 'casual', label: 'Casual' },
];
const LENGTHS: { value: AiLength; label: string }[] = [
  { value: 'short', label: 'Short' },
  { value: 'medium', label: 'Medium' },
  { value: 'long', label: 'Long' },
];

// The last brief is kept while the page is open, so writing the next step starts from it.
let lastBrief: AiBrief = { offer: '', tone: 'friendly', length: 'short', language: 'English' };

// Drafts text from a short brief. Nothing is saved or sent until the user inserts a draft and saves the sequence.
export function AiWriterModal({
  nodeType,
  campaignId,
  onUse,
  onUseAll,
  onClose,
}: {
  nodeType: WriterNodeType;
  campaignId?: number;
  onUse: (d: AiDraft) => void;
  onUseAll?: (ds: AiDraft[]) => void;
  onClose: () => void;
}) {
  const [brief, setBrief] = useState<AiBrief>(lastBrief);
  const [variants, setVariants] = useState(onUseAll ? 2 : 1);
  const [result, setResult] = useState<AiWriteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<AiBrief>) => setBrief((b) => ({ ...b, ...patch }));

  const write = async (e: React.FormEvent) => {
    e.preventDefault();
    lastBrief = brief;
    setBusy(true);
    setError(null);
    try {
      setResult(await api<AiWriteResult>('/api/ai/write', { body: { nodeType, brief: { ...brief, audience: brief.audience || undefined, cta: brief.cta || undefined }, variants, campaignId } }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Write with AI"
      onClose={onClose}
      wide
      footer={
        <>
          {onUseAll && result && result.drafts.length >= 2 && (
            <Button onClick={() => onUseAll(result.drafts)}>Use all {result.drafts.length} as A/B variants</Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <form className="stack" onSubmit={write}>
        <Field label="What do you offer?" hint="One or two sentences: the problem you solve and for whom.">
          <textarea value={brief.offer} rows={3} required minLength={3} maxLength={1000} onChange={(e) => set({ offer: e.target.value })} />
        </Field>
        <div className="grid grid-2">
          <Field label="Audience (optional)">
            <input type="text" value={brief.audience ?? ''} maxLength={300} placeholder="e.g. Heads of HR at 50–500 person companies" onChange={(e) => set({ audience: e.target.value })} />
          </Field>
          <Field label="Call to action (optional)">
            <input type="text" value={brief.cta ?? ''} maxLength={200} placeholder="e.g. a 15-minute call" onChange={(e) => set({ cta: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-3">
          <Field label="Tone">
            <select value={brief.tone} onChange={(e) => set({ tone: e.target.value as AiTone })}>
              {TONES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Length">
            <select value={brief.length} onChange={(e) => set({ length: e.target.value as AiLength })} disabled={nodeType === 'connect'}>
              {LENGTHS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Language">
            <input type="text" value={brief.language} minLength={2} maxLength={40} required onChange={(e) => set({ language: e.target.value })} />
          </Field>
        </div>
        <div className="row" style={{ alignItems: 'end' }}>
          <Field label="Drafts">
            <select value={variants} onChange={(e) => setVariants(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit" variant="primary" busy={busy}>
            {result ? 'Write again' : 'Write drafts'}
          </Button>
        </div>
      </form>
      <ErrorNote error={error} />
      {result && (
        <div className="stack" style={{ marginTop: 16 }} aria-live="polite">
          <div className="row">
            <strong>Drafts</strong>
            <ProviderBadge simulated={result.simulated} />
          </div>
          {!!result.warnings.length && (
            <div className="note note-warning">
              {result.warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
          )}
          {result.drafts.map((d, i) => (
            <div key={i} className="ai-draft">
              {d.subject && (
                <div>
                  <span className="field-hint">Subject</span>
                  <div className="preview">{d.subject}</div>
                </div>
              )}
              <div className="preview">{d.note ?? d.text ?? d.body}</div>
              <div>
                <Button size="sm" onClick={() => onUse(d)} aria-label={`Use draft ${i + 1}`}>
                  Use this draft
                </Button>
              </div>
            </div>
          ))}
          <span className="field-hint">Drafts use variables like {'{{firstName}}'}; check them in the step's preview before you save. Nothing is sent from here.</span>
        </div>
      )}
    </Modal>
  );
}

const NAME_RE = /^[a-z][a-zA-Z0-9_]{0,30}$/;
const MAX_VARIABLES = 10;

// Leads to preview AI text on: the campaign's own, or any workspace lead before it has some.
function useSampleLeads(campaignId: number): Lead[] {
  const campaignLeads = useApi<{ total: number; items: CampaignLead[] }>(`/api/campaigns/${campaignId}/leads?pageSize=50`);
  const anyLeads = useApi<{ items: Lead[] }>(campaignLeads.data && !campaignLeads.data.total ? '/api/leads?pageSize=50' : null);
  return campaignLeads.data?.total ? campaignLeads.data.items.map((i) => i.lead) : (anyLeads.data?.items ?? []);
}

function LeadSelect({ leads, value, onChange, label }: { leads: Lead[]; value: number | ''; onChange: (id: number | '') => void; label: string }) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}>
        <option value="">Choose a lead…</option>
        {leads.map((l) => (
          <option key={l.id} value={l.id}>
            {fullName(l)}
            {l.company ? ` · ${l.company}` : ''}
          </option>
        ))}
      </select>
    </Field>
  );
}

export interface AiStepPreview extends AiPreview {
  leadId: number;
}

// In the builder: writes the campaign's saved AI variables for one lead, so every text field's preview
// shows that lead's message with its AI text in (and its length against the limit). Nothing is cached or sent.
export function AiLeadPreview({ campaignId, value, onChange }: { campaignId: number; value: AiStepPreview | null; onChange: (p: AiStepPreview | null) => void }) {
  const leads = useSampleLeads(campaignId);
  const [leadId, setLeadId] = useState<number | ''>(value?.leadId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!leadId) return;
    setBusy(true);
    setError(null);
    try {
      onChange({ leadId, ...(await api<AiPreview>(`/api/campaigns/${campaignId}/ai/preview`, { body: { leadId } })) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const failed = value ? Object.entries(value.errors) : [];

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ alignItems: 'end' }}>
        <LeadSelect leads={leads} value={leadId} onChange={setLeadId} label="Preview AI text on lead" />
        <Button size="sm" busy={busy} disabled={!leadId} onClick={run}>
          {value && value.leadId === leadId ? 'Write again' : 'Write AI text'}
        </Button>
        {value && (
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            Clear
          </Button>
        )}
        {value && <ProviderBadge simulated={value.simulated} />}
      </div>
      {failed.map(([name, msg]) => (
        <div key={name} className="field-error">
          {`{{ai:${name}}}`}: {msg}; the fallback is shown.
        </div>
      ))}
      <ErrorNote error={error} />
    </div>
  );
}

// The campaign's {{ai:name}} variables, with a preview on one of its leads. Saved with the campaign settings.
export function AiVariablesEditor({ campaignId, value, onChange }: { campaignId: number; value: AiVariable[]; onChange: (v: AiVariable[]) => void }) {
  const leads = useSampleLeads(campaignId);
  const [leadId, setLeadId] = useState<number | ''>('');
  const [preview, setPreview] = useState<AiPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const edit = (i: number, patch: Partial<AiVariable>) => onChange(value.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const add = () => {
    const taken = new Set(value.map((v) => v.name));
    const name = ['icebreaker', 'compliment', 'painPoint', 'reason'].find((n) => !taken.has(n)) ?? `var${value.length + 1}`;
    onChange([...value, { name, instruction: '', fallback: '', maxChars: 250 }]);
  };
  const problems = value.flatMap((v, i) => [
    !NAME_RE.test(v.name) ? `Variable ${i + 1}: the name must start with a lowercase letter and use only letters, digits and _.` : null,
    value.findIndex((x) => x.name === v.name) !== i ? `Variable ${i + 1}: "${v.name}" is used twice.` : null,
    !v.instruction.trim() ? `Variable ${i + 1}: write an instruction.` : null,
  ]).filter((p): p is string => !!p);

  const runPreview = async () => {
    if (!leadId) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await api<AiPreview>(`/api/campaigns/${campaignId}/ai/preview`, { body: { leadId, variables: value } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        Write a short instruction, and the AI writes a line for each lead from their profile before the step runs. Use it in any message as <code>{'{{ai:icebreaker}}'}</code>. If writing fails or
        takes too long, the fallback is sent instead (leave it empty to use the message's own fallback, like <code>{'{{ai:icebreaker|Hope you are well.}}'}</code>). Text from the built-in simulator is
        only used with simulated accounts.
      </p>
      {value.map((v, i) => (
        <fieldset key={i} className="ai-var">
          <legend className="sr-only">AI variable {i + 1}</legend>
          <div className="grid grid-2">
            <Field label="Name" hint={<code>{`{{ai:${v.name || 'name'}}}`}</code>}>
              <input type="text" value={v.name} maxLength={31} onChange={(e) => edit(i, { name: e.target.value.trim() })} />
            </Field>
            <Field label="Maximum length" hint="20 to 500 characters">
              <input type="number" min={20} max={500} value={v.maxChars} onChange={(e) => edit(i, { maxChars: Math.max(20, Math.min(500, Math.round(Number(e.target.value) || 20))) })} />
            </Field>
          </div>
          <Field label="Instruction">
            <textarea rows={2} maxLength={1000} value={v.instruction} placeholder="One friendly sentence about something specific in their role or company." onChange={(e) => edit(i, { instruction: e.target.value })} />
          </Field>
          <Field label="Fallback">
            <input type="text" maxLength={300} value={v.fallback} placeholder="Sent when no AI text is available" onChange={(e) => edit(i, { fallback: e.target.value })} />
          </Field>
          <div>
            <Button size="sm" variant="ghost" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove AI variable ${v.name || i + 1}`}>
              Remove
            </Button>
          </div>
          {preview && v.name in preview.values && (
            <div>
              <span className="field-hint">Preview</span>
              <div className="preview">{preview.values[v.name] || <span className="muted">(empty)</span>}</div>
              {preview.errors[v.name] && <div className="field-error">{preview.errors[v.name]}; the fallback would be sent.</div>}
            </div>
          )}
        </fieldset>
      ))}
      {!!problems.length && (
        <div className="note note-warning">
          {problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      )}
      <div className="row">
        {value.length < MAX_VARIABLES && (
          <Button size="sm" onClick={add}>
            + Add AI variable
          </Button>
        )}
      </div>
      {!!value.length && (
        <div className="row" style={{ alignItems: 'end' }}>
          <LeadSelect leads={leads} value={leadId} onChange={setLeadId} label="Preview on lead" />
          <Button busy={busy} disabled={!leadId || !!problems.length} onClick={runPreview}>
            Preview
          </Button>
          {preview && <ProviderBadge simulated={preview.simulated} />}
        </div>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

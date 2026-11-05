import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export function Button({
  variant = 'default',
  size,
  busy,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost'; size?: 'sm'; busy?: boolean }) {
  return (
    <button {...rest} disabled={rest.disabled || busy} className={`btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''} ${rest.className ?? ''}`}>
      {busy && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}

const STATUS_TONE: Record<string, string> = {
  active: 'good',
  connected: 'good',
  done: 'neutral',
  replied: 'info',
  draft: 'neutral',
  paused: 'warning',
  pending: 'warning',
  none: 'neutral',
  needs_login: 'critical',
  needs_attention: 'critical',
  removed: 'neutral',
  failed: 'critical',
  error: 'critical',
  skipped: 'neutral',
  running: 'info',
  completed: 'neutral',
  ok: 'good',
  untested: 'neutral',
  winner: 'good',
  leading: 'info',
  open_profile: 'info',
  // Reply categories
  interested: 'good',
  meeting_booked: 'good',
  question: 'info',
  not_now: 'warning',
  not_interested: 'critical',
  out_of_office: 'neutral',
  wrong_person: 'warning',
  unsubscribe: 'critical',
  other: 'neutral',
};

const STATUS_TEXT: Record<string, string> = { needs_login: 'Needs login', needs_attention: 'Needs attention', none: 'Not connected', ok: 'Working', untested: 'Not tested' };

export function Pill({ status, children }: { status: string; children?: ReactNode }) {
  const tone = STATUS_TONE[status] ?? 'neutral';
  return (
    <span className={`pill pill-${tone}`}>
      <span className="pill-dot" aria-hidden />
      {children ?? STATUS_TEXT[status] ?? status.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}
    </span>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, error }: { label: string; hint?: ReactNode; children: ReactNode; error?: string | null }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden>
        <span className="toggle-thumb" />
      </span>
      <span>
        <span className="toggle-label">{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </span>
    </label>
  );
}

export interface CheckOption<T extends string | number> {
  value: T;
  label: ReactNode;
  status?: string;
  sub?: ReactNode;
}

// Accessible multi-select: a labelled group of checkboxes, each with an optional status pill.
// The selection comes back in option order.
export function CheckList<T extends string | number>({
  label,
  options,
  value,
  onChange,
  hint,
  empty,
}: {
  label: string;
  options: CheckOption<T>[];
  value: T[];
  onChange: (v: T[]) => void;
  hint?: ReactNode;
  empty?: ReactNode;
}) {
  const toggle = (v: T, on: boolean) => {
    const next = new Set(value);
    on ? next.add(v) : next.delete(v);
    onChange(options.filter((o) => next.has(o.value)).map((o) => o.value));
  };
  return (
    <fieldset className="field checklist">
      <legend className="field-label">{label}</legend>
      {!options.length && empty && <span className="field-hint">{empty}</span>}
      {options.map((o) => (
        <label key={o.value} className="checklist-item">
          <input type="checkbox" checked={value.includes(o.value)} onChange={(e) => toggle(o.value, e.target.checked)} />
          <span className="checklist-text">
            <span>{o.label}</span>
            {o.sub && <span className="field-hint">{o.sub}</span>}
          </span>
          {o.status && <Pill status={o.status} />}
        </label>
      ))}
      {hint && <span className="field-hint">{hint}</span>}
    </fieldset>
  );
}

// Secrets are never sent back to the browser, only a mask. Blank keeps the saved value.
export function SecretField({
  label,
  saved,
  value,
  onChange,
  required,
  placeholder,
  hint,
}: {
  label: string;
  saved?: string | null;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
  hint?: ReactNode;
}) {
  return (
    <Field
      label={label}
      hint={
        <>
          {saved ? `Saved ${saved}. Leave blank to keep it.` : null}
          {saved && hint ? ' ' : null}
          {hint}
        </>
      }
    >
      <input type="password" value={value} onChange={(e) => onChange(e.target.value)} required={required && !saved} placeholder={saved ? 'Leave blank to keep' : placeholder} autoComplete="off" spellCheck={false} />
    </Field>
  );
}

export function ProviderBadge({ simulated }: { simulated: boolean }) {
  if (!simulated) return null;
  return (
    <span className="badge badge-sim" title="Built-in simulator: works offline with made-up data and never contacts anyone">
      Simulated
    </span>
  );
}

// A destructive button that asks for a second click instead of a browser dialog.
export function ConfirmButton({
  onConfirm,
  confirmLabel = 'Click again to confirm',
  children,
  ...rest
}: Omit<Parameters<typeof Button>[0], 'onClick'> & { onConfirm: () => void; confirmLabel?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      {...rest}
      variant={armed ? 'danger' : (rest.variant ?? 'default')}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
    >
      <span aria-live="polite">{armed ? confirmLabel : children}</span>
    </Button>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Meter({ used, limit, label }: { used: number; limit: number; label: string }) {
  const ratio = limit ? Math.min(1, used / limit) : 0;
  return (
    <div className="meter" title={`${label}: ${used} of ${limit} today`}>
      <div className="meter-head">
        <span>{label}</span>
        <span className="num">
          {used}/{limit}
        </span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${ratio >= 1 ? 'full' : ''}`} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

// A labelled bar for background work (imports). Without a known total it stays empty.
export function ProgressBar({ done, total, label }: { done: number; total: number | null; label: string }) {
  const ratio = total ? Math.min(1, done / total) : 0;
  return (
    <div
      className="progress progress-bar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total ?? undefined}
      aria-valuenow={done}
      title={total ? `${done} of ${total}` : `${done}`}
    >
      <span style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: ReactNode }[] }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'tab active' : 'tab'} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <div className="note note-error" role="alert">
      {error}
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="pager">
      <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <span className="muted">
        Page {page} of {pages}
      </span>
      <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </div>
  );
}

// ---- Toasts -----------------------------------------------------------------

type Toast = { id: number; text: string; tone: 'ok' | 'error' };
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// Runs an async action with busy state, reporting failures as a toast.
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await fn();
        if (success) toast(success);
        return r;
      } catch (e) {
        toast((e as Error).message, 'error');
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}

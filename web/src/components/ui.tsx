import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  CircleDot,
  Inbox,
  Loader2,
  Lock,
  PenLine,
  RotateCcw,
  Search,
  ShieldAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { STATUS_DESCRIPTIONS, STATUS_LABELS, type TranslationStatus } from '../../../shared/domain';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ------------------------------------------------------------------------------- buttons
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent/90 font-medium',
  secondary: 'border border-line bg-raised text-fg hover:bg-hover hover:border-line-strong',
  ghost: 'text-muted hover:bg-hover hover:text-fg',
  danger: 'border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; icon?: LucideIcon; loading?: boolean }
>(function Button({ variant = 'secondary', size = 'md', icon: Icon, loading, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        'inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-9 px-3.5 text-[14px]',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={15} className="animate-spin" aria-hidden /> : Icon ? <Icon size={15} aria-hidden /> : null}
      {children}
    </button>
  );
});

export function IconButton({ icon: Icon, label, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx('inline-grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded text-muted transition-colors duration-fast hover:bg-hover hover:text-fg disabled:opacity-40', className)}
      {...rest}
    >
      <Icon size={16} aria-hidden />
    </button>
  );
}

// -------------------------------------------------------------------------------- fields
export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-muted">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[12px] text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12px] text-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cx('relative', className)}>
      <select className="input cursor-pointer appearance-none pr-8" {...rest}>
        {children}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-subtle" aria-hidden />
    </div>
  );
}

export function Checkbox({ checked, onChange, label, disabled, indeterminate }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; indeterminate?: boolean }) {
  return (
    <label className={cx('inline-flex cursor-pointer items-center gap-2 text-[14px]', disabled && 'cursor-not-allowed opacity-50')}>
      <input
        type="checkbox"
        className="h-4 w-4 cursor-pointer accent-[rgb(var(--accent))]"
        checked={checked}
        disabled={disabled}
        ref={(el) => {
          if (el) el.indeterminate = !!indeterminate;
        }}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function SearchInput({ value, onChange, placeholder, className, inputRef }: { value: string; onChange: (v: string) => void; placeholder: string; className?: string; inputRef?: React.Ref<HTMLInputElement> }) {
  return (
    <div className={cx('relative', className)}>
      <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" aria-hidden />
      <input ref={inputRef} type="search" aria-label={placeholder} className="input pl-8" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** Segmented control for small, mutually exclusive choices. */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; disabled?: boolean }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-9 rounded border border-line bg-bg p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cx(
            'cursor-pointer rounded-[4px] px-3 text-[13px] transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-40',
            value === o.value ? 'bg-raised text-fg shadow-[0_0_0_1px_rgb(var(--line-strong))]' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------------------- badges
const STATUS_STYLE: Record<TranslationStatus, { cls: string; icon: LucideIcon }> = {
  missing: { cls: 'text-subtle border-line', icon: CircleDashed },
  draft: { cls: 'text-muted border-line-strong', icon: PenLine },
  in_progress: { cls: 'text-warn border-warn/30 bg-warn/[0.06]', icon: RotateCcw },
  needs_review: { cls: 'text-review border-review/30 bg-review/[0.06]', icon: CircleDot },
  approved: { cls: 'text-ok border-ok/30 bg-ok/[0.06]', icon: Check },
};

export function StatusBadge({ status, compact }: { status: string; compact?: boolean }) {
  const s = (status in STATUS_STYLE ? status : 'missing') as TranslationStatus;
  const { cls, icon: Icon } = STATUS_STYLE[s];
  return (
    <span title={STATUS_DESCRIPTIONS[s]} className={cx('inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded border px-1.5 text-[12px] font-medium', cls)}>
      <Icon size={12} aria-hidden />
      {compact ? <span className="sr-only">{STATUS_LABELS[s]}</span> : STATUS_LABELS[s]}
    </span>
  );
}

export function LanguageBadge({ code, name, rtl }: { code: string; name?: string; rtl?: boolean }) {
  return (
    <span className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded border border-line bg-raised px-1.5 text-[12px]">
      <span className="font-mono text-[11px] text-accent">{code}</span>
      {name && <span className="text-muted">{name}</span>}
      {rtl && <span className="text-[10px] uppercase text-subtle">rtl</span>}
    </span>
  );
}

export function PlatformBadge({ name }: { name: string }) {
  return <span className="inline-flex h-[22px] items-center whitespace-nowrap rounded bg-hover px-1.5 text-[12px] text-muted">{name}</span>;
}

export function SegmentTag({ name, onRemove }: { name: string; onRemove?: () => void }) {
  return (
    <span className="inline-flex h-[22px] max-w-[180px] items-center gap-1 rounded-full border border-line px-2 text-[12px] text-muted">
      <span className="truncate">{name}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove segment ${name}`} className="-mr-1 grid h-4 w-4 cursor-pointer place-items-center rounded-full hover:bg-hover hover:text-fg">
          <X size={11} aria-hidden />
        </button>
      )}
    </span>
  );
}

export function Progress({ value, total, tone = 'accent', label }: { value: number; total: number; tone?: 'accent' | 'ok' | 'review'; label?: string }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  const color = tone === 'ok' ? 'bg-ok' : tone === 'review' ? 'bg-review' : 'bg-accent';
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={label} className="h-1.5 w-full overflow-hidden rounded-full bg-hover">
      <div className={cx('h-full rounded-full transition-[width] duration-base', color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export const pct = (v: number, t: number) => (t > 0 ? `${Math.round((v / t) * 100)}%` : '—');

// ----------------------------------------------------------------------------- states
export function EmptyState({ icon: Icon = Inbox, title, children, action }: { icon?: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="grid h-10 w-10 place-items-center rounded-lg border border-line bg-raised text-subtle">
        <Icon size={18} aria-hidden />
      </div>
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-md text-[13px] text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const status = (error as any)?.status;
  if (status === 403) return <PermissionDenied message={(error as any)?.message} />;
  return (
    <EmptyState icon={AlertTriangle} title="Something went wrong" action={retry && <Button onClick={retry}>Try again</Button>}>
      {(error as any)?.message ?? 'The request failed.'}
    </EmptyState>
  );
}

export function PermissionDenied({ message }: { message?: string }) {
  return (
    <EmptyState icon={ShieldAlert} title="You don't have access to this">
      {message ?? 'Your account does not include the permission needed for this page. Ask an administrator if you need it.'}
    </EmptyState>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden />;
}

export function ReadOnlyNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-[12px] text-subtle">
      <Lock size={12} aria-hidden /> {children}
    </p>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  return (
    <nav aria-label="Pagination" className="flex items-center gap-2 text-[13px] text-muted">
      <span className="tabular-nums">
        {from.toLocaleString()}–{Math.min(total, page * pageSize).toLocaleString()} of {total.toLocaleString()}
      </span>
      <IconButton icon={ChevronLeft} label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)} />
      <span className="tabular-nums">
        {page}/{pages}
      </span>
      <IconButton icon={ChevronRight} label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)} />
    </nav>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 pb-5">
      <div className="min-w-0">
        <h1 className="text-[20px] font-semibold tracking-[-0.01em]">{title}</h1>
        {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

// ------------------------------------------------------------------------------ dialogs
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-fade fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          className={cx(
            'anim-fade fixed left-1/2 top-[8vh] z-50 flex max-h-[84vh] w-[calc(100vw-32px)] -translate-x-1/2 flex-col rounded-lg border border-line bg-surface shadow-pop',
            wide ? 'max-w-3xl' : 'max-w-lg',
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <Dialog.Title className="text-[16px] font-semibold">{title}</Dialog.Title>
              {description ? <Dialog.Description className="mt-0.5 text-[13px] text-muted">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{title}</Dialog.Description>}
            </div>
            <Dialog.Close asChild>
              <IconButton icon={X} label="Close" />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}
const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

interface PromptOptions {
  title: string;
  label: string;
  placeholder?: string;
  confirmLabel?: string;
}
/** In-app replacement for window.prompt (which embedded browsers may block). Resolves to the trimmed text, or null when cancelled. */
const PromptCtx = createContext<(o: PromptOptions) => Promise<string | null>>(async () => null);
export const usePrompt = () => useContext(PromptCtx);

function PromptDialog({ state, onClose }: { state: (PromptOptions & { resolve: (v: string | null) => void }) | null; onClose: (v: string | null) => void }) {
  const [text, setText] = useState('');
  useEffect(() => setText(''), [state]);
  const submit = () => text.trim() && onClose(text.trim());
  return (
    <Modal
      open={!!state}
      onOpenChange={(o) => !o && onClose(null)}
      title={state?.title ?? ''}
      footer={
        <>
          <Button onClick={() => onClose(null)}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!text.trim()}>
            {state?.confirmLabel ?? 'Send'}
          </Button>
        </>
      }
    >
      <Field label={state?.label ?? ''} htmlFor="prompt-text" hint="Ctrl+Enter to send">
        <textarea
          id="prompt-text"
          autoFocus
          className="input h-auto min-h-[96px] py-2"
          placeholder={state?.placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
      </Field>
    </Modal>
  );
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const [promptState, setPromptState] = useState<(PromptOptions & { resolve: (v: string | null) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const prompt = useCallback((o: PromptOptions) => new Promise<string | null>((resolve) => setPromptState({ ...o, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const closePrompt = (v: string | null) => {
    promptState?.resolve(v);
    setPromptState(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
     <PromptCtx.Provider value={prompt}>
      {children}
      <PromptDialog state={promptState} onClose={closePrompt} />
      <Modal
        open={!!state}
        onOpenChange={(o) => !o && close(false)}
        title={state?.title ?? ''}
        footer={
          <>
            <Button onClick={() => close(false)}>Cancel</Button>
            <Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
              {state?.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        <div className="text-[14px] text-muted">{state?.body}</div>
      </Modal>
     </PromptCtx.Provider>
    </ConfirmCtx.Provider>
  );
}

// ------------------------------------------------------------------------------- toasts
interface Toast {
  id: number;
  tone: 'ok' | 'error' | 'info';
  message: string;
}
const ToastCtx = createContext<(tone: Toast['tone'], message: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((tone: Toast['tone'], message: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={cx(
              'anim-slide pointer-events-auto flex items-start gap-2 rounded-lg border bg-raised px-3.5 py-2.5 text-[13px] shadow-pop',
              t.tone === 'error' ? 'border-danger/40' : t.tone === 'ok' ? 'border-ok/30' : 'border-line',
            )}
          >
            {t.tone === 'error' ? <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" aria-hidden /> : <Check size={15} className="mt-0.5 shrink-0 text-ok" aria-hidden />}
            <span className="flex-1">{t.message}</span>
            <button className="cursor-pointer text-subtle hover:text-fg" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <X size={14} aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------------- multi-select
export interface Option {
  value: number;
  label: string;
  hint?: string;
  group?: string;
}

/** Searchable multi-select with removable tags, optional "create" action. */
export function MultiSelect({
  options,
  value,
  onChange,
  placeholder,
  label,
  onCreate,
  disabled,
  renderTag,
}: {
  options: Option[];
  value: number[];
  onChange: (v: number[]) => void;
  placeholder: string;
  label: string;
  onCreate?: (name: string) => void;
  disabled?: boolean;
  renderTag?: (o: Option, remove: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const selected = options.filter((o) => value.includes(o.value));
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return options.filter((o) => !s || o.label.toLowerCase().includes(s) || o.hint?.toLowerCase().includes(s)).slice(0, 200);
  }, [options, q]);
  const groups = [...new Set(filtered.map((o) => o.group ?? ''))];
  const toggle = (v: number) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  const exact = options.some((o) => o.label.toLowerCase() === q.trim().toLowerCase());
  return (
    <div className="flex flex-col gap-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((o) => (renderTag ? <span key={o.value}>{renderTag(o, () => toggle(o.value))}</span> : <SegmentTag key={o.value} name={o.label} onRemove={disabled ? undefined : () => toggle(o.value)} />))}
        </div>
      )}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild disabled={disabled}>
          <button type="button" aria-label={label} className="input flex cursor-pointer items-center justify-between text-left text-subtle disabled:cursor-not-allowed disabled:opacity-60">
            <span className="truncate">{selected.length ? `${selected.length} selected` : placeholder}</span>
            <ChevronDown size={14} aria-hidden />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={4} className="anim-fade z-[70] w-[var(--radix-popover-trigger-width)] min-w-[240px] rounded-lg border border-line bg-raised p-1.5 shadow-pop">
            <input
              autoFocus
              className="input mb-1.5 h-8"
              placeholder="Search…"
              aria-label={`Search ${label}`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && onCreate && q.trim() && !exact) {
                  onCreate(q.trim());
                  setQ('');
                }
              }}
            />
            <div role="listbox" aria-multiselectable className="max-h-64 overflow-y-auto">
              {groups.map((g) => (
                <div key={g}>
                  {g && <div className="label px-2 pb-1 pt-2">{g}</div>}
                  {filtered
                    .filter((o) => (o.group ?? '') === g)
                    .map((o) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={value.includes(o.value)}
                        key={o.value}
                        onClick={() => toggle(o.value)}
                        className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-hover"
                      >
                        <span className={cx('grid h-4 w-4 place-items-center rounded border', value.includes(o.value) ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong')}>
                          {value.includes(o.value) && <Check size={11} aria-hidden />}
                        </span>
                        <span className="flex-1 truncate">{o.label}</span>
                        {o.hint && <span className="text-[12px] text-subtle">{o.hint}</span>}
                      </button>
                    ))}
                </div>
              ))}
              {!filtered.length && !onCreate && <p className="px-2 py-3 text-[13px] text-subtle">No matches</p>}
              {onCreate && q.trim() && !exact && (
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-accent hover:bg-hover"
                  onClick={() => {
                    onCreate(q.trim());
                    setQ('');
                  }}
                >
                  Create “{q.trim()}”
                </button>
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function errorMessage(e: unknown): string {
  return (e as any)?.message ?? 'Request failed';
}

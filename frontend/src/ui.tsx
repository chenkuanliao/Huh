import {
  createContext,
  ReactNode,
  RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { isPhoneLayout, useSheetGestures } from './sheet';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, CircleAlert, CircleCheck, Info, Loader2, Search, X } from 'lucide-react';

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

/* ------------------------------------------------------------------ Popover */

type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

export function Popover({
  anchor,
  open,
  onClose,
  children,
  placement = 'bottom-start',
  matchWidth = false,
  minWidth = 220,
  maxWidth = 420,
  className,
  label,
  role = 'dialog',
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  placement?: Placement;
  matchWidth?: boolean;
  minWidth?: number;
  maxWidth?: number;
  className?: string;
  label?: string;
  role?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const close = useRef(onClose);
  close.current = onClose;
  // Phone layout: popovers are bottom sheets over a scrim that swallows the tap that closes them.
  const sheet = open && isPhoneLayout();
  useSheetGestures(ref, sheet, onClose);

  const position = useCallback(() => {
    const a = anchor.current;
    const p = ref.current;
    if (!a || !p) return;
    const rect = a.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 6;
    const margin = 12;
    const width = Math.min(Math.max(matchWidth ? rect.width : 0, minWidth), vw - margin * 2);
    const panelHeight = p.scrollHeight;
    const below = vh - rect.bottom - gap - margin;
    const above = rect.top - gap - margin;
    const wantTop = placement.startsWith('top');
    const top = wantTop ? !(above < Math.min(panelHeight, 260) && below > above) : below < Math.min(panelHeight, 260) && above > below;
    const maxHeight = Math.max(160, top ? above : below);
    const s: React.CSSProperties = {
      position: 'fixed',
      minWidth: width,
      maxWidth: Math.min(maxWidth, vw - margin * 2),
      maxHeight,
      visibility: 'visible',
    };
    if (matchWidth) s.width = Math.max(rect.width, minWidth);
    if (top) s.bottom = vh - rect.top + gap;
    else s.top = rect.bottom + gap;
    const panelWidth = Math.max(matchWidth ? rect.width : 0, Math.min(p.offsetWidth || minWidth, maxWidth));
    if (placement.endsWith('end')) {
      s.left = Math.max(margin, Math.min(rect.right - panelWidth, vw - panelWidth - margin));
    } else {
      s.left = Math.max(margin, Math.min(rect.left, vw - panelWidth - margin));
    }
    setStyle(s);
  }, [anchor, placement, matchWidth, minWidth, maxWidth]);

  useLayoutEffect(() => {
    if (!open) return;
    position();
    const raf = requestAnimationFrame(position);
    return () => cancelAnimationFrame(raf);
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      // On a phone each sheet has its own scrim; a tap on a nested sheet's scrim closes only that sheet.
      if (t instanceof Element && t.classList.contains('sheet-scrim') && t.nextElementSibling !== ref.current) return;
      // Clicks inside a nested popover (e.g. a dropdown opened from this panel) are not "outside".
      const other = t instanceof Element ? t.closest('.popover') : null;
      if (other && ref.current && other.compareDocumentPosition(ref.current) & Node.DOCUMENT_POSITION_PRECEDING) return;
      close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      // Only the innermost (last opened) popover reacts to Escape.
      const all = document.querySelectorAll('.popover');
      if (e.key === 'Escape' && all[all.length - 1] === ref.current) {
        e.stopPropagation();
        close.current();
        anchor.current?.focus();
      }
    };
    const onMove = () => position();
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, anchor, position]);

  if (!open) return null;
  return createPortal(
    <>
      {sheet && <div className="sheet-scrim" aria-hidden onClick={e => e.preventDefault()} />}
      <div ref={ref} className={cx('popover', className)} style={style} role={role} aria-label={label}>
        {sheet && <div className="sheet-grip" aria-hidden />}
        {children}
      </div>
    </>,
    document.body,
  );
}

/* ------------------------------------------------------------------- Select */

export type Option<V extends string = string> = {
  value: V;
  label: string;
  description?: ReactNode;
  icon?: ReactNode;
  group?: string;
  disabled?: boolean;
  badge?: ReactNode;
  keywords?: string;
};

export function Select<V extends string = string>({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = 'Select…',
  searchable,
  searchPlaceholder = 'Search…',
  allowCustom,
  customLabel = q => `Use “${q}”`,
  disabled,
  loading,
  emptyText = 'No options',
  className,
  size = 'md',
  footer,
  renderValue,
  placement = 'bottom-start',
  minWidth = 220,
  id,
}: {
  value: V | '' | null | undefined;
  options: Option<V>[];
  onChange: (value: V) => void;
  ariaLabel: string;
  placeholder?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  allowCustom?: boolean;
  customLabel?: (query: string) => string;
  disabled?: boolean;
  loading?: boolean;
  emptyText?: ReactNode;
  className?: string;
  size?: 'sm' | 'md';
  footer?: ReactNode;
  renderValue?: (option: Option<V> | undefined) => ReactNode;
  placement?: Placement;
  minWidth?: number;
  id?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const selected = options.find(o => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? options.filter(o => (o.label + ' ' + o.value + ' ' + (o.keywords || '')).toLowerCase().includes(q))
      : options;
    const items: (Option<V> & { custom?: boolean })[] = [...base];
    if (allowCustom && q && !options.some(o => o.value.toLowerCase() === q)) {
      items.push({ value: query.trim() as V, label: customLabel(query.trim()), custom: true });
    }
    return items;
  }, [options, query, allowCustom, customLabel]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const index = Math.max(0, options.findIndex(o => o.value === value));
    setActive(index);
    requestAnimationFrame(() => {
      if (searchable) searchRef.current?.focus();
      else list.current?.focus();
      list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function choose(o: Option<V>) {
    if (o.disabled) return;
    onChange(o.value);
    setOpen(false);
    trigger.current?.focus();
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(i => {
        for (let n = i + 1; n < filtered.length; n++) if (!filtered[n].disabled) return n;
        return i;
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(i => {
        for (let n = i - 1; n >= 0; n--) if (!filtered[n].disabled) return n;
        return i;
      });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = filtered[active];
      if (o) choose(o);
    } else if (e.key === 'Tab') {
      setOpen(false);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(filtered.length - 1);
    }
  }

  let lastGroup: string | undefined;
  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        className={cx('select-trigger', size === 'sm' && 'sm', className)}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="select-value">
          {renderValue ? (
            renderValue(selected)
          ) : selected ? (
            <>
              {selected.icon && <span className="select-icon">{selected.icon}</span>}
              <span className="truncate">{selected.label}</span>
            </>
          ) : value ? (
            <span className="truncate">{value}</span>
          ) : (
            <span className="placeholder truncate">{placeholder}</span>
          )}
        </span>
        {loading ? <Loader2 size={15} className="spin muted-icon" /> : <ChevronDown size={15} className="muted-icon chevron" />}
      </button>
      <Popover
        anchor={trigger}
        open={open}
        onClose={() => setOpen(false)}
        matchWidth
        minWidth={minWidth}
        placement={placement}
        className="select-popover"
        role="presentation"
      >
        {searchable && (
          <div className="select-search">
            <Search size={15} />
            <input
              ref={searchRef}
              value={query}
              placeholder={searchPlaceholder}
              aria-label={`Search ${ariaLabel}`}
              onChange={e => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKey}
            />
          </div>
        )}
        <div
          ref={list}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          className="select-list"
          onKeyDown={searchable ? undefined : onKey}
          aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
        >
          {loading && !filtered.length && (
            <div className="select-empty">
              <Loader2 size={15} className="spin" /> Loading…
            </div>
          )}
          {!loading && !filtered.length && <div className="select-empty">{emptyText}</div>}
          {filtered.map((o, i) => {
            const header = o.group && o.group !== lastGroup ? o.group : null;
            lastGroup = o.group;
            return (
              <div key={(o as any).custom ? '__custom' : o.value}>
                {header && <div className="select-group">{header}</div>}
                <div
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={o.value === value && !(o as any).custom}
                  aria-disabled={o.disabled || undefined}
                  className={cx('select-option', i === active && 'active', o.disabled && 'disabled')}
                  onPointerMove={() => !o.disabled && setActive(i)}
                  onClick={() => choose(o)}
                >
                  {o.icon && <span className="select-icon">{o.icon}</span>}
                  <span className="option-text">
                    <span className="option-label">{o.label}</span>
                    {o.description && <span className="option-description">{o.description}</span>}
                  </span>
                  {o.badge}
                  <Check size={15} className="option-check" />
                </div>
              </div>
            );
          })}
        </div>
        {footer && <div className="select-footer">{footer}</div>}
      </Popover>
    </>
  );
}

/* --------------------------------------------------------------------- Menu */

export type MenuItem = { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string } | 'divider';

function MenuPanel({ items, label, header, onClose }: { items: MenuItem[]; label: string; header?: ReactNode; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus());
  }, []);
  function onKey(e: React.KeyboardEvent) {
    const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      buttons[(index + 1) % buttons.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
    } else if (e.key === 'Tab') onClose();
  }
  return (
    <div ref={panel} role="menu" aria-label={label} className="menu" onKeyDown={onKey}>
      {header}
      {items.map((item, i) =>
        item === 'divider' ? (
          <div key={i} className="menu-divider" role="separator" />
        ) : (
          <button
            key={item.label}
            role="menuitem"
            type="button"
            disabled={item.disabled}
            className={cx('menu-item', item.danger && 'danger')}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.icon}
            <span className="option-text">
              <span>{item.label}</span>
              {item.hint && <span className="option-description">{item.hint}</span>}
            </span>
          </button>
        ),
      )}
    </div>
  );
}

export function Menu({
  trigger,
  items,
  label,
  placement = 'bottom-end',
  header,
}: {
  trigger: (props: { ref: RefObject<HTMLButtonElement | null>; onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode;
  items: MenuItem[];
  label: string;
  placement?: Placement;
  header?: ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      {trigger({ ref, onClick: () => setOpen(o => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement={placement} minWidth={210} role="presentation">
        <MenuPanel items={items} label={label} header={header} onClose={() => setOpen(false)} />
      </Popover>
    </>
  );
}

/** A menu opened at the pointer, e.g. on right-click. `at` is in viewport coordinates. */
export function ContextMenu({ at, onClose, items, label, header }: { at: { x: number; y: number } | null; onClose: () => void; items: MenuItem[]; label: string; header?: ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null);
  if (!at) return null;
  return (
    <>
      {createPortal(<span ref={anchor} aria-hidden style={{ position: 'fixed', left: at.x, top: at.y, width: 1, height: 1, pointerEvents: 'none' }} />, document.body)}
      <Popover anchor={anchor} open onClose={onClose} placement="bottom-start" minWidth={220} role="presentation">
        <MenuPanel items={items} label={label} header={header} onClose={onClose} />
      </Popover>
    </>
  );
}

/** Focused yes/no dialog for consequential actions. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  icon,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
  icon?: ReactNode;
  busy?: boolean;
}) {
  const titleId = useId();
  const descId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    // Safer default focus for destructive actions.
    requestAnimationFrame(() => (tone === 'danger' ? cancelRef : confirmRef).current?.focus());
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && close.current();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open, tone, busy]);
  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop confirm-backdrop" onPointerDown={e => e.target === e.currentTarget && !busy && onClose()}>
      <div className={cx('confirm', tone === 'danger' && 'confirm-danger')} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descId : undefined}>
        {icon && <div className="confirm-icon">{icon}</div>}
        <h2 id={titleId}>{title}</h2>
        {description && (
          <p id={descId} className="confirm-text">
            {description}
          </p>
        )}
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="ghost-bordered" disabled={busy} onClick={onClose}>
            {cancelLabel}
          </button>
          <button ref={confirmRef} type="button" className={tone === 'danger' ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>
            {busy && <Loader2 size={15} className="spin" />} {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------- Switch */

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={cx('switch-row', disabled && 'disabled')}>
      <span className="switch-text">
        <label htmlFor={id} className="switch-label">
          {label}
        </label>
        {description && <span className="hint">{description}</span>}
      </span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={cx('switch', checked && 'on')}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" />
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------- Segmented */

export function Segmented<V extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  size = 'md',
  disabled,
}: {
  value: V;
  options: { value: V; label: ReactNode; icon?: ReactNode; title?: string }[];
  onChange: (value: V) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
}) {
  return (
    <div className={cx('segmented', size === 'sm' && 'sm')} role="radiogroup" aria-label={ariaLabel}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          disabled={disabled}
          className={cx(o.value === value && 'on')}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------- Modal */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  const sheet = open && isPhoneLayout();
  useSheetGestures(ref, sheet, onClose);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => {
      const target = ref.current?.querySelector<HTMLElement>('[data-autofocus], input, textarea, button:not(.modal-close)');
      target?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.popover')) close.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={cx('modal', size)} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        {sheet && <div className="sheet-grip" aria-hidden />}
        <header className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p className="muted">{description}</p>}
          </div>
          <button type="button" className="icon-button modal-close" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {children && <div className="modal-body">{children}</div>}
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------- Toasts */

type Toast = { id: number; message: ReactNode; kind: 'info' | 'success' | 'error' };
const ToastContext = createContext<(message: ReactNode, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts(t => t.filter(x => x.id !== id)), []);
  const push = useCallback(
    (message: ReactNode, kind: Toast['kind'] = 'info') => {
      const id = next.current++;
      setToasts(t => [...t.slice(-3), { id, message, kind }]);
      setTimeout(() => dismiss(id), kind === 'error' ? 9000 : 4500);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      {createPortal(
        <div className="toasts">
          {toasts.map(t => (
            <div key={t.id} className={cx('toast', t.kind)} role={t.kind === 'error' ? 'alert' : 'status'}>
              {t.kind === 'error' ? <CircleAlert size={17} /> : t.kind === 'success' ? <CircleCheck size={17} /> : <Info size={17} />}
              <span>{t.message}</span>
              <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                <X size={15} />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

/* ------------------------------------------------------------------- Bits */

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="spin" aria-hidden />;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'accent' | 'live' }) {
  return <span className={cx('badge', tone)}>{children}</span>;
}

export function Field({ label, hint, children, htmlFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function Callout({ tone = 'info', icon, children }: { tone?: 'info' | 'warn' | 'bad' | 'good'; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className={cx('callout', tone)}>
      {icon ?? (tone === 'bad' || tone === 'warn' ? <CircleAlert size={17} /> : tone === 'good' ? <CircleCheck size={17} /> : <Info size={17} />)}
      <div>{children}</div>
    </div>
  );
}

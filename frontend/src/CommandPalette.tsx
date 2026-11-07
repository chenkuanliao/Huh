import { Fragment, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, CornerDownLeft, Search } from 'lucide-react';
import { ACTION_PREFIX, CommandKind, Matchable, parseQuery, rank } from './commands';
import { cx } from './ui';

export type Command = Matchable & {
  icon: ReactNode;
  /** Quiet second line: a folder and date, a section hint, what an action does. */
  subtitle?: string;
  /** Keyboard shortcut that does the same thing, shown on the right. */
  shortcut?: string;
  danger?: boolean;
  run: () => void;
};

export type CommandSection = { label: string; items: Command[] };

const SECTION: Record<CommandKind, string> = { action: 'Actions', folder: 'Folders', meeting: 'Meetings', setting: 'Settings' };
const KIND: Record<CommandKind, string> = { action: 'Action', folder: 'Folder', meeting: 'Meeting', setting: 'Settings' };
/** Enough to find what you mean without a wall of meetings. */
const MAX_PER_SECTION: Record<CommandKind, number> = { action: 8, folder: 8, meeting: 8, setting: 6 };

/** Marks the parts of the title the query's words matched. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const tokens = parseQuery(query)
    .text.toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 0);
  if (!tokens.length) return <>{text}</>;
  const lower = text.toLowerCase();
  const marks: boolean[] = new Array(text.length).fill(false);
  for (const t of tokens) for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + t.length)) marks.fill(true, i, i + t.length);
  const parts: ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && marks[j] === marks[i]) j++;
    parts.push(marks[i] ? <mark key={i}>{text.slice(i, j)}</mark> : text.slice(i, j));
    i = j;
  }
  return <>{parts}</>;
}

/**
 * One box to go anywhere or do anything: meetings and folders by name, Settings pages, and actions
 * (new meeting, import, archive this meeting…). Opens with Ctrl/⌘ + K from anywhere in the app.
 */
export default function CommandPalette({
  open,
  onClose,
  commands,
  suggestions,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  /** What to show before anything is typed. */
  suggestions: CommandSection[];
}) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  const { text, only } = parseQuery(query);
  const sections = useMemo<CommandSection[]>(() => {
    if (!text && !only) return suggestions.filter(s => s.items.length);
    if (!text && only) return [{ label: SECTION[only], items: commands.filter(c => c.kind === only) }];
    // Sections appear in the order of their best match, so what you meant is at the top.
    const out: (CommandSection & { kind: CommandKind | 'archive' })[] = [];
    for (const { item } of rank(commands, query)) {
      const kind = item.archived ? 'archive' : item.kind;
      let s = out.find(x => x.kind === kind);
      if (!s) out.push((s = { kind, label: kind === 'archive' ? 'From the archive' : SECTION[kind], items: [] }));
      if (s.items.length < MAX_PER_SECTION[item.kind]) s.items.push(item);
    }
    return out;
  }, [commands, suggestions, query, text, only]);
  const flat = useMemo(() => sections.flatMap(s => s.items), [sections]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;
  const choose = (c: Command) => {
    onClose();
    // After the palette is gone, so dialogs an action opens get focus.
    // (setTimeout, not requestAnimationFrame: rAF never fires in a background tab.)
    window.setTimeout(() => c.run());
  };

  let n = 0;
  return createPortal(
    <div className="modal-backdrop palette-backdrop" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search and actions">
        <div className="palette-input">
          <Search size={18} className="muted-icon" />
          <input
            ref={input}
            aria-label="Search meetings, folders, settings and actions"
            placeholder="Go to a meeting or folder, or type an action…"
            value={query}
            role="combobox"
            aria-expanded
            aria-controls="palette-results"
            aria-activedescendant={flat[active] ? `palette-item-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
                e.preventDefault();
                setActive(a => (flat.length ? (a + 1) % flat.length : 0));
              } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
                e.preventDefault();
                setActive(a => (flat.length ? (a - 1 + flat.length) % flat.length : 0));
              } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && flat[active]) {
                e.preventDefault();
                choose(flat[active]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-results" ref={list} id="palette-results" role="listbox" aria-label="Results">
          {!flat.length ? (
            <p className="palette-empty">
              Nothing called “{text}”.
              <span className="hint">Search inside notes and transcripts isn’t here yet. Inside a meeting, Ctrl/⌘ F finds within the open tab.</span>
            </p>
          ) : (
            sections.map(s => (
              <Fragment key={s.label}>
                <div className={cx('palette-section', s.label === 'From the archive' && 'archived')} role="presentation">
                  {s.label === 'From the archive' && <Archive size={12} />}
                  {s.label}
                </div>
                {s.items.map(c => {
                  const i = n++;
                  return (
                    <div
                      key={c.id}
                      id={`palette-item-${i}`}
                      data-index={i}
                      role="option"
                      aria-selected={i === active}
                      className={cx('palette-cmd', i === active && 'active', c.danger && 'destructive', c.archived && 'archived')}
                      onPointerMove={() => i !== active && setActive(i)}
                      onClick={() => choose(c)}
                    >
                      <span className="palette-icon">{c.icon}</span>
                      <span className="palette-text">
                        <span className="palette-title truncate">
                          <Highlighted text={c.title} query={query} />
                        </span>
                        {c.subtitle && <span className="palette-sub truncate">{c.subtitle}</span>}
                      </span>
                      {c.shortcut ? <kbd className="palette-shortcut">{c.shortcut}</kbd> : text && <span className="palette-kind">{KIND[c.kind]}</span>}
                      {i === active && <CornerDownLeft size={14} className="palette-enter" aria-hidden />}
                    </div>
                  );
                })}
              </Fragment>
            ))
          )}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>Enter</kbd> to open or run
          </span>
          <span>
            Start with <kbd>{ACTION_PREFIX}</kbd> for actions only
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

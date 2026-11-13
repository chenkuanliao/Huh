import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, AudioLines, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Clock, Ellipsis, FileAudio, FileText, FolderPlus, ListTodo, Mic, Pause, Plus, Sparkles, CalendarDays, Undo2, X } from 'lucide-react';
import { api, ApiError, errorText, Folder, Job, Meeting, send, Settings as SettingsT } from './api';
import { stripSources, toggleTask } from './Markdown';
import { Callout, cx, Menu, MenuItem, Segmented, Spinner, useToast } from './ui';
import { dayNumber, daysAgo, fmt, fromWall, meetingDate, timeRange, useZone, wall } from './time';
import { FolderGlyph, FolderTile, folderVars } from './folders';
import { filterTodos, groupTodos, TodoFilterChips, TodoGroup, TodoViewMenu, useTodoView } from './todoView';

export type MeetingStats = { recorded_seconds: number; recordings: number; segments: number; generations: number };
type DashJob = Job & { meeting_id: string; meeting_title: string | null };
export type DashData = { meetings: Record<string, MeetingStats>; jobs: DashJob[] };
type Field = 'notes' | 'enhanced_notes';
type Todo = { meeting: Meeting; field: Field; line: number; raw: string; text: string; key: string };

/** A tick that can still be taken back with Undo or Ctrl/⌘ + Z. */
type Done = { id: number; todo: Todo; saved: Promise<void>; undone: boolean; anim?: Animation };

const UNDO_MS = 10_000;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Where Ctrl/⌘ + Z belongs to something else: text fields, editors, and open dialogs. */
function undoBelongsElsewhere(target: EventTarget | null) {
  const el = target instanceof HTMLElement ? target : null;
  if (el?.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(el.type)) return true;
  return !!document.querySelector('[role="dialog"], [aria-modal="true"]') || document.body.classList.contains('focus-active');
}


const OPEN_TASK = /^(?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+(.+)$/;

function startOfWeek(d: Date) {
  const w = wall(d);
  const day = (w.weekday + 6) % 7; // Monday first
  return fromWall({ y: w.y, mo: w.mo, d: w.d - day, h: 0, mi: 0 }).getTime();
}

export function duration(seconds: number) {
  if (seconds < 60) return seconds > 0 ? '<1m' : '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function plain(markdown: string) {
  return stripSources(markdown)
    .split('\n')
    .filter(l => l.trim() && !/^\s*#/.test(l) && !/^\s*\|/.test(l) && !/^\s*[-*+]\s*(\[[ xX]\])?\s*$/.test(l))
    .map(l =>
      l
        .replace(/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~]/g, '')
        .trim(),
    )
    .filter(Boolean)
    .join(' · ');
}

export function collectTodos(meetings: Meeting[]) {
  const out: Todo[] = [];
  for (const m of meetings) {
    // One source per meeting: AI notes when they exist (they already fold in your notes), otherwise My notes.
    const field = (m.enhanced_notes || '').trim() ? 'enhanced_notes' : 'notes';
    (m[field] || '').split('\n').forEach((l, i) => {
      const match = l.match(OPEN_TASK);
      if (match) out.push({ meeting: m, field, line: i + 1, raw: l, text: stripSources(match[1]).replace(/[*_`]/g, '').trim(), key: `${m.id}:${field}:${i}` });
    });
  }
  return out;
}

/** Recording and AI stats per meeting, plus queued/failed jobs; refreshed every few seconds. */
export function useDashData() {
  const [data, setData] = useState<DashData | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api<DashData>('/dashboard'));
    } catch {}
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);
  return data;
}

/** "Today", "Yesterday", "3 days ago", "Tomorrow", "Nov 14", counted in the chosen time zone. */
export function relativeDay(iso: string) {
  const days = daysAgo(iso);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days === -1) return 'Tomorrow';
  if (days > 1 && days < 7) return `${days} days ago`;
  return fmt(iso, { month: 'short', day: 'numeric', ...(wall(iso).y !== wall(Date.now()).y ? { year: 'numeric' } : {}) });
}

function shortWhen(iso: string) {
  const day = relativeDay(iso);
  const time = fmt(iso, { hour: 'numeric', minute: '2-digit' });
  return day === 'Today' || day === 'Yesterday' || day === 'Tomorrow' ? `${day}, ${time}` : day.endsWith('ago') ? fmt(iso, { weekday: 'short' }) + `, ${time}` : day;
}

/** Drag-and-drop wiring from the app shell, so meetings move between Home, folder pages and the sidebar. */
export type MeetingDnd = {
  /** Props that make an element drag this meeting. */
  source: (m: Meeting) => React.HTMLAttributes<HTMLElement> & { draggable: true };
  /** Props that make an element accept a dropped meeting: a folder id, or the main list / archive. */
  zone: (target: string) => React.HTMLAttributes<HTMLElement>;
  /** The drop zone the pointer is over right now. */
  over: string | null;
};

/** One meeting as a compact row: title and a one-line preview, details on the right. */
export function MeetingRow({
  meeting: m,
  stats: s,
  folder,
  hideFolder,
  onOpen,
  onMenu,
  drag,
}: {
  meeting: Meeting;
  stats?: MeetingStats;
  folder?: Folder;
  /** Tint by the folder but leave out its label (e.g. inside that folder's page). */
  hideFolder?: boolean;
  onOpen: (id: string) => void;
  /** Opens the meeting's actions menu at a point (the ⋯ button, or right-click). */
  onMenu?: (m: Meeting, x: number, y: number) => void;
  /** Lets the row be dragged into a folder. */
  drag?: MeetingDnd;
}) {
  const snippet = plain(m.notes) || plain(m.enhanced_notes);
  const recording = m.status === 'recording';
  const Icon = s?.recorded_seconds || recording ? Mic : FileText;
  return (
    <li
      className={cx('mrow-item', onMenu && 'has-menu')}
      onContextMenu={
        onMenu &&
        (e => {
          e.preventDefault();
          onMenu(m, e.clientX, e.clientY);
        })
      }
    >
      <button type="button" className="mrow" data-meeting={m.id} {...drag?.source(m)} onClick={() => onOpen(m.id)} style={folder ? folderVars(folder) : undefined}>
        <span className={cx('mrow-icon', folder && 'tinted')} aria-hidden>
          {recording ? <span className="rec-dot small-dot" /> : <Icon size={15} />}
        </span>
        <span className="mrow-main">
          <span className="mrow-top">
            <strong className="truncate">{m.title || 'Untitled meeting'}</strong>
            {folder && !hideFolder && (
              <span className="recent-folder">
                <FolderGlyph folder={folder} size={12} />
                <span className="truncate">{folder.name}</span>
              </span>
            )}
            {s?.recorded_seconds ? (
              <span className="mrow-stat" title="Recorded">
                <AudioLines size={12} /> {duration(s.recorded_seconds)}
              </span>
            ) : null}
            {hasAINotes(m) ? (
              <span className="mrow-stat ai" title="Has AI notes">
                <Sparkles size={12} /> AI
              </span>
            ) : null}
          </span>
          <span className={cx('mrow-snippet truncate', !snippet && 'empty')}>{snippet || 'No notes yet'}</span>
        </span>
        <span className="mrow-when" title={`Edited ${fmt(m.updated_at, { dateStyle: 'medium', timeStyle: 'short' })}`}>
          {recording ? 'Recording now' : shortWhen(m.updated_at)}
        </span>
      </button>
      {onMenu && (
        <button
          type="button"
          className="icon-button mrow-menu"
          aria-label={`Actions for ${m.title || 'Untitled meeting'}`}
          title="More actions"
          onClick={e => {
            const r = e.currentTarget.getBoundingClientRect();
            onMenu(m, r.right - 210, r.bottom + 4);
          }}
        >
          <Ellipsis size={17} />
        </button>
      )}
    </li>
  );
}

/** Open checkboxes from the given meetings. Tick to complete (with Undo), or click one to see it in its note. */
export function TodoPanel({
  meetings,
  folders,
  viewKey,
  groupBy,
  onReveal,
  reloadMeetings,
  description = 'From each meeting’s AI notes, or your own notes when it has none. Tick to complete, or click one to see it in its note.',
}: {
  meetings: Meeting[];
  /** Folders to group and filter by; leave out where every meeting is in one folder. */
  folders?: Folder[];
  /** Which saved grouping/filter this panel uses (kept per panel in this browser). */
  viewKey: string;
  groupBy?: TodoGroup[];
  /** Open a meeting's note at a source line and highlight it. */
  onReveal: (id: string, field: Field, line: number, lineText: string) => void;
  reloadMeetings: () => Promise<void>;
  description?: string;
}) {
  const toast = useToast();
  // Ticked to-dos stay on screen checked for a beat, then fade and collapse before the list refreshes.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [gone, setGone] = useState<Set<string>>(new Set());
  const rows = useRef(new Map<string, HTMLLIElement>());
  const latest = useRef(new Map<string, Meeting>());
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  // Most recent last. Each tick stays undoable for UNDO_MS; leaving Home drops them all.
  const [undos, setUndos] = useState<Done[]>([]);
  const undosRef = useRef(undos);
  undosRef.current = undos;
  const nextId = useRef(1);
  const returning = useRef(new Set<string>());
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const todos = useMemo(() => collectTodos(meetings), [meetings]);
  const [view, setView] = useTodoView(viewKey);
  const allowed = groupBy || (folders ? ['none', 'folder', 'meeting'] : ['none', 'meeting']);
  const group = allowed.includes(view.group) ? view.group : 'none';
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const t of todos) out.set(t.meeting.id, (out.get(t.meeting.id) || 0) + 1);
    return out;
  }, [todos]);
  const known = useMemo(
    () => ({
      folders: new Set([...(folders || []).map(f => f.id), ...(folders ? [''] : [])]),
      meetings: new Set(meetings.map(m => m.id)),
    }),
    [folders, meetings],
  );

  // Forget animation state for to-dos that have left the list (or come back after being unticked elsewhere).
  useEffect(() => {
    const keys = new Set(todos.map(t => t.key));
    const prune = (set: Set<string>) => ([...set].every(k => keys.has(k)) ? set : new Set([...set].filter(k => keys.has(k))));
    setChecked(prune);
    setGone(prune);
  }, [todos]);

  /** Save one tick. Ticks run one at a time, each on top of the newest copy of its meeting. */
  function save(t: Todo, undo = false) {
    // Ticking finds the open line; undoing finds the same line ticked.
    const from = undo ? toggleTask(t.raw, 1) : t.raw;
    const run = async () => {
      const cached = latest.current.get(t.meeting.id);
      const revision = t.field === 'notes' ? 'notes_revision' : 'enhanced_revision';
      const m = cached && cached[revision] >= t.meeting[revision] ? cached : t.meeting;
      const lines = m[t.field].split('\n');
      let line = t.line;
      if (lines[line - 1] !== from) line = lines.indexOf(from) + 1;
      if (!line) return; // Already done or edited elsewhere; the refresh will settle it.
      const updated = await send<Meeting>(`/meetings/${m.id}`, { [t.field]: toggleTask(m[t.field], line), [revision]: m[revision] }, 'PATCH');
      latest.current.set(m.id, updated);
    };
    const next = chain.current.then(run, run);
    chain.current = next.catch(() => {});
    return next;
  }

  function collapse(entry: Done) {
    const el = rows.current.get(entry.todo.key);
    if (!el) return Promise.resolve();
    const cs = getComputedStyle(el);
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const from = { height: `${el.offsetHeight}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, opacity: 1, transform: 'none' };
    const faded = { ...from, opacity: 0, transform: 'translateX(14px)', offset: 0.5 };
    const to = { height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0, transform: 'translateX(14px)' };
    el.style.overflow = 'hidden';
    const anim = (entry.anim = el.animate([from, faded, to], { duration: still ? 1 : 620, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' }));
    // Hidden tabs pause animations; never let that hold the list hostage.
    return Promise.race([anim.finished.then(() => {}, () => {}), new Promise<void>(r => setTimeout(r, 900))]);
  }

  const forget = (entry: Done) => setUndos(list => list.filter(x => x !== entry));

  async function tick(t: Todo) {
    if (checked.has(t.key)) return;
    setChecked(s => new Set(s).add(t.key));
    const beat = new Promise(r => setTimeout(r, 700));
    const saved = save(t);
    const entry: Done = { id: nextId.current++, todo: t, saved, undone: false };
    setUndos(list => [...list, entry]);
    setTimeout(() => forget(entry), UNDO_MS);
    try {
      await saved;
    } catch (e) {
      forget(entry);
      setChecked(s => {
        const next = new Set(s);
        next.delete(t.key);
        return next;
      });
      if (e instanceof ApiError && e.status === 409) toast('That note just changed on another device. The list has been refreshed.', 'error');
      else toast(errorText(e), 'error');
      await reloadMeetings().catch(() => {});
      return;
    }
    await beat;
    if (entry.undone) return;
    await collapse(entry);
    if (entry.undone) return;
    setGone(s => new Set(s).add(t.key));
    await reloadMeetings().catch(() => {});
  }

  /** Put a ticked to-do back: untick it in the note and bring the row back where it was. */
  async function undo(entry: Done) {
    if (entry.undone) return;
    entry.undone = true;
    forget(entry);
    const t = entry.todo;
    try {
      await entry.saved;
    } catch {
      return; // The tick never saved, and tick() has already put the row back.
    }
    try {
      await save(t, true);
    } catch (e) {
      toast(e instanceof ApiError && e.status === 409 ? 'That note just changed on another device, so the to-do couldn’t be restored.' : errorText(e), 'error');
      return;
    }
    entry.anim?.cancel();
    const el = rows.current.get(t.key);
    if (el) el.style.overflow = '';
    // Rows already gone from the list animate back in when they remount.
    if (!el || gone.has(t.key)) returning.current.add(t.key);
    const drop = (set: Set<string>) => {
      const next = new Set(set);
      next.delete(t.key);
      return next;
    };
    setChecked(drop);
    setGone(drop);
    await reloadMeetings().catch(() => {});
  }

  function rowRef(key: string, el: HTMLLIElement | null) {
    if (!el) return void rows.current.delete(key);
    rows.current.set(key, el);
    if (!returning.current.delete(key)) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cs = getComputedStyle(el);
    const end = { height: `${el.offsetHeight}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, opacity: 1 };
    el.style.overflow = 'hidden';
    const anim = el.animate([{ height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0 }, end], { duration: still ? 1 : 380, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    anim.finished.then(() => void (el.style.overflow = ''), () => {});
    el.classList.add('restored');
    el.addEventListener('animationend', () => el.classList.remove('restored'), { once: true });
  }

  // Ctrl/⌘ + Z undoes the latest tick, but only while its Undo bar is up and nothing else owns undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.code !== 'KeyZ' || e.defaultPrevented) return;
      const last = undosRef.current[undosRef.current.length - 1];
      if (!last || undoBelongsElsewhere(e.target)) return;
      e.preventDefault();
      void undo(last);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // Re-bound each render so undo() sees current state.

  const visible = todos.filter(t => !gone.has(t.key));
  const filter = filterTodos(visible, view, known);
  const shown = filter.todos;
  const groups = groupTodos(shown, group, folders || []);
  const limit = group === 'none' ? 7 : 5;
  const toggleSet = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  };

  const row = (t: Todo) => {
    const done = checked.has(t.key);
    const source = group === 'meeting' ? (t.field === 'enhanced_notes' ? 'AI notes' : '') : `${t.meeting.title || 'Untitled meeting'}${t.field === 'enhanced_notes' ? ' · AI notes' : ''}`;
    return (
      <li key={t.key} ref={el => rowRef(t.key, el)} className={cx(done && 'done')}>
        <input type="checkbox" className="task-box inline" aria-label={`Complete: ${t.text}`} checked={done} disabled={done} onChange={() => void tick(t)} />
        <button type="button" className="todo-text" title="Show in the note" disabled={done} onClick={() => onReveal(t.meeting.id, t.field, t.line, t.raw)}>
          <span className="todo-label">
            <span>{t.text}</span>
          </span>
          {source && <span className="todo-source">{source}</span>}
        </button>
      </li>
    );
  };

  return (
    <>
      <section className="panel dash-todos">
        <div className="panel-head">
          <div>
            <h2>Open to-dos</h2>
            <p className="muted">{description}</p>
          </div>
          <TodoViewMenu view={view} setView={setView} folders={folders} meetings={meetings} counts={counts} groupBy={allowed} />
        </div>
        {filter.active && (
          <TodoFilterChips setView={setView} folders={filter.folders} meetings={filter.meetings} folderList={folders || []} meetingList={meetings} shown={shown.length} total={visible.length} />
        )}
        {shown.length === 0 ? (
          filter.active && visible.length ? (
            <p className="hint">Nothing open in what you picked. {visible.length} more open elsewhere.</p>
          ) : (
            <p className="hint">Nothing open. Add a checkbox in any note with “- [ ] ”.</p>
          )
        ) : group === 'none' ? (
          <>
            <ul className="todo-list">{(showAll.has('all') ? shown : shown.slice(0, limit)).map(row)}</ul>
            {shown.length > limit && (
              <button type="button" className="ghost sm" onClick={() => setShowAll(s => toggleSet(s, 'all'))}>
                {showAll.has('all') ? 'Show fewer' : `Show all ${shown.length}`}
              </button>
            )}
          </>
        ) : (
          <div className="todo-groups">
            {groups.map(g => {
              const closed = view.collapsed.includes(g.key);
              const all = showAll.has(g.key);
              return (
                <div key={g.key} className={cx('todo-group', closed && 'closed')} style={g.folder ? folderVars(g.folder) : undefined}>
                  <button
                    type="button"
                    className="todo-group-head"
                    aria-expanded={!closed}
                    onClick={() => setView(v => ({ ...v, collapsed: closed ? v.collapsed.filter(k => k !== g.key) : [...v.collapsed, g.key] }))}
                  >
                    {g.meeting && !g.folder ? <FileText size={15} className="muted-icon" aria-hidden /> : <FolderGlyph folder={g.folder} size={15} />}
                    <strong className="truncate">{g.label}</strong>
                    {g.meeting && g.folder && <span className="todo-group-sub truncate">{g.folder.name}</span>}
                    <span className="todo-group-count">{g.todos.length}</span>
                    <ChevronDown size={15} className="todo-group-chevron" aria-hidden />
                  </button>
                  {!closed && (
                    <>
                      <ul className="todo-list">{(all ? g.todos : g.todos.slice(0, limit)).map(row)}</ul>
                      {g.todos.length > limit && (
                        <button type="button" className="ghost xs todo-group-more" onClick={() => setShowAll(s => toggleSet(s, g.key))}>
                          {all ? 'Show fewer' : `Show all ${g.todos.length}`}
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
      {undos.length > 0 &&
        createPortal(
          (() => {
            const last = undos[undos.length - 1];
            return (
              <div className="undo-bar" role="status" key={last.id}>
                <CircleCheck size={17} className="undo-icon" />
                <span className="undo-text">
                  {undos.length > 1 ? `${undos.length} to-dos completed` : 'Completed'} <span className="undo-what">“{last.todo.text}”</span>
                </span>
                <button type="button" className="undo-button" onClick={() => void undo(last)}>
                  <Undo2 size={15} /> Undo <kbd>{isMac ? '⌘Z' : 'Ctrl+Z'}</kbd>
                </button>
                <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setUndos([])}>
                  <X size={15} />
                </button>
                <span className="undo-timer" style={{ animationDuration: `${UNDO_MS}ms` }} />
              </div>
            );
          })(),
          document.body,
        )}
    </>
  );
}

function FolderCard({ folder: f, meetings, stats, onOpen, actions, dnd }: { folder: Folder; meetings: Meeting[]; stats: DashData | null; onOpen: () => void; actions: MenuItem[]; dnd?: MeetingDnd }) {
  const seconds = meetings.reduce((n, m) => n + (stats?.meetings[m.id]?.recorded_seconds || 0), 0);
  const latest = [...meetings].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return (
    <div className={cx('folder-card', dnd?.over === f.id && 'drop')} style={folderVars(f)} {...dnd?.zone(f.id)}>
      <button type="button" className="folder-card-main" onClick={onOpen} aria-label={`Open folder ${f.name}`}>
        <FolderTile folder={f} size={42} />
        <strong className="folder-card-name truncate">{f.name}</strong>
        <span className="folder-card-meta">
          {meetings.length ? `${meetings.length} meeting${meetings.length === 1 ? '' : 's'}` : 'Empty'}
          {seconds > 0 && ` · ${duration(seconds)}`}
          {latest[0] && ` · ${relativeDay(latest[0].updated_at)}`}
        </span>
        <span className="folder-card-list">
          {latest.slice(0, 2).map(m => (
            <span key={m.id} className="truncate">
              {m.title || 'Untitled meeting'}
            </span>
          ))}
          {!latest.length && <span className="empty">Drag meetings here</span>}
        </span>
      </button>
      <Menu
        label={`Actions for folder ${f.name}`}
        items={actions}
        header={<div className="menu-header truncate">{f.name}</div>}
        trigger={p => (
          <button type="button" className="icon-button folder-card-menu" aria-label={`Actions for folder ${f.name}`} {...p}>
            <Ellipsis size={16} />
          </button>
        )}
      />
    </div>
  );
}

/** Whether a meeting has AI notes you can read right now (not how many times they were written). */
export const hasAINotes = (m: Meeting) => !!(m.enhanced_notes || '').trim();

const DAY = 86400000;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function StatTile({ icon: Icon, label, value, sub }: { icon: typeof Clock; label: string; value: React.ReactNode; sub: React.ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">
        <span className="stat-icon" aria-hidden>
          <Icon size={14} />
        </span>
        {label}
      </span>
      <span className="stat-value">{value}</span>
      <span className="stat-delta">{sub}</span>
    </div>
  );
}

/** "+12m", "−3" etc. against last week, coloured by direction. */
function Trend({ now, before, format = String }: { now: number; before: number; format?: (n: number) => string }) {
  if (!now && !before) return <>Nothing last week either</>;
  const d = now - before;
  if (Math.abs(d) < (format === String ? 1 : 60)) return <>Same as last week</>;
  return (
    <>
      <span className={cx('trend', d > 0 ? 'up' : 'down')}>
        {d > 0 ? '+' : '−'}
        {format(Math.abs(d))}
      </span>{' '}
      vs last week
    </>
  );
}

type CalView = 'day' | 'week' | 'month';

/** A planned length: "45m", "1h", "1h 30m". */
const length = (minutes: number) => (minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`);
const CAL_VIEW_KEY = 'huh.home.calendarView';

function readCalView(): CalView {
  try {
    const v = localStorage.getItem(CAL_VIEW_KEY);
    if (v === 'day' || v === 'week' || v === 'month') return v;
  } catch {}
  return 'week';
}

/** Noon on the calendar day `n` days after the day of `from` (noon keeps DST shifts from changing the day). */
function dayAt(from: number | Date, n = 0) {
  const w = wall(from);
  return fromWall({ y: w.y, mo: w.mo, d: w.d + n, h: 12, mi: 0 });
}

/** Meetings on the calendar: one day, a week (Monday first) or a month, stepping back and forward a page at a time. */
function CalendarPanel({ meetings, folderById, stats, onOpen }: { meetings: Meeting[]; folderById: Map<string, Folder>; stats: DashData | null; onOpen: (id: string) => void }) {
  const [view, setViewState] = useState<CalView>(readCalView);
  // The day the calendar is looking at; Today resets it.
  const [anchor, setAnchor] = useState(() => dayAt(Date.now()));
  const today = dayNumber(Date.now());
  const setView = (v: CalView) => {
    setViewState(v);
    try {
      localStorage.setItem(CAL_VIEW_KEY, v);
    } catch {}
  };

  const byDay = useMemo(() => {
    const out = new Map<number, Meeting[]>();
    for (const m of meetings) {
      const n = dayNumber(meetingDate(m));
      out.set(n, [...(out.get(n) || []), m]);
    }
    for (const list of out.values()) list.sort((a, b) => meetingDate(a).localeCompare(meetingDate(b)));
    return out;
  }, [meetings]);

  const a = wall(anchor);
  const weekStart = dayAt(anchor, -((a.weekday + 6) % 7));
  const monthStart = fromWall({ y: a.y, mo: a.mo, d: 1, h: 12, mi: 0 });
  const monthLen = new Date(Date.UTC(a.y, a.mo, 0)).getUTCDate();
  // The month grid runs from the Monday on or before the 1st to the Sunday on or after the last day.
  const gridStart = dayAt(monthStart, -((wall(monthStart).weekday + 6) % 7));
  const gridDays = Math.ceil((((wall(monthStart).weekday + 6) % 7) + monthLen) / 7) * 7;

  const days =
    view === 'day' ? [anchor] : view === 'week' ? Array.from({ length: 7 }, (_, i) => dayAt(weekStart, i)) : Array.from({ length: monthLen }, (_, i) => dayAt(monthStart, i));
  const inRange = days.flatMap(d => byDay.get(dayNumber(d)) || []);
  const seconds = inRange.reduce((n, m) => n + (stats?.meetings[m.id]?.recorded_seconds || 0), 0);

  const step = (dir: number) => {
    if (view === 'day') setAnchor(dayAt(anchor, dir));
    else if (view === 'week') setAnchor(dayAt(anchor, dir * 7));
    else setAnchor(fromWall({ y: a.y, mo: a.mo + dir, d: 1, h: 12, mi: 0 }));
  };
  const showing =
    view === 'day' ? dayNumber(anchor) === today : view === 'week' ? dayNumber(weekStart) === dayNumber(dayAt(Date.now(), -((wall(Date.now()).weekday + 6) % 7))) : a.y === wall(Date.now()).y && a.mo === wall(Date.now()).mo;
  const sameYear = a.y === wall(Date.now()).y;

  let title: string;
  let range: string;
  if (view === 'day') {
    const rel = dayNumber(anchor) - today;
    title = rel === 0 ? 'Today' : rel === -1 ? 'Yesterday' : rel === 1 ? 'Tomorrow' : fmt(anchor, { weekday: 'long' });
    range = fmt(anchor, { weekday: rel >= -1 && rel <= 1 ? 'long' : undefined, month: 'long', day: 'numeric', year: sameYear ? undefined : 'numeric' });
  } else if (view === 'week') {
    const end = dayAt(weekStart, 6);
    const thisWeekStart = dayNumber(dayAt(Date.now(), -((wall(Date.now()).weekday + 6) % 7)));
    const rel = Math.round((dayNumber(weekStart) - thisWeekStart) / 7);
    title = rel === 0 ? 'This week' : rel === -1 ? 'Last week' : rel === 1 ? 'Next week' : `Week of ${fmt(weekStart, { month: 'short', day: 'numeric' })}`;
    range = `${fmt(weekStart, { month: 'short', day: 'numeric' })} – ${fmt(end, { month: wall(weekStart).mo === wall(end).mo ? undefined : 'short', day: 'numeric' })}`;
  } else {
    title = fmt(monthStart, { month: 'long', year: sameYear ? undefined : 'numeric' });
    range = fmt(monthStart, { year: 'numeric' });
  }

  const chip = (m: Meeting, compact = false) => {
    const f = m.folder_id ? folderById.get(m.folder_id) : undefined;
    const time = fmt(meetingDate(m), { hour: 'numeric', minute: '2-digit' });
    return (
      <button
        key={m.id}
        type="button"
        className={cx('week-chip', compact && 'compact', m.status === 'recording' && 'live')}
        style={f ? folderVars(f) : undefined}
        title={`${m.title || 'Untitled meeting'} · ${time}${f ? ` · ${f.name}` : ''}`}
        onClick={() => onOpen(m.id)}
      >
        {!compact && <span className="week-chip-time">{time}</span>}
        <span className="week-chip-title">{m.title || 'Untitled meeting'}</span>
      </button>
    );
  };

  const dayView = () => {
    const list = byDay.get(dayNumber(anchor)) || [];
    if (!list.length) return <p className="cal-empty">No meetings {dayNumber(anchor) === today ? 'today' : 'this day'}.</p>;
    return (
      <ul className="cal-agenda">
        {list.map(m => {
          const f = m.folder_id ? folderById.get(m.folder_id) : undefined;
          const start = new Date(meetingDate(m));
          const end = new Date(start.getTime() + (m.duration_minutes || 60) * 60000);
          const s = stats?.meetings[m.id];
          const past = end.getTime() < Date.now();
          const now = !past && start.getTime() <= Date.now();
          return (
            <li key={m.id}>
              <button type="button" className={cx('cal-event', past && 'past', now && 'now')} style={f ? folderVars(f) : undefined} onClick={() => onOpen(m.id)}>
                <span className="cal-event-time">
                  <strong>{fmt(start, { hour: 'numeric', minute: '2-digit' })}</strong>
                  <span>{length(m.duration_minutes || 60)}</span>
                </span>
                <span className="cal-event-main">
                  <strong className="truncate">{m.title || 'Untitled meeting'}</strong>
                  <span className="cal-event-meta">
                    {timeRange(start, end)}
                    {f && (
                      <span className="recent-folder">
                        <FolderGlyph folder={f} size={12} />
                        <span className="truncate">{f.name}</span>
                      </span>
                    )}
                    {s?.recorded_seconds ? (
                      <span className="mrow-stat">
                        <AudioLines size={12} /> {duration(s.recorded_seconds)}
                      </span>
                    ) : null}
                    {hasAINotes(m) && (
                      <span className="mrow-stat ai">
                        <Sparkles size={12} /> AI
                      </span>
                    )}
                  </span>
                </span>
                {now && <span className="cal-now">Now</span>}
              </button>
            </li>
          );
        })}
      </ul>
    );
  };

  const weekView = () => (
    <ol className="week-days">
      {days.map(d => {
        const n = dayNumber(d);
        const list = byDay.get(n) || [];
        return (
          <li key={n} className={cx('week-day', n === today && 'today', n < today && 'past', !list.length && 'empty')}>
            <button type="button" className="week-day-head" title="Open this day" onClick={() => (setAnchor(d), setView('day'))}>
              <span className="week-day-name">{fmt(d, { weekday: 'short' })}</span>
              <span className="week-day-num">{wall(d).d}</span>
            </button>
            {list.length > 0 && (
              <span className="week-day-items">
                {list.slice(0, 3).map(m => chip(m))}
                {list.length > 3 && (
                  <button type="button" className="week-more" onClick={() => (setAnchor(d), setView('day'))}>
                    +{list.length - 3} more
                  </button>
                )}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );

  const monthView = () => (
    <div className="cal-month">
      {Array.from({ length: 7 }, (_, i) => (
        <span key={i} className="cal-month-dow">
          {fmt(dayAt(gridStart, i), { weekday: 'short' })}
        </span>
      ))}
      {Array.from({ length: gridDays }, (_, i) => {
        const d = dayAt(gridStart, i);
        const n = dayNumber(d);
        const list = byDay.get(n) || [];
        const outside = wall(d).mo !== a.mo;
        return (
          <div key={n} className={cx('cal-cell', outside && 'outside', n === today && 'today', n < today && 'past')}>
            <button type="button" className="cal-cell-num" aria-label={`Open ${fmt(d, { month: 'long', day: 'numeric' })}`} onClick={() => (setAnchor(d), setView('day'))}>
              {wall(d).d}
            </button>
            {list.slice(0, 2).map(m => chip(m, true))}
            {list.length > 2 && (
              <button type="button" className="week-more" onClick={() => (setAnchor(d), setView('day'))}>
                +{list.length - 2} more
              </button>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <section className="panel dash-week" aria-label="Calendar">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          <p className="muted">
            {range} · {inRange.length ? plural(inRange.length, 'meeting') : 'No meetings'}
            {seconds > 0 && ` · ${duration(seconds)} recorded`}
          </p>
        </div>
        <div className="week-nav">
          <Segmented
            size="sm"
            ariaLabel="Calendar view"
            value={view}
            onChange={setView}
            options={[
              { value: 'day', label: 'Day' },
              { value: 'week', label: 'Week' },
              { value: 'month', label: 'Month' },
            ]}
          />
          <span className="week-nav-steps">
            {!showing && (
              <button type="button" className="ghost sm" onClick={() => setAnchor(dayAt(Date.now()))}>
                Today
              </button>
            )}
            <button type="button" className="icon-button sm" aria-label={`Previous ${view}`} title={`Previous ${view}`} onClick={() => step(-1)}>
              <ChevronLeft size={17} />
            </button>
            <button type="button" className="icon-button sm" aria-label={`Next ${view}`} title={`Next ${view}`} onClick={() => step(1)}>
              <ChevronRight size={17} />
            </button>
          </span>
        </div>
      </div>
      {view === 'day' ? dayView() : view === 'week' ? weekView() : monthView()}
    </section>
  );
}

export default function Dashboard({
  meetings,
  folders,
  onOpen,
  onMeetingMenu,
  onReveal,
  onOpenFolder,
  onNewFolder,
  folderActions,
  onNew,
  onImport,
  onSettings,
  reloadMeetings,
  creating,
  dnd,
}: {
  meetings: Meeting[];
  folders: Folder[];
  onOpen: (id: string) => void;
  onMeetingMenu?: (m: Meeting, x: number, y: number) => void;
  /** Open a meeting's note at a source line and highlight it. */
  onReveal: (id: string, field: Field, line: number, lineText: string) => void;
  onOpenFolder: (id: string) => void;
  onNewFolder: () => void;
  folderActions: (f: Folder) => MenuItem[];
  onNew: () => void;
  onImport: () => void;
  onSettings: (section: 'ai' | 'transcription') => void;
  reloadMeetings: () => Promise<void>;
  creating: boolean;
  dnd?: MeetingDnd;
}) {
  useZone();
  const data = useDashData();
  const [settings, setSettings] = useState<SettingsT | null>(null);
  useEffect(() => {
    api<SettingsT>('/settings')
      .then(setSettings)
      .catch(() => {});
  }, []);
  const folderById = useMemo(() => new Map(folders.map(f => [f.id, f])), [folders]);
  const inFolder = useMemo(() => {
    const out = new Map<string, Meeting[]>(folders.map(f => [f.id, []]));
    for (const m of meetings) if (m.folder_id) out.get(m.folder_id)?.push(m);
    return out;
  }, [meetings, folders]);

  const now = new Date();
  const hour = wall(now).h;
  const greeting = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const summary = useMemo(() => {
    const week = startOfWeek(now);
    const lastWeek = week - 7 * DAY;
    const nextWeek = week + 7 * DAY;
    let thisCount = 0,
      lastCount = 0,
      thisSec = 0,
      lastSec = 0;
    for (const m of meetings) {
      const t = new Date(meetingDate(m)).getTime();
      const s = data?.meetings[m.id];
      if (t >= week && t < nextWeek) {
        thisCount++;
        thisSec += s?.recorded_seconds || 0;
      } else if (t >= lastWeek && t < week) {
        lastCount++;
        lastSec += s?.recorded_seconds || 0;
      }
    }
    return { thisCount, lastCount, thisSec, lastSec };
  }, [meetings, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const todos = useMemo(() => collectTodos(meetings), [meetings]);

  // What's happening today: the next meeting still to start, or how many there are.
  const today = useMemo(() => {
    const n = dayNumber(Date.now());
    const list = meetings.filter(m => dayNumber(meetingDate(m)) === n).sort((a, b) => meetingDate(a).localeCompare(meetingDate(b)));
    const next = list.find(m => new Date(meetingDate(m)).getTime() > Date.now());
    return { count: list.length, next };
  }, [meetings]); // eslint-disable-line react-hooks/exhaustive-deps

  const recent = meetings.slice(0, 5);
  const active = (data?.jobs || []).filter(j => j.status === 'queued' || j.status === 'running' || j.status === 'paused');
  const failed = (data?.jobs || []).filter(j => j.status === 'failed');
  const meetingsWithTodos = new Set(todos.map(t => t.meeting.id)).size;

  return (
    <div className="dashboard">
      <header className="dash-head">
        <div>
          <p className="dash-date">{fmt(now, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          <h1>{greeting}</h1>
          <p className="dash-lede">
            {meetings.length === 0 ? (
              'Your notebook is empty. Start your first meeting below.'
            ) : (
              <>
                {today.next ? (
                  <>
                    Next up:{' '}
                    <button type="button" className="link" onClick={() => onOpen(today.next!.id)}>
                      {today.next.title || 'Untitled meeting'}
                    </button>{' '}
                    at {fmt(meetingDate(today.next), { hour: 'numeric', minute: '2-digit' })}.{' '}
                  </>
                ) : today.count ? (
                  `${plural(today.count, 'meeting')} today. `
                ) : (
                  'Nothing on the calendar today. '
                )}
                {todos.length ? `${plural(todos.length, 'open to-do')} across ${plural(meetingsWithTodos, 'meeting')}.` : 'No open to-dos.'}
              </>
            )}
          </p>
        </div>
        <div className="dash-actions">
          <button type="button" className="ghost-bordered" onClick={onImport} disabled={creating}>
            <FileAudio size={16} /> Import recording
          </button>
          <button type="button" className="primary" onClick={onNew} disabled={creating}>
            {creating ? <Spinner size={15} /> : <Plus size={17} />} Start a meeting
          </button>
        </div>
      </header>

      {settings && !settings.model && (
        <Callout tone="warn">
          AI notes aren’t set up yet — choose a provider and model.{' '}
          <button type="button" className="link" onClick={() => onSettings('ai')}>
            Set up AI notes →
          </button>
        </Callout>
      )}

      {(active.length > 0 || failed.length > 0) && (
        <section className="dash-activity" aria-label="Processing">
          {active.map(j => (
            <button key={j.id} type="button" className="activity-item" onClick={() => onOpen(j.meeting_id)}>
              {j.status === 'paused' ? <Pause size={15} /> : <Spinner size={15} />}
              <span className="truncate">
                {j.kind === 'transcribe' ? 'Transcribing' : 'Writing AI notes for'} <strong>{j.meeting_title || 'Untitled meeting'}</strong>
                {j.status === 'paused' ? ' — paused' : j.status === 'queued' ? ' — waiting' : j.progress ? ` — ${Math.round(j.progress * 100)}%` : '…'}
              </span>
              <ArrowRight size={15} className="muted-icon" />
            </button>
          ))}
          {failed.slice(0, 3).map(j => (
            <button key={j.id} type="button" className="activity-item failed" onClick={() => onOpen(j.meeting_id)}>
              <CircleAlert size={15} />
              <span className="truncate">
                {j.kind === 'transcribe' ? 'Transcription' : 'AI notes'} failed for <strong>{j.meeting_title || 'Untitled meeting'}</strong>
                {j.error ? ` — ${j.error}` : ''}
              </span>
              <ArrowRight size={15} className="muted-icon" />
            </button>
          ))}
        </section>
      )}

      <section className="stat-row" aria-label="Summary">
        <StatTile icon={CalendarDays} label="Meetings this week" value={summary.thisCount} sub={<Trend now={summary.thisCount} before={summary.lastCount} />} />
        <StatTile icon={Clock} label="Recorded this week" value={duration(summary.thisSec)} sub={<Trend now={summary.thisSec} before={summary.lastSec} format={duration} />} />
        <StatTile icon={ListTodo} label="Open to-dos" value={todos.length} sub={todos.length ? `In ${plural(meetingsWithTodos, 'meeting')}` : 'All clear'} />
      </section>

      <CalendarPanel meetings={meetings} folderById={folderById} stats={data} onOpen={onOpen} />

      <div className="dash-grid">
        <section className="panel dash-recent">
          <div className="panel-head">
            <div>
              <h2>Jump back in</h2>
              <p className="muted">Recently edited meetings.</p>
            </div>
          </div>
          {recent.length === 0 ? (
            <div className="empty-mini">
              <Mic size={26} />
              <strong>No meetings yet</strong>
              <p className="muted">Create one to take notes, record, and get AI notes.</p>
              <button type="button" className="primary sm" onClick={onNew}>
                <Plus size={15} /> Create a meeting
              </button>
            </div>
          ) : (
            <ul className="mrows">
              {recent.map(m => (
                <MeetingRow key={m.id} meeting={m} stats={data?.meetings[m.id]} folder={m.folder_id ? folderById.get(m.folder_id) : undefined} onOpen={onOpen} onMenu={onMeetingMenu} drag={dnd} />
              ))}
            </ul>
          )}
        </section>

        <TodoPanel meetings={meetings} folders={folders} viewKey="home" onReveal={onReveal} reloadMeetings={reloadMeetings} />
      </div>

      <section className="dash-folders" aria-label="Folders">
        <div className="dash-section-head">
          <h2>Folders</h2>
          {folders.length > 0 && (
            <button type="button" className="ghost sm" onClick={onNewFolder}>
              <FolderPlus size={15} /> New folder
            </button>
          )}
        </div>
        {folders.length === 0 ? (
          <button type="button" className="folder-empty-cta" onClick={onNewFolder}>
            <FolderPlus size={22} />
            <span>
              <strong>Organize meetings into folders</strong>
              <span className="muted">Give each one a colour and an icon — classes, clients, projects, anything.</span>
            </span>
            <ArrowRight size={16} className="muted-icon" />
          </button>
        ) : (
          <div className="folder-grid">
            {folders.map(f => (
              <FolderCard key={f.id} folder={f} meetings={inFolder.get(f.id) || []} stats={data} onOpen={() => onOpenFolder(f.id)} actions={folderActions(f)} dnd={dnd} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

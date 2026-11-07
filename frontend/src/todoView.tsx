import { useEffect, useMemo, useRef, useState } from 'react';
import { Ellipsis, FileText, Search, X } from 'lucide-react';
import { Folder, Meeting } from './api';
import { FolderGlyph, folderVars } from './folders';
import { cx, Popover, Segmented } from './ui';

export type TodoGroup = 'none' | 'folder' | 'meeting';

/** How one to-do panel is laid out. Saved per panel in this browser. */
export type TodoView = {
  group: TodoGroup;
  /** Folder ids to show to-dos from; `NO_FOLDER` stands for meetings outside any folder. */
  folders: string[];
  /** Meeting ids to show to-dos from. */
  meetings: string[];
  /** Group keys the user has folded shut. */
  collapsed: string[];
};

export const NO_FOLDER = '';
const EMPTY: TodoView = { group: 'none', folders: [], meetings: [], collapsed: [] };
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function parseView(raw: string | null): TodoView {
  try {
    const v = JSON.parse(raw || '{}');
    return {
      group: v.group === 'folder' || v.group === 'meeting' ? v.group : 'none',
      folders: strings(v.folders),
      meetings: strings(v.meetings),
      collapsed: strings(v.collapsed),
    };
  } catch {
    return EMPTY;
  }
}

/** The panel's grouping and filter, kept in localStorage so it survives leaving the page or reloading. */
export function useTodoView(key: string) {
  const storageKey = `huh-todo-view:${key}`;
  const [view, setView] = useState<TodoView>(() => {
    try {
      return parseView(localStorage.getItem(storageKey));
    } catch {
      return EMPTY;
    }
  });
  // A different panel (e.g. another folder's page) reuses this component with its own saved view.
  const loaded = useRef(storageKey);
  useEffect(() => {
    if (loaded.current === storageKey) return;
    loaded.current = storageKey;
    try {
      setView(parseView(localStorage.getItem(storageKey)));
    } catch {
      setView(EMPTY);
    }
  }, [storageKey]);
  useEffect(() => {
    if (loaded.current !== storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(view));
    } catch {}
  }, [view, storageKey]);
  return [view, setView] as const;
}

type HasMeeting = { meeting: Meeting };

/**
 * Keep to-dos from the picked folders and meetings (either one matches). Ids that no longer exist are
 * ignored, and nothing picked means everything.
 */
export function filterTodos<T extends HasMeeting>(todos: T[], view: TodoView, known: { folders: Set<string>; meetings: Set<string> }) {
  const folders = new Set(view.folders.filter(id => known.folders.has(id)));
  const meetings = new Set(view.meetings.filter(id => known.meetings.has(id)));
  if (!folders.size && !meetings.size) return { todos, active: false, folders, meetings };
  return { todos: todos.filter(t => folders.has(t.meeting.folder_id ?? NO_FOLDER) || meetings.has(t.meeting.id)), active: true, folders, meetings };
}

export type Group<T> = { key: string; label: string; folder?: Folder | null; meeting?: Meeting; todos: T[] };

/** Split to-dos into folder or meeting groups, in sidebar order; "No folder" goes last. */
export function groupTodos<T extends HasMeeting>(todos: T[], by: TodoGroup, folders: Folder[]): Group<T>[] {
  if (by === 'none') return [{ key: 'all', label: '', todos }];
  const groups = new Map<string, Group<T>>();
  if (by === 'folder') {
    for (const f of folders) groups.set(`f:${f.id}`, { key: `f:${f.id}`, label: f.name, folder: f, todos: [] });
    groups.set('f:', { key: 'f:', label: 'No folder', folder: null, todos: [] });
  }
  const folderById = new Map(folders.map(f => [f.id, f]));
  for (const t of todos) {
    const m = t.meeting;
    const key = by === 'folder' ? `f:${m.folder_id && folderById.has(m.folder_id) ? m.folder_id : ''}` : `m:${m.id}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, label: m.title || 'Untitled meeting', meeting: m, folder: m.folder_id ? folderById.get(m.folder_id) : null, todos: [] }));
    g.todos.push(t);
  }
  return [...groups.values()].filter(g => g.todos.length);
}

/** The ⋯ button on the to-do panel: group by, and a multi-select filter over folders and meetings. */
export function TodoViewMenu({
  view,
  setView,
  folders,
  meetings,
  counts,
  groupBy = ['none', 'folder', 'meeting'],
}: {
  view: TodoView;
  setView: (update: (v: TodoView) => TodoView) => void;
  /** Folders to offer in the filter; leave out to filter by meeting only. */
  folders?: Folder[];
  meetings: Meeting[];
  /** Open to-dos per meeting id (before filtering). */
  counts: Map<string, number>;
  groupBy?: TodoGroup[];
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const folderById = useMemo(() => new Map((folders || []).map(f => [f.id, f])), [folders]);
  const picked = view.folders.length + view.meetings.length;

  const folderCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const m of meetings) {
      const id = m.folder_id && folderById.has(m.folder_id) ? m.folder_id : NO_FOLDER;
      out.set(id, (out.get(id) || 0) + (counts.get(m.id) || 0));
    }
    return out;
  }, [meetings, counts, folderById]);

  const q = query.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);
  const folderRows = folders
    ? [...folders.map(f => ({ id: f.id, label: f.name, folder: f as Folder | null })), ...(meetings.some(m => !m.folder_id || !folderById.has(m.folder_id)) ? [{ id: NO_FOLDER, label: 'No folder', folder: null }] : [])].filter(r => match(r.label))
    : [];
  // Meetings with something open, plus any already picked so they can be unpicked.
  const meetingRows = meetings.filter(m => (counts.get(m.id) || view.meetings.includes(m.id)) && match(m.title || 'Untitled meeting'));

  const toggle = (list: 'folders' | 'meetings', id: string) =>
    setView(v => ({ ...v, [list]: v[list].includes(id) ? v[list].filter(x => x !== id) : [...v[list], id] }));

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={cx('icon-button sm todo-view-button', picked > 0 && 'on')}
        aria-label="Group and filter to-dos"
        title="Group and filter"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <Ellipsis size={17} />
        {picked > 0 && <span className="todo-view-dot" aria-hidden />}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" minWidth={290} maxWidth={340} className="todo-view-popover" label="Group and filter to-dos">
        <div className="todo-view-section">
          <span className="select-group">Group by</span>
          <Segmented
            size="sm"
            ariaLabel="Group to-dos by"
            value={groupBy.includes(view.group) ? view.group : 'none'}
            onChange={group => setView(v => ({ ...v, group }))}
            options={groupBy.map(g => ({ value: g, label: g === 'none' ? 'None' : g === 'folder' ? 'Folder' : 'Meeting' }))}
          />
        </div>
        <div className="todo-view-filter-head">
          <span className="select-group">Show to-dos from</span>
          {picked > 0 && (
            <button type="button" className="link xs" onClick={() => setView(v => ({ ...v, folders: [], meetings: [] }))}>
              Show all
            </button>
          )}
        </div>
        <label className="select-search">
          <Search size={15} />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder={folders ? 'Find a folder or meeting' : 'Find a meeting'} aria-label="Find a folder or meeting" />
        </label>
        <div className="select-list todo-view-list">
          {folderRows.length > 0 && <div className="select-group">Folders</div>}
          {folderRows.map(r => (
            <label key={`f:${r.id}`} className="select-option todo-view-option">
              <input type="checkbox" className="task-box inline" checked={view.folders.includes(r.id)} onChange={() => toggle('folders', r.id)} />
              <FolderGlyph folder={r.folder} size={14} />
              <span className="option-label truncate">{r.label}</span>
              <span className="todo-view-count">{folderCounts.get(r.id) || 0}</span>
            </label>
          ))}
          {meetingRows.length > 0 && <div className="select-group">Meetings</div>}
          {meetingRows.map(m => {
            const f = m.folder_id ? folderById.get(m.folder_id) : undefined;
            return (
              <label key={`m:${m.id}`} className="select-option todo-view-option">
                <input type="checkbox" className="task-box inline" checked={view.meetings.includes(m.id)} onChange={() => toggle('meetings', m.id)} />
                {f ? <FolderGlyph folder={f} size={14} /> : <FileText size={14} className="muted-icon" aria-hidden />}
                <span className="option-label truncate">{m.title || 'Untitled meeting'}</span>
                <span className="todo-view-count">{counts.get(m.id) || 0}</span>
              </label>
            );
          })}
          {!folderRows.length && !meetingRows.length && <div className="select-empty">{q ? 'Nothing matches.' : 'No meetings have open to-dos.'}</div>}
        </div>
        <div className="select-footer todo-view-foot">Pick any mix. Nothing picked shows every to-do.</div>
      </Popover>
    </>
  );
}

/** Chips under the panel header for what the filter is showing, each removable. */
export function TodoFilterChips({
  setView,
  folders,
  meetings,
  folderList,
  meetingList,
  shown,
  total,
}: {
  setView: (update: (v: TodoView) => TodoView) => void;
  /** The picked ids that still exist. */
  folders: Set<string>;
  meetings: Set<string>;
  folderList: Folder[];
  meetingList: Meeting[];
  shown: number;
  total: number;
}) {
  const fById = new Map(folderList.map(f => [f.id, f]));
  const mById = new Map(meetingList.map(m => [m.id, m]));
  const drop = (list: 'folders' | 'meetings', id: string) => setView(v => ({ ...v, [list]: v[list].filter(x => x !== id) }));
  return (
    <div className="todo-chips" aria-label="Filter">
      <span className="todo-chips-count">
        {shown} of {total}
      </span>
      {[...folders].map(id => {
        const f = fById.get(id) ?? null;
        return (
          <span key={`f:${id}`} className="todo-chip" style={folderVars(f)}>
            <FolderGlyph folder={f} size={12} />
            <span className="truncate">{f ? f.name : 'No folder'}</span>
            <button type="button" aria-label={`Stop showing ${f ? f.name : 'No folder'}`} onClick={() => drop('folders', id)}>
              <X size={12} />
            </button>
          </span>
        );
      })}
      {[...meetings].map(id => {
        const m = mById.get(id);
        const title = m?.title || 'Untitled meeting';
        return (
          <span key={`m:${id}`} className="todo-chip meeting">
            <FileText size={12} aria-hidden />
            <span className="truncate">{title}</span>
            <button type="button" aria-label={`Stop showing ${title}`} onClick={() => drop('meetings', id)}>
              <X size={12} />
            </button>
          </span>
        );
      })}
      <button type="button" className="link xs" onClick={() => setView(v => ({ ...v, folders: [], meetings: [] }))}>
        Clear
      </button>
    </div>
  );
}

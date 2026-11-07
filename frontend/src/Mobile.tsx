/** The phone layout: a bottom tab bar, big touch targets, one thing at a time. Desktop-only extras (hotkeys, drag and drop,
 * side by side, the sidebar) are left out; everything else is reachable by tapping. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ChevronLeft, Ellipsis, FileAudio, FolderPlus, Home, Pencil, ListTodo, Lock, Mic, Monitor, NotebookPen, Plus, Search, Settings as SettingsIcon, Sparkles, X } from 'lucide-react';
import { Folder, Meeting } from './api';
import { plain, relativeDay, TodoPanel, useDashData } from './Dashboard';
import { FolderGlyph, FolderTile, folderVars } from './folders';
import { cx, Modal, Spinner } from './ui';

/* ------------------------------------------------------------ detection */

/** Phones in portrait, or a phone turned sideways (short and touch-only). Tablets and laptops keep the desktop layout. */
const PHONE_QUERY = '(max-width: 600px), (pointer: coarse) and (max-height: 500px)';
export type LayoutPref = 'auto' | 'phone' | 'desktop';
const LAYOUT_KEY = 'huh:layout';
function readPref(): LayoutPref {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return v === 'phone' || v === 'desktop' ? v : 'auto';
  } catch {
    return 'auto';
  }
}
/** Whether to use the phone layout, plus the per-device override (Settings on the phone, the palette on desktop). */
export function usePhoneLayout(): { phone: boolean; small: boolean; pref: LayoutPref; setPref: (p: LayoutPref) => void } {
  const [small, setSmall] = useState(() => window.matchMedia(PHONE_QUERY).matches);
  const [pref, setPrefState] = useState(readPref);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setSmall(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const phone = pref === 'phone' || (pref === 'auto' && small);
  useEffect(() => {
    document.body.classList.toggle('phone', phone);
    return () => document.body.classList.remove('phone');
  }, [phone]);
  // Keep the app inside the part of the screen you can see. When the iOS keyboard opens, Safari scrolls the
  // whole page up; following the visual viewport keeps the top bar in place and nothing slides under the clock.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!phone || !vv) return;
    const root = document.documentElement;
    // Only while a text field has the keyboard up. Otherwise Safari's own bounce (when a short page is swiped)
    // would move the app the opposite way to the finger.
    const typingField = () => {
      const a = document.activeElement;
      return a instanceof HTMLTextAreaElement || (a instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(a.type)) || (a instanceof HTMLElement && a.isContentEditable);
    };
    const set = () => {
      if (typingField()) {
        root.style.setProperty('--vvh', `${vv.height}px`);
        root.style.setProperty('--vvtop', `${vv.offsetTop}px`);
      } else {
        root.style.removeProperty('--vvh');
        root.style.removeProperty('--vvtop');
        if (window.scrollY) window.scrollTo(0, 0);
      }
    };
    // Focus changes settle a moment later than the keyboard animation starts.
    const later = () => setTimeout(set, 50);
    set();
    vv.addEventListener('resize', set);
    vv.addEventListener('scroll', set);
    document.addEventListener('focusin', later);
    document.addEventListener('focusout', later);
    return () => {
      vv.removeEventListener('resize', set);
      vv.removeEventListener('scroll', set);
      document.removeEventListener('focusin', later);
      document.removeEventListener('focusout', later);
      root.style.removeProperty('--vvh');
      root.style.removeProperty('--vvtop');
    };
  }, [phone]);
  const setPref = (p: LayoutPref) => {
    setPrefState(p);
    try {
      if (p === 'auto') localStorage.removeItem(LAYOUT_KEY);
      else localStorage.setItem(LAYOUT_KEY, p);
    } catch {}
  };
  return { phone, small, pref, setPref };
}

/* ------------------------------------------------------------- tab bar */

export type PhoneTab = 'home' | 'todos' | 'search' | 'settings';

export function PhoneTabBar({ tab, onTab, onNew, creating }: { tab: PhoneTab | null; onTab: (t: PhoneTab) => void; onNew: () => void; creating: boolean }) {
  const item = (id: PhoneTab, label: string, icon: React.ReactNode) => (
    <button type="button" className={cx('tabbar-item', tab === id && 'on')} aria-current={tab === id ? 'page' : undefined} onClick={() => onTab(id)}>
      {icon}
      <span>{label}</span>
    </button>
  );
  return (
    <nav className="phone-tabbar" aria-label="Main">
      {item('home', 'Meetings', <Home size={22} />)}
      {item('todos', 'To-dos', <ListTodo size={22} />)}
      <button type="button" className="tabbar-new" aria-label="New meeting" disabled={creating} onClick={onNew}>
        {creating ? <Spinner size={20} /> : <Plus size={26} strokeWidth={2.4} />}
      </button>
      {item('search', 'Search', <Search size={22} />)}
      {item('settings', 'Settings', <SettingsIcon size={22} />)}
    </nav>
  );
}

/** What the big + does: record right away, write, or bring in a Voice Memo. */
export function NewSheet({ open, onClose, onPick, folder }: { open: boolean; onClose: () => void; onPick: (kind: 'record' | 'write' | 'import') => void; folder?: Folder }) {
  const pick = (k: 'record' | 'write' | 'import') => {
    onClose();
    onPick(k);
  };
  return (
    <Modal open={open} onClose={onClose} title={folder ? `New in ${folder.name}` : 'New meeting'}>
      <div className="new-sheet">
        <button type="button" className="new-option record" onClick={() => pick('record')}>
          <span className="new-option-icon">
            <Mic size={22} />
          </span>
          <span>
            <strong>Record now</strong>
          </span>
        </button>
        <button type="button" className="new-option" onClick={() => pick('write')}>
          <span className="new-option-icon">
            <NotebookPen size={22} />
          </span>
          <span>
            <strong>Write notes</strong>
          </span>
        </button>
        <button type="button" className="new-option" onClick={() => pick('import')}>
          <span className="new-option-icon">
            <FileAudio size={22} />
          </span>
          <span>
            <strong>Import audio</strong>
          </span>
        </button>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------- top bar */

/** For pages pushed on top of a tab (a meeting, a folder): Back on the left, actions on the right. */
export function PhoneTopBar({
  backLabel,
  onBack,
  title,
  onMenu,
  onRecord,
  save,
}: {
  backLabel: string;
  onBack: () => void;
  title?: string;
  onMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** On a meeting: one tap to start recording. Swapped for a live badge while recording (body.rec-active). */
  onRecord?: () => void;
  /** The open meeting's save state (its notes' editors), shown under the title. */
  save?: SaveState | null;
}) {
  return (
    <header className="phone-top">
      <button type="button" className="phone-back" onClick={onBack} aria-label={`Back to ${backLabel}`}>
        <ChevronLeft size={24} />
        <span className="truncate">{backLabel}</span>
      </button>
      <span className="phone-top-center">
        {title != null && <span className="phone-top-title truncate">{title || 'Untitled meeting'}</span>}
        {save && (
          <span className={cx('phone-save', save.tone)} role="status">
            <span className="save-dot" />
            {save.status}
          </span>
        )}
      </span>
      {onRecord && (
        <>
          <button type="button" className="phone-record" aria-label="Record" onClick={onRecord}>
            <span className="rec-dot static" />
            <span className="phone-record-label">Record</span>
          </button>
          {/* Recording controls (pause / finish) from anywhere, even while typing. */}
          <button type="button" className="phone-rec-badge" aria-label="Recording controls" onPointerDown={e => e.preventDefault()} onClick={() => window.dispatchEvent(new Event('huh:recording-controls'))}>
            <span className="rec-dot" /> REC
          </button>
        </>
      )}
      {onRecord && (
        <button type="button" className="phone-icon-btn phone-edit" aria-label="Edit note" onClick={() => window.dispatchEvent(new Event('huh:phone-edit'))}>
          <Pencil size={20} />
        </button>
      )}
      {/* While typing, Done puts the keyboard away; the other actions come back after. */}
      <button type="button" className="phone-done" onPointerDown={e => e.preventDefault()} onClick={() => (document.activeElement as HTMLElement | null)?.blur()}>
        Done
      </button>
      {onMenu ? (
        <button type="button" className="phone-icon-btn" aria-label="More actions" onClick={onMenu}>
          <Ellipsis size={22} />
        </button>
      ) : (
        <span className="phone-icon-btn" aria-hidden />
      )}
    </header>
  );
}

/* --------------------------------------------------------- meeting list */

function when(m: Meeting) {
  const d = new Date(m.created_at || m.updated_at);
  const day = relativeDay(d.toISOString());
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return day === 'Today' || day === 'Yesterday' ? time : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function groupLabel(iso: string) {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  if (days < 31) return 'This month';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function PhoneMeetingRow({ meeting: m, folder, onOpen, onMenu }: { meeting: Meeting; folder?: Folder; onOpen: (id: string) => void; onMenu: (m: Meeting, x: number, y: number) => void }) {
  const snippet = plain(m.enhanced_notes || '') || plain(m.notes || '');
  const recording = m.status === 'recording';
  return (
    <li className="prow-item">
      <button type="button" className="prow" data-meeting={m.id} onClick={() => onOpen(m.id)} style={folder ? folderVars(folder) : undefined}>
        <span className="prow-top">
          <strong className="truncate">{m.title || 'Untitled meeting'}</strong>
          <span className="prow-when">{recording ? <span className="prow-live"><span className="rec-dot small-dot" /> Live</span> : when(m)}</span>
        </span>
        <span className={cx('prow-snippet', !snippet && 'empty')}>{snippet || 'No notes yet'}</span>
        {(folder || m.enhanced_notes?.trim()) && (
          <span className="prow-tags">
            {folder && (
              <span className="prow-folder">
                <FolderGlyph folder={folder} size={13} /> <span className="truncate">{folder.name}</span>
              </span>
            )}
            {m.enhanced_notes?.trim() && (
              <span className="prow-ai">
                <Sparkles size={12} /> AI notes
              </span>
            )}
          </span>
        )}
      </button>
      <button
        type="button"
        className="prow-menu"
        aria-label={`Actions for ${m.title || 'Untitled meeting'}`}
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(m, r.left, r.bottom);
        }}
      >
        <Ellipsis size={20} />
      </button>
    </li>
  );
}

function GroupedList({ meetings, folders, onOpen, onMenu, empty }: { meetings: Meeting[]; folders: Folder[]; onOpen: (id: string) => void; onMenu: (m: Meeting, x: number, y: number) => void; empty: React.ReactNode }) {
  const byId = useMemo(() => new Map(folders.map(f => [f.id, f])), [folders]);
  const groups = useMemo(() => {
    const sorted = [...meetings].sort((a, b) => (b.created_at || b.updated_at).localeCompare(a.created_at || a.updated_at));
    const out: { label: string; items: Meeting[] }[] = [];
    for (const m of sorted) {
      const label = groupLabel(m.created_at || m.updated_at);
      const g = out.find(x => x.label === label);
      if (g) g.items.push(m);
      else out.push({ label, items: [m] });
    }
    return out;
  }, [meetings]);
  if (!meetings.length) return <div className="phone-empty">{empty}</div>;
  return (
    <>
      {groups.map(g => (
        <section key={g.label} className="phone-group">
          <h2 className="phone-group-label">{g.label}</h2>
          <ul className="prows">
            {g.items.map(m => (
              <PhoneMeetingRow key={m.id} meeting={m} folder={m.folder_id ? byId.get(m.folder_id) : undefined} onOpen={onOpen} onMenu={onMenu} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/* ----------------------------------------------------------------- home */

export function PhoneHome({
  meetings,
  folders,
  onOpen,
  onMenu,
  onOpenFolder,
  onNewFolder,
  onSearch,
  onNew,
}: {
  /** Every meeting, archived included. */
  meetings: Meeting[];
  folders: Folder[];
  onOpen: (id: string) => void;
  onMenu: (m: Meeting, x: number, y: number) => void;
  onOpenFolder: (id: string) => void;
  onNewFolder: () => void;
  onSearch: () => void;
  onNew: () => void;
}) {
  const [showArchive, setShowArchive] = useState(false);
  const active = meetings.filter(m => !m.archived);
  const archived = meetings.filter(m => m.archived);
  const live = active.filter(m => m.status === 'recording');
  const count = (id: string) => active.filter(m => m.folder_id === id).length;
  const data = useDashData();
  const working = (data?.jobs || []).filter(j => j.status === 'queued' || j.status === 'running');
  return (
    <div className="phone-page">
      <header className="phone-head">
        <h1>{showArchive ? 'Archive' : 'Meetings'}</h1>
      </header>
      <button type="button" className="phone-searchbox" onClick={onSearch}>
        <Search size={18} /> <span>Search</span>
      </button>
      <div className="chip-scroll" role="toolbar" aria-label="Folders">
        <button type="button" className={cx('fchip', !showArchive && 'on')} onClick={() => setShowArchive(false)}>
          All <span className="fchip-n">{active.length}</span>
        </button>
        {folders.map(f => (
          <button key={f.id} type="button" className="fchip" style={folderVars(f)} onClick={() => onOpenFolder(f.id)}>
            <FolderGlyph folder={f} size={15} /> {f.name} {count(f.id) > 0 && <span className="fchip-n">{count(f.id)}</span>}
          </button>
        ))}
        {archived.length > 0 && (
          <button type="button" className={cx('fchip', showArchive && 'on')} onClick={() => setShowArchive(a => !a)}>
            <Archive size={15} /> Archive <span className="fchip-n">{archived.length}</span>
          </button>
        )}
        <button type="button" className="fchip add" onClick={onNewFolder} aria-label="New folder">
          <FolderPlus size={15} /> New folder
        </button>
      </div>
      {!showArchive && live.map(m => (
        <button key={m.id} type="button" className="phone-banner live" data-meeting={m.id} onClick={() => onOpen(m.id)}>
          <span className="rec-dot" /> <span className="truncate">Recording <strong>{m.title || 'Untitled meeting'}</strong></span>
        </button>
      ))}
      {!showArchive && working.slice(0, 2).map(j => (
        <button key={j.id} type="button" className="phone-banner" onClick={() => onOpen(j.meeting_id)}>
          <Spinner size={15} />
          <span className="truncate">
            {j.kind === 'transcribe' ? 'Transcribing' : 'Writing AI notes for'} <strong>{j.meeting_title || 'Untitled meeting'}</strong>
          </span>
        </button>
      ))}
      <GroupedList
        meetings={showArchive ? archived : active}
        folders={folders}
        onOpen={onOpen}
        onMenu={onMenu}
        empty={
          showArchive ? (
            <p className="muted">Nothing archived.</p>
          ) : (
            <>
              <Mic size={30} />
              <strong>No meetings yet</strong>
              <button type="button" className="primary" onClick={onNew}>
                <Plus size={17} /> New meeting
              </button>
            </>
          )
        }
      />
    </div>
  );
}

/* --------------------------------------------------------------- folder */

export function PhoneFolder({
  folder,
  meetings,
  folders,
  onOpen,
  onMenu,
  onNew,
}: {
  folder: Folder;
  meetings: Meeting[];
  folders: Folder[];
  onOpen: (id: string) => void;
  onMenu: (m: Meeting, x: number, y: number) => void;
  onNew: () => void;
}) {
  return (
    <div className="phone-page">
      <header className="phone-folder-head" style={folderVars(folder)}>
        <FolderTile folder={folder} size={52} />
        <div>
          <h1>{folder.name}</h1>
          <p className="muted">
            {meetings.length} meeting{meetings.length === 1 ? '' : 's'}
          </p>
        </div>
      </header>
      <button type="button" className="primary phone-wide" onClick={onNew}>
        <Plus size={18} /> New meeting here
      </button>
      <GroupedList
        meetings={meetings}
        folders={folders.filter(f => f.id !== folder.id)}
        onOpen={onOpen}
        onMenu={onMenu}
        empty={
          <>
            <FolderGlyph folder={folder} size={30} />
            <strong>Nothing here yet</strong>
          </>
        }
      />
    </div>
  );
}

/* ---------------------------------------------------------------- to-dos */

export function PhoneTodos({ meetings, folders, onReveal, reloadMeetings }: { meetings: Meeting[]; folders: Folder[]; onReveal: (id: string, field: 'notes' | 'enhanced_notes', line: number, lineText: string) => void; reloadMeetings: () => Promise<void> }) {
  return (
    <div className="phone-page phone-todos">
      <header className="phone-head">
        <h1>To-dos</h1>
      </header>
      <TodoPanel meetings={meetings} folders={folders} viewKey="phone" onReveal={onReveal} reloadMeetings={reloadMeetings} description="" />
    </div>
  );
}

/* ---------------------------------------------------------------- search */

export type PhoneAction = { id: string; title: string; icon: React.ReactNode; keywords: string; run: () => void };

/** Find the first match of q in text and return a short excerpt around it. */
function excerpt(text: string, q: string) {
  const flat = plain(text);
  const i = flat.toLowerCase().indexOf(q);
  if (i < 0) return null;
  const start = Math.max(0, i - 40);
  const end = Math.min(flat.length, i + q.length + 80);
  return { before: (start > 0 ? '…' : '') + flat.slice(start, i), hit: flat.slice(i, i + q.length), after: flat.slice(i + q.length, end) + (end < flat.length ? '…' : '') };
}

export function PhoneSearch({ meetings, folders, actions, onOpen, onOpenFolder }: { meetings: Meeting[]; folders: Folder[]; actions: PhoneAction[]; onOpen: (id: string, query: string) => void; onOpenFolder: (id: string) => void }) {
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const query = q.trim().toLowerCase();
  const byId = useMemo(() => new Map(folders.map(f => [f.id, f])), [folders]);
  const results = useMemo(() => {
    if (!query) return [];
    const out: { m: Meeting; score: number; ex: ReturnType<typeof excerpt> }[] = [];
    for (const m of meetings) {
      const inTitle = (m.title || '').toLowerCase().includes(query);
      const ex = excerpt(m.enhanced_notes || '', query) || excerpt(m.notes || '', query);
      if (inTitle || ex) out.push({ m, ex, score: (inTitle ? 2 : 0) + (m.archived ? -1 : 0) });
    }
    return out.sort((a, b) => b.score - a.score || (b.m.updated_at || '').localeCompare(a.m.updated_at || '')).slice(0, 40);
  }, [meetings, query]);
  const folderHits = query ? folders.filter(f => f.name.toLowerCase().includes(query)) : [];
  const actionHits = query ? actions.filter(a => (a.title + ' ' + a.keywords).toLowerCase().includes(query)) : actions;
  const recent = useMemo(() => [...meetings].filter(m => !m.archived).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, 5), [meetings]);

  return (
    <div className="phone-page phone-search">
      <header className="phone-head">
        <h1>Search</h1>
      </header>
      <form className="phone-search-field" role="search" onSubmit={e => (e.preventDefault(), input.current?.blur())}>
        <Search size={18} />
        <input ref={input} type="search" enterKeyHint="search" placeholder="Search" aria-label="Search" value={q} onChange={e => setQ(e.target.value)} />
        {q && (
          <button type="button" className="phone-clear" aria-label="Clear" onClick={() => (setQ(''), input.current?.focus())}>
            <X size={16} />
          </button>
        )}
      </form>

      {folderHits.length > 0 && (
        <div className="chip-scroll">
          {folderHits.map(f => (
            <button key={f.id} type="button" className="fchip" style={folderVars(f)} onClick={() => onOpenFolder(f.id)}>
              <FolderGlyph folder={f} size={15} /> {f.name}
            </button>
          ))}
        </div>
      )}

      {query ? (
        results.length ? (
          <section className="phone-group">
            <h2 className="phone-group-label">Meetings</h2>
            <ul className="prows">
              {results.map(({ m, ex }) => {
                const f = m.folder_id ? byId.get(m.folder_id) : undefined;
                return (
                  <li key={m.id} className="prow-item">
                    <button type="button" className="prow" data-meeting={m.id} onClick={() => onOpen(m.id, q.trim())} style={f ? folderVars(f) : undefined}>
                      <span className="prow-top">
                        <strong className="truncate">{m.title || 'Untitled meeting'}</strong>
                        <span className="prow-when">{relativeDay(m.created_at || m.updated_at)}</span>
                      </span>
                      {ex && (
                        <span className="prow-snippet">
                          {ex.before}
                          <mark>{ex.hit}</mark>
                          {ex.after}
                        </span>
                      )}
                      {(f || m.archived) && (
                        <span className="prow-tags">
                          {f && (
                            <span className="prow-folder">
                              <FolderGlyph folder={f} size={13} /> <span className="truncate">{f.name}</span>
                            </span>
                          )}
                          {m.archived && (
                            <span className="prow-folder">
                              <Archive size={13} /> Archived
                            </span>
                          )}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (
          !folderHits.length && !actionHits.length && <p className="phone-empty muted">Nothing matches “{q.trim()}”.</p>
        )
      ) : (
        recent.length > 0 && (
          <section className="phone-group">
            <h2 className="phone-group-label">Recent</h2>
            <ul className="prows">
              {recent.map(m => (
                <li key={m.id} className="prow-item">
                  <button type="button" className="prow compact" data-meeting={m.id} onClick={() => onOpen(m.id, '')}>
                    <span className="prow-top">
                      <strong className="truncate">{m.title || 'Untitled meeting'}</strong>
                      <span className="prow-when">{relativeDay(m.updated_at)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      )}

      {actionHits.length > 0 && (
        <section className="phone-group">
          <h2 className="phone-group-label">Actions</h2>
          <div className="phone-list">
            {actionHits.map(a => (
              <button key={a.id} type="button" className="phone-list-item" onClick={a.run}>
                {a.icon}
                <span>{a.title}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------- settings extras */

/** Phone-only rows under Settings: switch layouts, lock. */
export function PhoneSettingsFooter({ onDesktop, onLock }: { onDesktop: () => void; onLock: () => void }) {
  return (
    <section className="phone-group phone-settings-footer">
      <div className="phone-list">
        <button type="button" className="phone-list-item" onClick={onDesktop}>
          <Monitor size={19} />
          <span>Desktop layout</span>
        </button>
        <button type="button" className="phone-list-item" onClick={onLock}>
          <Lock size={19} />
          <span>Lock notebook</span>
        </button>
      </div>
    </section>
  );
}

const isNoteEditor = (t: EventTarget | null) => t instanceof HTMLTextAreaElement && t.classList.contains('note-editor');

/** Adds body.phone-typing while a note's text box has focus, so everything but the note can step aside.
 *  Browsers send no blur when a focused box is removed (leaving the meeting mid-typing), so the class is
 *  also re-checked whenever the page changes (`routeKey`) — otherwise the recorder bar and top-bar
 *  buttons would stay hidden everywhere. */
export function usePhoneTyping(active: boolean, routeKey: string) {
  useEffect(() => {
    if (!active) return;
    const on = (e: FocusEvent) => isNoteEditor(e.target) && document.body.classList.add('phone-typing');
    const off = (e: FocusEvent) => isNoteEditor(e.target) && !isNoteEditor(e.relatedTarget) && document.body.classList.remove('phone-typing');
    document.addEventListener('focusin', on);
    document.addEventListener('focusout', off);
    return () => {
      document.removeEventListener('focusin', on);
      document.removeEventListener('focusout', off);
      document.body.classList.remove('phone-typing');
    };
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const sync = () => document.body.classList.toggle('phone-typing', isNoteEditor(document.activeElement) && document.activeElement!.isConnected);
    sync();
    // The old page's text box may unmount a frame later (route transitions); check once more.
    const raf = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(raf);
  }, [active, routeKey]);
}

export type SaveState = { status: string; tone: 'good' | 'pending' | 'bad' };

/** The save state of a meeting's editors, worst first: a failure, then saving, then saved. */
export function useSaveState(meetingId: string | null): SaveState | null {
  const [all, setAll] = useState<Record<string, SaveState & { meeting: string }>>({});
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { key: string; meeting: string; status?: string; tone?: SaveState['tone']; gone?: boolean };
      setAll(prev => {
        const next = { ...prev };
        if (d.gone) delete next[d.key];
        else next[d.key] = { meeting: d.meeting, status: d.status || '', tone: d.tone || 'good' };
        return next;
      });
    };
    window.addEventListener('huh:save-state', on);
    return () => window.removeEventListener('huh:save-state', on);
  }, []);
  const mine = Object.values(all).filter(x => x.meeting === meetingId);
  if (!mine.length) return null;
  const bad = mine.find(x => x.tone === 'bad');
  if (bad) return { status: bad.status, tone: 'bad' };
  if (mine.some(x => x.tone === 'pending')) return { status: mine.some(x => x.status === 'Saving…') ? 'Saving…' : 'Edited', tone: 'pending' };
  return { status: 'Saved', tone: 'good' };
}

/** body.phone-scrolled once a page has scrolled past its big title, so the top bar can show the title instead. */
export function usePhoneScrolled(active: boolean, pageKey: string) {
  useEffect(() => {
    document.body.classList.remove('phone-scrolled');
    if (!active) return;
    const on = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.classList?.contains('page')) document.body.classList.toggle('phone-scrolled', t.scrollTop > 64);
    };
    document.addEventListener('scroll', on, true);
    return () => {
      document.removeEventListener('scroll', on, true);
      document.body.classList.remove('phone-scrolled');
    };
  }, [active, pageKey]);
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Archive, ArchiveRestore, ArrowLeft, AudioLines, BookOpen, Check, ChevronRight, Download, FileAudio, FileText, FolderOpen, History, LayoutDashboard, LayoutTemplate, Ellipsis, ExternalLink, FolderInput, FolderPlus, Lock, Maximize2, Mic, NotebookPen, PanelLeftClose, PanelLeftOpen, Palette, Pencil, Plus, Search, Settings as SettingsIcon, Sparkles, TextSearch, Trash2, X } from 'lucide-react';
import { api, errorText, Folder, Meeting, send, Settings as SettingsT, Template } from './api';
import Recorder from './Recorder';
import Settings, { SettingsSection } from './Settings';
import MeetingView, { MeetingRequest as Req, runMeetingCommand } from './Meeting';
import CommandPalette, { Command, CommandSection } from './CommandPalette';
import { defaultTitle } from './format';
import { forgetMeeting } from './queue';

type MeetingRequest = Req & { meetingId: string };
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
import Dashboard from './Dashboard';
import FolderPage from './FolderPage';
import { FolderDialog, FolderDraft, FolderGlyph, folderVars, nextFolderColor } from './folders';
import { Callout, ConfirmDialog, ContextMenu, cx, MenuItem, Modal, Spinner, ToastProvider, useToast } from './ui';
import './style.css';

type Auth = { authenticated: boolean; setup_required: boolean };

/** Where the user is. Each change is a browser-history entry, so Back (in-app, browser, mouse, Alt+←) retraces it. */
type View = { page: 'home' } | { page: 'folder'; id: string } | { page: 'meeting'; id: string } | { page: 'settings'; section: SettingsSection };
/** The page above v: a meeting's folder (if it's filed and not archived), otherwise Home. */
function parentIn(v: View, meetings: Meeting[], folders: Folder[]): View {
  if (v.page === 'meeting') {
    const m = meetings.find(x => x.id === v.id);
    if (m?.folder_id && !m.archived && folders.some(f => f.id === m.folder_id)) return { page: 'folder', id: m.folder_id };
  }
  return { page: 'home' };
}
const sameView = (a: View, b: View) =>
  a.page === b.page && (a.page === 'folder' || a.page === 'meeting' ? a.id === (b as typeof a).id : true);

/** Which sidebar sections are folded away; a per-device convenience. */
type Folding = { closed: string[]; archiveOpen: boolean };
const FOLDING_KEY = 'huh:sidebar-folding';
function readFolding(): Folding {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDING_KEY) || '{}');
    return { closed: Array.isArray(v.closed) ? v.closed : [], archiveOpen: !!v.archiveOpen };
  } catch {
    return { closed: [], archiveOpen: false };
  }
}
/** Whether the sidebar is shown on wide screens (Ctrl/⌘ + B); a per-device convenience. */
const SIDEBAR_KEY = 'huh:sidebar-open';
function readSidebar(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== '0';
  } catch {
    return true;
  }
}
/** Below this width the sidebar is a drawer over the page instead of a column. */
const NARROW = '(max-width: 820px)';
const narrowQuery = () => window.matchMedia(NARROW).matches;
function useNarrow() {
  const [narrow, setNarrow] = useState(narrowQuery);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}
const DRAG_TYPE = 'application/x-huh-meeting';
/** Drop targets: a folder id, or one of these. */
const UNFILED = '__unfiled';
const ARCHIVE = '__archive';

function groupLabel(date: Date) {
  const today = new Date();
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(today) - start(date)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  if (days < 31) return 'This month';
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function Login({ auth, onDone }: { auth: Auth | null; onDone: (a: Auth) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const setup = !!auth?.setup_required;
  return (
    <main className="auth-screen">
      <div className="auth-card">
        <div className="brand large">
          <BookOpen size={26} /> huh
        </div>
        <h1>{setup ? 'Set up your notebook' : 'Welcome back'}</h1>
        <p className="muted">{setup ? 'Create a password to protect your meetings. You’ll use it on every device.' : 'Enter your password to open your meeting notebook.'}</p>
        <form
          className="stack"
          onSubmit={async e => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              await send(setup ? '/auth/setup' : '/auth/login', { password });
              setPassword('');
              onDone(await api('/auth/status'));
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <input
            type="password"
            aria-label="Password"
            placeholder={setup ? 'New password (at least 12 characters)' : 'Password'}
            required
            minLength={setup ? 12 : 1}
            autoFocus
            autoComplete={setup ? 'new-password' : 'current-password'}
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
          <button className="primary block" disabled={busy || !auth}>
            {busy && <Spinner size={15} />} {setup ? 'Create notebook' : 'Unlock'}
          </button>
        </form>
        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </main>
  );
}

function App() {
  const toast = useToast();
  const [auth, setAuth] = useState<Auth | null>(null);
  const [authError, setAuthError] = useState('');
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<'home' | 'folder' | 'meeting' | 'settings'>('home');
  const [folderPage, setFolderPage] = useState<string | null>(null);
  const [section, setSection] = useState<SettingsSection>('ai');
  const query = '';
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [request, setRequest] = useState<MeetingRequest | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(readSidebar);
  const narrow = useNarrow();
  const [refreshKey, setRefreshKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [noteLanguage, setNoteLanguage] = useState('auto');
  const [views, setViews] = useState<{ notes: 'write' | 'preview'; ai: 'write' | 'preview' }>({ notes: 'write', ai: 'preview' });
  /** What Back does (Settings → Notes & navigation): "up" a level, or to the previously visited page. */
  const [backMode, setBackMode] = useState<'up' | 'history'>('up');
  const backModeRef = useRef(backMode);
  backModeRef.current = backMode;
  /** The meeting actions menu; `page` when opened from a row on Home or a folder page (rename then uses a dialog). */
  const [menu, setMenu] = useState<{ meeting: Meeting; x: number; y: number; page?: boolean } | null>(null);
  const [renameDialog, setRenameDialog] = useState<{ id: string; title: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<Meeting | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folding, setFolding] = useState<Folding>(readFolding);
  const [folderDialog, setFolderDialog] = useState<{ folder: Folder | null } | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<{ id: string; name: string } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ folder: Folder; x: number; y: number } | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<Folder | null>(null);
  const [moving, setMoving] = useState<Meeting | null>(null);
  const [movingNew, setMovingNew] = useState('');
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Views by history index, mirroring the browser's entries for this session. */
  const entries = useRef<View[]>([{ page: 'home' }]);
  const [histIndex, setHistIndex] = useState(0);
  const histIndexRef = useRef(0);
  histIndexRef.current = histIndex;
  const meetingsRef = useRef<Meeting[] | null>(null);
  const foldersRef = useRef<Folder[] | null>(null);
  const applySettings = useCallback(
    (s: SettingsT) => {
      setViews({ notes: s.notes_view === 'preview' ? 'preview' : 'write', ai: s.ai_notes_view === 'write' ? 'write' : 'preview' });
      setBackMode(s.back_behavior === 'history' ? 'history' : 'up');
      setNoteLanguage(s.output_language || 'auto');
    },
    [],
  );

  const reloadMeetings = useCallback(async () => {
    const list = await api<Meeting[]>('/meetings');
    meetingsRef.current = list;
    setMeetings(list);
  }, []);
  const reloadTemplates = useCallback(async () => setTemplates(await api<Template[]>('/templates')), []);
  const reloadFolders = useCallback(async () => {
    const list = await api<Folder[]>('/folders');
    foldersRef.current = list;
    setFolders(list);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(FOLDING_KEY, JSON.stringify(folding));
    } catch {}
  }, [folding]);
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? '1' : '0');
    } catch {}
  }, [sidebarOpen]);
  /** Collapse/expand the sidebar column; on narrow screens, open/close the drawer instead. */
  const toggleSidebar = useCallback(() => {
    if (narrowQuery()) setDrawer(d => !d);
    else setSidebarOpen(o => !o);
  }, []);

  /** Shows a view without touching history. */
  const show = useCallback((v: View) => {
    if (v.page === 'meeting') setSelected(v.id);
    if (v.page === 'folder') setFolderPage(v.id);
    if (v.page === 'settings') setSection(v.section);
    setPage(v.page);
    setDrawer(false);
  }, []);

  useEffect(() => {
    window.history.replaceState({ huh: { page: 'home' }, i: 0 }, '');
    const onPop = (e: PopStateEvent) => {
      const v: View | undefined = e.state?.huh;
      const i: number = typeof e.state?.i === 'number' ? e.state.i : 0;
      let target: View = v || { page: 'home' };
      // "Up" mode: any back step (browser, mouse, Alt+←, or our button) lands on the parent of the page being left.
      if (backModeRef.current === 'up' && i < histIndexRef.current) {
        const leaving = entries.current[histIndexRef.current] || { page: 'home' };
        target = parentIn(leaving, meetingsRef.current || [], foldersRef.current || []);
      }
      // Something deleted since: land on Home instead of a dead page.
      if (target.page === 'meeting' && meetingsRef.current && !meetingsRef.current.some(m => m.id === (target as { id: string }).id)) target = { page: 'home' };
      if (target.page === 'folder' && foldersRef.current && !foldersRef.current.some(f => f.id === (target as { id: string }).id)) target = { page: 'home' };
      if (target !== v) window.history.replaceState({ huh: target, i }, '');
      entries.current[i] = target;
      setHistIndex(i);
      setRequest(null);
      show(target);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [show]);

  useEffect(() => {
    api<Auth>('/auth/status')
      .then(setAuth)
      .catch(e => setAuthError(errorText(e)));
  }, []);
  useEffect(() => {
    if (!auth?.authenticated) return;
    Promise.all([reloadMeetings(), reloadTemplates(), reloadFolders()]).catch(e => toast(errorText(e), 'error'));
    api<SettingsT>('/settings')
      .then(applySettings)
      .catch(() => {});
    const timer = setInterval(() => void reloadMeetings().catch(() => {}), 15000);
    return () => clearInterval(timer);
  }, [auth?.authenticated, reloadMeetings, reloadTemplates, reloadFolders, toast, applySettings]);

  useEffect(() => {
    if (!auth?.authenticated) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || document.body.classList.contains('focus-active')) return;
      const k = e.code;
      if (k === 'KeyB') {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (k === 'KeyK') {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [auth?.authenticated, toggleSidebar]);

  // Archived meetings live only in the Archive section; meetings in a folder only under that folder.
  const { byFolder, unfiled, archived } = useMemo(() => {
    const ids = new Set(folders.map(f => f.id));
    const byFolder = new Map<string, Meeting[]>(folders.map(f => [f.id, []]));
    const unfiled: Meeting[] = [];
    const archived: Meeting[] = [];
    for (const m of meetings) {
      if (m.archived) archived.push(m);
      else if (m.folder_id && ids.has(m.folder_id)) byFolder.get(m.folder_id)!.push(m);
      else unfiled.push(m);
    }
    return { byFolder, unfiled, archived };
  }, [meetings, folders]);
  const active = useMemo(() => meetings.filter(m => !m.archived), [meetings]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = unfiled.filter(m => !q || (m.title + ' ' + m.notes).toLowerCase().includes(q));
    const out: { label: string; items: Meeting[] }[] = [];
    for (const m of list) {
      const label = groupLabel(new Date(m.created_at || m.updated_at));
      const g = out.find(x => x.label === label);
      if (g) g.items.push(m);
      else out.push({ label, items: [m] });
    }
    return out;
  }, [unfiled, query]);

  if (!auth?.authenticated)
    return authError ? (
      <main className="auth-screen">
        <div className="auth-card">
          <Callout tone="bad">{authError}</Callout>
        </div>
      </main>
    ) : (
      <Login auth={auth} onDone={setAuth} />
    );

  const here = entries.current[histIndex] || { page: 'home' };

  /** Go somewhere new: adds a history entry (or replaces the current one). */
  function go(v: View, replace = false) {
    if (!replace && sameView(here, v) && !(v.page === 'settings' && here.page === 'settings' && v.section !== here.section)) {
      show(v);
      return;
    }
    const i = replace ? histIndex : histIndex + 1;
    entries.current = [...entries.current.slice(0, i), v];
    window.history[replace ? 'replaceState' : 'pushState']({ huh: v, i }, '');
    setHistIndex(i);
    show(v);
  }

  /** The page above this one: meeting → its folder → Home. */
  const parentOf = (v: View) => parentIn(v, meetings, folders);

  function viewLabel(v: View): string {
    if (v.page === 'home') return 'Home';
    if (v.page === 'settings') return 'Settings';
    if (v.page === 'folder') return folders.find(f => f.id === v.id)?.name || 'Folder';
    return meetings.find(m => m.id === v.id)?.title || 'Untitled meeting';
  }

  /** Where this page sits: Home › folder › meeting. */
  function trail(v: View): { label: string; view: View }[] {
    const out: { label: string; view: View }[] = [{ label: 'Home', view: { page: 'home' } }];
    const parent = parentOf(v);
    if (parent.page === 'folder') out.push({ label: viewLabel(parent), view: parent });
    if (v.page !== 'home') out.push({ label: viewLabel(v), view: v });
    return out;
  }

  /** Back one step in history; with no history this session (e.g. after a reload), up to the parent page. */
  function back() {
    if (histIndex > 0) window.history.back();
    else go(parentOf(here), true);
  }

  /** Leave a page whose subject was just deleted. */
  function leave() {
    if (histIndex > 0) window.history.back();
    else go({ page: 'home' }, true);
  }

  function open(id: string) {
    setRequest(null);
    go({ page: 'meeting', id });
  }

  async function newMeeting(title?: string, importAfter = false, folderId?: string) {
    setCreating(true);
    try {
      const m = await send<Meeting>('/meetings', { title: title ?? defaultTitle(new Date()), ...(folderId ? { folder_id: folderId } : {}) });
      await reloadMeetings();
      open(m.id);
      // The recorder owns the import dialog; open it once it follows the new meeting.
      if (importAfter) setTimeout(() => window.dispatchEvent(new Event('huh:import-audio')), 60);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setCreating(false);
    }
  }

  const goHome = () => go({ page: 'home' });

  function openFolder(id: string) {
    go({ page: 'folder', id });
    setFolding(f => (f.closed.includes(id) ? { ...f, closed: f.closed.filter(x => x !== id) } : f));
  }

  const openSettings = (s: SettingsSection = section) => go({ page: 'settings', section: s });
  /** Switching settings sections stays one history entry. */
  const switchSection = (s: SettingsSection) => go({ page: 'settings', section: s }, true);

  const current = meetings.find(m => m.id === selected);
  const openFolderObj = folders.find(f => f.id === folderPage);

  async function rename(id: string, title: string) {
    setRenaming(null);
    const m = meetings.find(x => x.id === id);
    if (!m || title.trim() === m.title) return;
    try {
      await send(`/meetings/${id}`, { title: title.trim() || 'Untitled meeting' }, 'PATCH');
      await reloadMeetings();
      setRefreshKey(k => k + 1);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api(`/meetings/${deleting.id}`, { method: 'DELETE' });
      await forgetMeeting(deleting.id).catch(() => {});
      if (selected === deleting.id && page === 'meeting') leave();
      toast(`Deleted “${deleting.title || 'Untitled meeting'}”.`);
      setDeleting(null);
      await reloadMeetings();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setDeleteBusy(false);
    }
  }

  /** Files and/or archives a meeting. Organising never touches the meeting's content. */
  async function organize(m: Meeting, change: { folder_id?: string | null; archived?: boolean }, message?: string) {
    try {
      await send(`/meetings/${m.id}`, change, 'PATCH');
      await reloadMeetings();
      setRefreshKey(k => k + 1);
      if (message) toast(message);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
  const name = (m: Meeting) => `“${m.title || 'Untitled meeting'}”`;
  const folderName = (id: string | null) => folders.find(f => f.id === id)?.name;
  const archive = (m: Meeting) => organize(m, { archived: true }, `Archived ${name(m)}. It’s still searchable, listed after everything else.`);
  const unarchive = (m: Meeting) =>
    organize(m, { archived: false }, `Restored ${name(m)}${folderName(m.folder_id) ? ` to ${folderName(m.folder_id)}` : ''}.`);
  const moveTo = (m: Meeting, folderId: string | null) =>
    organize(m, { folder_id: folderId, ...(m.archived ? { archived: false } : {}) }, folderId ? `Moved ${name(m)} to ${folderName(folderId)}.` : `Moved ${name(m)} out of its folder.`);

  const organizeActions = (m: Meeting): MenuItem[] => [
    { label: 'Move to folder…', icon: <FolderInput size={15} />, onSelect: () => openMove(m) },
    m.archived
      ? { label: 'Restore from archive', icon: <ArchiveRestore size={15} />, onSelect: () => void unarchive(m) }
      : { label: 'Archive', hint: 'Keep it, but out of the way', icon: <Archive size={15} />, onSelect: () => void archive(m) },
  ];
  const meetingActions = (m: Meeting, fromPage = false): MenuItem[] => [
    { label: 'Open', icon: <ExternalLink size={15} />, onSelect: () => open(m.id) },
    {
      label: 'Rename',
      icon: <Pencil size={15} />,
      onSelect: () => (fromPage ? setRenameDialog({ id: m.id, title: m.title }) : setRenaming({ id: m.id, title: m.title })),
    },
    ...organizeActions(m),
    { label: 'Export as Markdown', icon: <Download size={15} />, onSelect: () => window.open(`/api/meetings/${m.id}/export?format=md`, '_blank') },
    'divider',
    { label: 'Delete…', icon: <Trash2 size={15} />, danger: true, onSelect: () => setDeleting(m) },
  ];

  function openMove(m: Meeting) {
    setMovingNew('');
    setMoving(m);
  }

  async function createFolder(label: string) {
    const trimmed = label.trim();
    if (!trimmed) return null;
    try {
      const f = await send<Folder>('/folders', { name: trimmed, color: nextFolderColor(folders) });
      await reloadFolders();
      return f;
    } catch (e) {
      toast(errorText(e), 'error');
      return null;
    }
  }

  async function renameFolder(id: string, label: string) {
    setRenamingFolder(null);
    const f = folders.find(x => x.id === id);
    if (!f || !label.trim() || label.trim() === f.name) return;
    try {
      await send(`/folders/${id}`, { name: label.trim() }, 'PATCH');
      await reloadFolders();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  /** Create a folder, or save a folder's name, colour and icon, from the folder dialog. */
  async function saveFolder(draft: FolderDraft) {
    const editing = folderDialog?.folder;
    try {
      if (editing) {
        await send(`/folders/${editing.id}`, draft, 'PATCH');
        await reloadFolders();
      } else {
        const f = await send<Folder>('/folders', draft);
        await reloadFolders();
        toast(`Created “${f.name}”. Drag meetings onto it in the sidebar, or start one inside it.`);
        openFolder(f.id);
      }
      return true;
    } catch (e) {
      toast(errorText(e), 'error');
      return false;
    }
  }

  const folderActions = (f: Folder, opts: { open?: boolean; rename?: boolean } = {}): MenuItem[] => [
    ...(opts.open ? [{ label: 'Open folder', icon: <FolderOpen size={15} />, onSelect: () => openFolder(f.id) }] : []),
    { label: 'New meeting here', icon: <Plus size={15} />, onSelect: () => void newMeeting(undefined, false, f.id) },
    { label: 'Import recording here', icon: <FileAudio size={15} />, onSelect: () => void newMeeting(undefined, true, f.id) },
    { label: 'Customize…', hint: 'Name, colour and icon', icon: <Palette size={15} />, onSelect: () => setFolderDialog({ folder: f }) },
    ...(opts.rename ? [{ label: 'Rename', icon: <Pencil size={15} />, onSelect: () => setRenamingFolder({ id: f.id, name: f.name }) }] : []),
    'divider',
    { label: 'Delete folder…', icon: <Trash2 size={15} />, danger: true, onSelect: () => setDeletingFolder(f) },
  ];

  async function confirmDeleteFolder() {
    if (!deletingFolder) return;
    try {
      await api(`/folders/${deletingFolder.id}`, { method: 'DELETE' });
      toast(`Deleted the folder “${deletingFolder.name}”. Its meetings are back in the main list.`);
      if (page === 'folder' && folderPage === deletingFolder.id) leave();
      setDeletingFolder(null);
      await Promise.all([reloadFolders(), reloadMeetings()]);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  const toggleFolder = (id: string) =>
    setFolding(f => ({ ...f, closed: f.closed.includes(id) ? f.closed.filter(x => x !== id) : [...f.closed, id] }));

  /** Drag a meeting onto a folder, the main list or the archive. */
  const dropZone = (target: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget(target);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(t => (t === target ? null : t));
    },
    onDrop: (e: React.DragEvent) => {
      const id = e.dataTransfer.getData(DRAG_TYPE);
      setDropTarget(null);
      setDragging(false);
      const m = meetings.find(x => x.id === id);
      if (!m) return;
      e.preventDefault();
      e.stopPropagation();
      if (target === ARCHIVE) {
        if (!m.archived) void archive(m);
      } else {
        const folderId = target === UNFILED ? null : target;
        if (m.archived || (m.folder_id || null) !== folderId) void moveTo(m, folderId);
      }
    },
  });

  const row = (m: Meeting) =>
    renaming?.id === m.id ? (
      <div key={m.id} className="meeting-row renaming">
        <input
          autoFocus
          aria-label="Rename meeting"
          value={renaming.title}
          onFocus={e => e.target.select()}
          onChange={e => setRenaming({ id: m.id, title: e.target.value })}
          onBlur={() => void rename(m.id, renaming.title)}
          onKeyDown={e => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setRenaming(null);
          }}
        />
      </div>
    ) : (
      <div
        key={m.id}
        className={cx('meeting-row', menu?.meeting.id === m.id && 'menu-open')}
        onContextMenu={e => {
          e.preventDefault();
          setMenu({ meeting: m, x: e.clientX, y: e.clientY });
        }}
      >
        <button
          type="button"
          draggable
          onDragStart={e => {
            e.dataTransfer.setData(DRAG_TYPE, m.id);
            e.dataTransfer.effectAllowed = 'move';
            // Reveal the archive drop zone after the drag has started; changing the DOM synchronously can cancel it.
            setTimeout(() => setDragging(true));
          }}
          onDragEnd={() => {
            setDragging(false);
            setDropTarget(null);
          }}
          className={cx('meeting-link', selected === m.id && page === 'meeting' && 'selected')}
          onClick={() => open(m.id)}
        >
          <span className="truncate">{m.title || 'Untitled meeting'}</span>
          <small>
            {new Date(m.created_at || m.updated_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            {m.status === 'recording' && (
              <span className="live-dot" title="Recording">
                <Mic size={11} />
              </span>
            )}
          </small>
        </button>
        <button
          type="button"
          className="icon-button row-menu"
          aria-label={`Actions for ${m.title || 'Untitled meeting'}`}
          onClick={e => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ meeting: m, x: r.left, y: r.bottom });
          }}
        >
          <Ellipsis size={16} />
        </button>
      </div>
    );

  const canGoBack = here.page !== 'home' || (backMode === 'history' && histIndex > 0);
  const backLabel = viewLabel(backMode === 'history' && histIndex > 0 ? entries.current[histIndex - 1] : parentOf(here));

  async function lock() {
    try {
      await send('/auth/logout');
      setAuth(await api('/auth/status'));
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  /** Everything Ctrl/⌘ + K can find or do, given where the user is. Built only while the palette is open. */
  const palette = ((): { commands: Command[]; suggestions: CommandSection[] } => {
    if (!paletteOpen) return { commands: [], suggestions: [] };
    const keys = isMac ? { find: '⌘F', focus: '⇧⌘F', sidebar: '⌘B', back: '⌘[' } : { find: 'Ctrl+F', focus: 'Ctrl+Shift+F', sidebar: 'Ctrl+B', back: 'Alt+←' };
    const label = (m: Meeting) => m.title || 'Untitled meeting';
    const when = (m: Meeting) => new Date(m.created_at || m.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const thisMeeting = page === 'meeting' ? current : undefined;
    const thisFolder = page === 'folder' ? openFolderObj : undefined;

    // Actions for the page you're on: listed first when nothing's typed, and nudged up when they match
    // (so on a meeting, “transcript” finds Show transcript before the Transcription settings page).
    const CONTEXT_BOOST = 20;
    const context: Command[] = [];
    if (thisMeeting) {
      const m = thisMeeting;
      const tab = (id: 'notes' | 'enhanced' | 'transcript' | 'history', title: string, icon: React.ReactNode, keywords: string[]): Command => ({
        id: `m-tab-${id}`,
        kind: 'action',
        title,
        subtitle: label(m),
        keywords: ['tab', ...keywords],
        icon,
        boost: CONTEXT_BOOST,
        run: () => setRequest({ meetingId: m.id, tab: id, n: Date.now() }),
      });
      context.push(
        { id: 'm-find', kind: 'action', title: 'Find in this meeting', subtitle: 'Search the open tab', keywords: ['search', 'find in page'], icon: <TextSearch size={16} />, shortcut: keys.find, boost: CONTEXT_BOOST, run: () => runMeetingCommand('find') },
        { id: 'm-focus', kind: 'action', title: 'Focus mode', subtitle: 'Write your notes full screen', keywords: ['zen', 'distraction free', 'fullscreen', 'write'], icon: <Maximize2 size={16} />, shortcut: keys.focus, boost: CONTEXT_BOOST, run: () => runMeetingCommand('focus') },
        { id: 'm-rename', kind: 'action', title: 'Rename this meeting', keywords: ['title', 'name'], icon: <Pencil size={16} />, boost: CONTEXT_BOOST, run: () => setRenameDialog({ id: m.id, title: m.title }) },
        { id: 'm-move', kind: 'action', title: 'Move this meeting to a folder…', keywords: ['file', 'organize'], icon: <FolderInput size={16} />, boost: CONTEXT_BOOST, run: () => openMove(m) },
        m.archived
          ? { id: 'm-unarchive', kind: 'action', title: 'Restore this meeting from the archive', keywords: ['unarchive'], icon: <ArchiveRestore size={16} />, boost: CONTEXT_BOOST, run: () => void unarchive(m) }
          : { id: 'm-archive', kind: 'action', title: 'Archive this meeting', subtitle: 'Keep it, but out of the way', keywords: ['hide'], icon: <Archive size={16} />, boost: CONTEXT_BOOST, run: () => void archive(m) },
        { id: 'm-export', kind: 'action', title: 'Export this meeting as Markdown', keywords: ['download', 'md', 'save'], icon: <Download size={16} />, boost: CONTEXT_BOOST, run: () => window.open(`/api/meetings/${m.id}/export?format=md`, '_blank') },
        { id: 'm-import', kind: 'action', title: 'Import a recording into this meeting', keywords: ['upload', 'audio', 'voice memo', 'm4a', 'file'], icon: <FileAudio size={16} />, boost: CONTEXT_BOOST, run: () => window.dispatchEvent(new Event('huh:import-audio')) },
        tab('notes', 'Show my notes', <FileText size={16} />, ['notes']),
        tab('enhanced', 'Show AI notes', <Sparkles size={16} />, ['enhanced', 'summary']),
        tab('transcript', 'Show transcript', <AudioLines size={16} />, ['audio', 'recording']),
        tab('history', 'Show version history', <History size={16} />, ['versions', 'older']),
        { id: 'm-delete', kind: 'action', title: 'Delete this meeting…', keywords: ['remove', 'trash'], icon: <Trash2 size={16} />, danger: true, run: () => setDeleting(m) },
      );
    } else if (thisFolder) {
      const f = thisFolder;
      context.push(
        { id: 'f-new', kind: 'action', title: `New meeting in ${f.name}`, keywords: ['create', 'start', 'add'], icon: <Plus size={16} />, boost: CONTEXT_BOOST, run: () => void newMeeting(undefined, false, f.id) },
        { id: 'f-import', kind: 'action', title: `Import a recording into ${f.name}`, keywords: ['upload', 'audio', 'voice memo', 'm4a', 'file'], icon: <FileAudio size={16} />, boost: CONTEXT_BOOST, run: () => void newMeeting(undefined, true, f.id) },
        { id: 'f-customize', kind: 'action', title: 'Customize this folder…', subtitle: 'Name, colour and icon', keywords: ['rename', 'color', 'colour', 'icon'], icon: <Palette size={16} />, boost: CONTEXT_BOOST, run: () => setFolderDialog({ folder: f }) },
        { id: 'f-delete', kind: 'action', title: 'Delete this folder…', subtitle: 'Its meetings move back to the main list', keywords: ['remove', 'trash'], icon: <Trash2 size={16} />, danger: true, run: () => setDeletingFolder(f) },
      );
    }

    const sidebarShown = narrow ? drawer : sidebarOpen;
    const actions: Command[] = [
      { id: 'new', kind: 'action', title: 'New meeting', subtitle: 'Start a blank meeting', boost: 3, keywords: ['create', 'start', 'add', 'note', 'record'], icon: <Plus size={16} />, run: () => void newMeeting() },
      { id: 'import', kind: 'action', title: 'Import a recording', subtitle: 'New meeting from an audio file or Voice Memo', keywords: ['upload', 'audio', 'voice memo', 'm4a', 'file', 'new'], icon: <FileAudio size={16} />, run: () => void newMeeting(undefined, true) },
      { id: 'new-folder', kind: 'action', title: 'New folder', keywords: ['create', 'add', 'organize'], icon: <FolderPlus size={16} />, run: () => setFolderDialog({ folder: null }) },
      { id: 'home', kind: 'action', title: 'Go to Home', subtitle: 'Dashboard, to-dos and recent meetings', keywords: ['dashboard', 'todo'], icon: <LayoutDashboard size={16} />, run: goHome },
      ...(canGoBack && backLabel !== 'Home' ? [{ id: 'back', kind: 'action' as const, title: `Go back to ${backLabel}`, keywords: ['previous', 'return'], icon: <ArrowLeft size={16} />, shortcut: keys.back, run: back }] : []),
      { id: 'settings', kind: 'action', title: 'Open settings', keywords: ['preferences', 'options', 'configure'], icon: <SettingsIcon size={16} />, run: () => openSettings() },
      { id: 'sidebar', kind: 'action', title: sidebarShown ? 'Hide sidebar' : 'Show sidebar', keywords: ['toggle', 'panel', 'collapse', 'expand', 'menu'], icon: sidebarShown ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />, shortcut: keys.sidebar, run: toggleSidebar },
      { id: 'lock', kind: 'action', title: 'Lock notebook', subtitle: 'Sign out on this device', keywords: ['log out', 'logout', 'sign out'], icon: <Lock size={16} />, run: () => void lock() },
    ];

    const settingsPages: Command[] = (
      [
        ['ai', 'AI notes', 'Provider, model and output language', <Sparkles size={16} />, ['llm', 'model', 'provider', 'api key', 'language', 'enhance']],
        ['transcription', 'Transcription', 'Local speech model, language and device', <AudioLines size={16} />, ['speech', 'whisper', 'stt', 'gpu', 'cuda', 'language']],
        ['templates', 'Templates', 'Formats for notes and AI notes', <LayoutTemplate size={16} />, ['format', 'manage templates']],
        ['notes', 'Notes & navigation', 'Editor, Back button, shortcuts', <NotebookPen size={16} />, ['editor', 'back button', 'keyboard', 'shortcuts', 'write', 'preview']],
      ] as [SettingsSection, string, string, React.ReactNode, string[]][]
    ).map(([id, title, hint, icon, keywords]) => ({ id: `settings-${id}`, kind: 'setting', title, subtitle: `Settings · ${hint}`, keywords: ['settings', 'preferences', ...keywords], icon, run: () => openSettings(id) }));

    const folderItems: Command[] = folders.map(f => {
      const count = byFolder.get(f.id)?.length || 0;
      return { id: `folder-${f.id}`, kind: 'folder', title: f.name, subtitle: count ? `${count} meeting${count === 1 ? '' : 's'}` : 'Empty', keywords: ['folder'], icon: <FolderGlyph folder={f} size={16} />, run: () => openFolder(f.id) };
    });

    const meetingItem = (m: Meeting): Command => {
      const fname = m.folder_id ? folderName(m.folder_id) : undefined;
      return {
        id: `meeting-${m.id}`,
        kind: 'meeting',
        title: label(m),
        subtitle: [fname, when(m), m.status === 'recording' && 'Recording'].filter(Boolean).join(' · '),
        keywords: fname ? [fname] : [],
        archived: m.archived,
        icon: m.status === 'recording' ? <Mic size={16} /> : <FileText size={16} />,
        run: () => open(m.id),
      };
    };

    const recent = [...active]
      .filter(m => m.id !== thisMeeting?.id)
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      .slice(0, 5);
    const pick = (ids: string[]) => ids.map(id => context.find(c => c.id === id)).filter((c): c is Command => !!c);

    return {
      commands: [...context, ...actions, ...folderItems, ...meetings.map(meetingItem), ...settingsPages],
      suggestions: [
        thisMeeting && { label: 'This meeting', items: pick(['m-find', 'm-focus', 'm-rename', 'm-move', 'm-archive', 'm-unarchive', 'm-export']) },
        thisFolder && { label: thisFolder.name, items: context },
        { label: 'Recent meetings', items: recent.map(meetingItem) },
        { label: 'Actions', items: actions.filter(a => ['new', 'import', 'new-folder', 'settings'].includes(a.id)) },
      ].filter((s): s is CommandSection => !!s),
    };
  })();

  return (
    <div className={cx('app', !sidebarOpen && 'sidebar-collapsed')}>
      <div className={cx('drawer-scrim', drawer && 'open')} onClick={() => setDrawer(false)} />
      <aside className={cx('sidebar', drawer && 'open')} inert={narrow ? !drawer : !sidebarOpen}>
        <div className="sidebar-top">
          <button type="button" className="brand brand-button" onClick={goHome} aria-label="huh — go to home">
            <BookOpen size={20} /> huh
          </button>
          <button type="button" className="icon-button drawer-close" aria-label="Close menu" onClick={() => setDrawer(false)}>
            <X size={18} />
          </button>
        </div>
        <button type="button" className="primary block new-meeting" disabled={creating} onClick={() => void newMeeting()}>
          {creating ? <Spinner size={15} /> : <Plus size={17} />} New meeting
        </button>
        <button type="button" className={cx('nav-button', page === 'home' && 'on')} onClick={goHome}>
          <LayoutDashboard size={17} /> Home
        </button>
        <button type="button" className="search-button" title="Jump to a meeting, folder or setting, or run an action" onClick={() => setPaletteOpen(true)}>
          <Search size={15} />
          <span>Search &amp; actions</span>
          <kbd>{isMac ? '⌘' : 'Ctrl'} K</kbd>
        </button>
        <nav className="meeting-list" aria-label="Meetings">
          <div className="section-head">
            <span className="group-label">Folders</span>
            <button type="button" className="icon-button section-add" aria-label="New folder" title="New folder" onClick={() => setFolderDialog({ folder: null })}>
              <FolderPlus size={15} />
            </button>
          </div>
          {folders.map(f => {
            const items = byFolder.get(f.id) || [];
            const isOpen = !folding.closed.includes(f.id);
            return (
              <div key={f.id} className={cx('folder', dropTarget === f.id && 'drop')} {...dropZone(f.id)}>
                {renamingFolder?.id === f.id ? (
                  <div className="meeting-row renaming">
                    <input
                      autoFocus
                      aria-label="Rename folder"
                      maxLength={200}
                      value={renamingFolder.name}
                      onFocus={e => e.target.select()}
                      onChange={e => setRenamingFolder({ id: f.id, name: e.target.value })}
                      onBlur={() => void renameFolder(f.id, renamingFolder.name)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape') setRenamingFolder(null);
                      }}
                    />
                  </div>
                ) : (
                  <div
                    className={cx('meeting-row', folderMenu?.folder.id === f.id && 'menu-open')}
                    onContextMenu={e => {
                      e.preventDefault();
                      setFolderMenu({ folder: f, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <button
                      type="button"
                      className={cx('folder-chev', isOpen && 'open')}
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${f.name}`}
                      onClick={() => toggleFolder(f.id)}
                    >
                      <ChevronRight size={14} />
                    </button>
                    <button
                      type="button"
                      className={cx('folder-head with-chev', page === 'folder' && folderPage === f.id && 'selected')}
                      style={folderVars(f)}
                      onClick={() => openFolder(f.id)}
                    >
                      <FolderGlyph folder={f} className="folder-icon" />
                      <span className="truncate">{f.name}</span>
                      <span className="count">{items.length || ''}</span>
                    </button>
                    <button
                      type="button"
                      className="icon-button row-menu"
                      aria-label={`Actions for folder ${f.name}`}
                      onClick={e => {
                        const r = e.currentTarget.getBoundingClientRect();
                        setFolderMenu({ folder: f, x: r.left, y: r.bottom });
                      }}
                    >
                      <Ellipsis size={16} />
                    </button>
                  </div>
                )}
                {isOpen && (
                  <div className="folder-items">
                    {items.map(row)}
                    {!items.length && <p className="hint folder-empty">Empty. Drag meetings here, or use “Move to folder”.</p>}
                  </div>
                )}
              </div>
            );
          })}
          <div className={cx('unfiled', dropTarget === UNFILED && 'drop')} {...dropZone(UNFILED)}>
            {groups.map(g => (
              <div key={g.label} className="meeting-group">
                <div className="group-label">{g.label}</div>
                {g.items.map(row)}
              </div>
            ))}
            {!meetings.length && <p className="hint pad">Your meetings will appear here.</p>}
          </div>
          {(archived.length > 0 || dragging) && (
            <div className={cx('folder archive', dropTarget === ARCHIVE && 'drop')} {...dropZone(ARCHIVE)}>
              <div className="meeting-row">
                <button
                  type="button"
                  className={cx('folder-head', folding.archiveOpen && 'open')}
                  aria-expanded={folding.archiveOpen}
                  onClick={() => setFolding(f => ({ ...f, archiveOpen: !f.archiveOpen }))}
                >
                  <ChevronRight size={14} className="chev" />
                  <Archive size={15} className="folder-icon" />
                  <span className="truncate">Archive</span>
                  <span className="count">{archived.length || ''}</span>
                </button>
              </div>
              {folding.archiveOpen && (
                <div className="folder-items">
                  {archived.map(row)}
                  {!archived.length && <p className="hint folder-empty">Drop here to archive.</p>}
                </div>
              )}
            </div>
          )}
        </nav>
        <div className="sidebar-bottom">
          <button type="button" className={cx('nav-button', page === 'settings' && 'on')} onClick={() => openSettings()}>
            <SettingsIcon size={17} /> Settings
          </button>
          <button
            type="button"
            className="nav-button"
            onClick={() => void lock()}
          >
            <Lock size={16} /> Lock notebook
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <button
            type="button"
            className="icon-button topbar-btn sidebar-toggle"
            aria-label={(narrow ? drawer : sidebarOpen) ? 'Hide sidebar' : 'Show sidebar'}
            aria-expanded={narrow ? drawer : sidebarOpen}
            title={`${(narrow ? drawer : sidebarOpen) ? 'Hide' : 'Show'} sidebar (${isMac ? '⌘' : 'Ctrl'}+B)`}
            onClick={toggleSidebar}
          >
            {(narrow ? drawer : sidebarOpen) ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
          <button
            type="button"
            className="icon-button topbar-btn back-button"
            onClick={back}
            disabled={!canGoBack}
            aria-label={canGoBack ? `Back to ${backLabel}` : 'Back'}
            title={canGoBack ? `Back to ${backLabel} (${isMac ? '⌘[' : 'Alt+←'})` : 'You’re on Home'}
          >
            <ArrowLeft size={18} />
          </button>
          <span className="topbar-sep" aria-hidden />
          <nav className="crumbs-nav" aria-label="Breadcrumbs">
            <ol className="crumbs">
              {trail(here).map((c, idx, all) => (
                <li key={idx}>
                  {idx > 0 && <ChevronRight size={13} aria-hidden />}
                  {idx === all.length - 1 ? (
                    <span className="truncate" aria-current="page">
                      {c.label}
                    </span>
                  ) : (
                    <button type="button" className="link truncate" onClick={() => go(c.view)}>
                      {c.label}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </nav>
          <div className="topbar-tools">
            <button type="button" className="icon-button topbar-btn" aria-label="Search and actions" title={`Search & actions (${isMac ? '⌘' : 'Ctrl'}+K)`} onClick={() => setPaletteOpen(true)}>
              <Search size={17} />
            </button>
            <button type="button" className="icon-button topbar-btn topbar-new" aria-label="New meeting" title="New meeting" disabled={creating} onClick={() => void newMeeting()}>
              {creating ? <Spinner size={15} /> : <Plus size={18} />}
            </button>
          </div>
        </header>
        <div className="page" key={page === 'folder' ? `folder-${folderPage}` : page === 'meeting' ? `meeting-${selected}` : page}>
          {page === 'settings' ? (
            <Settings templates={templates} reloadTemplates={reloadTemplates} section={section} onSection={switchSection} onSettingsChange={applySettings} />
          ) : page === 'meeting' && selected ? (
            <MeetingView
              key={selected}
              id={selected}
              templates={templates}
              refreshKey={refreshKey}
              onListChanged={() => void reloadMeetings().catch(() => {})}
              onRequestDelete={() => current && setDeleting(current)}
              organize={current ? organizeActions(current) : []}
              folder={current ? folders.find(f => f.id === current.folder_id) : undefined}
              onOpenFolder={openFolder}
              onUnarchive={() => current && void unarchive(current)}
              onManageTemplates={() => openSettings('templates')}
              views={views}
              defaultNoteLanguage={noteLanguage}
              request={request?.meetingId === selected ? request : null}
            />
          ) : page === 'folder' && openFolderObj ? (
            <FolderPage
              key={openFolderObj.id}
              folder={openFolderObj}
              meetings={byFolder.get(openFolderObj.id) || []}
              creating={creating}
              onOpen={open}
              onMeetingMenu={(m, x, y) => setMenu({ meeting: m, x, y, page: true })}
              onReveal={(id, field, line, lineText) => {
                open(id);
                setRequest({ meetingId: id, tab: field === 'notes' ? 'notes' : 'enhanced', line, lineText, n: Date.now() });
              }}
              onNew={() => void newMeeting(undefined, false, openFolderObj.id)}
              onImport={() => void newMeeting(undefined, true, openFolderObj.id)}
              onCustomize={() => setFolderDialog({ folder: openFolderObj })}
              actions={folderActions(openFolderObj, { rename: false })}
              reloadMeetings={reloadMeetings}
            />
          ) : (
            <Dashboard
              meetings={active}
              folders={folders}
              onOpenFolder={openFolder}
              onNewFolder={() => setFolderDialog({ folder: null })}
              folderActions={f => folderActions(f, { open: true })}
              creating={creating}
              onOpen={open}
              onMeetingMenu={(m, x, y) => setMenu({ meeting: m, x, y, page: true })}
              onReveal={(id, field, line, lineText) => {
                open(id);
                setRequest({ meetingId: id, tab: field === 'notes' ? 'notes' : 'enhanced', line, lineText, n: Date.now() });
              }}
              onNew={() => void newMeeting()}
              onImport={() => void newMeeting(undefined, true)}
              onSettings={s => openSettings(s)}
              reloadMeetings={reloadMeetings}
            />
          )}
        </div>
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={palette.commands} suggestions={palette.suggestions} />
        <ContextMenu
          at={menu && { x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          label="Meeting actions"
          header={menu && <div className="menu-header truncate">{menu.meeting.title || 'Untitled meeting'}</div>}
          items={menu ? meetingActions(menu.meeting, menu.page) : []}
        />
        <ContextMenu
          at={folderMenu && { x: folderMenu.x, y: folderMenu.y }}
          onClose={() => setFolderMenu(null)}
          label="Folder actions"
          header={folderMenu && <div className="menu-header truncate">{folderMenu.folder.name}</div>}
          items={folderMenu ? folderActions(folderMenu.folder, { open: true, rename: true }) : []}
        />
        <FolderDialog
          open={!!folderDialog}
          folder={folderDialog?.folder}
          suggestedColor={nextFolderColor(folders)}
          onClose={() => setFolderDialog(null)}
          onSave={saveFolder}
        />
        <ConfirmDialog
          open={!!deletingFolder}
          onClose={() => setDeletingFolder(null)}
          icon={<Trash2 size={20} />}
          title={<>Delete the folder “{deletingFolder?.name}”?</>}
          description="Only the folder is removed. The meetings inside it move back to the main list, with nothing deleted."
          confirmLabel="Delete folder"
          onConfirm={() => void confirmDeleteFolder()}
        />
        <Modal
          open={!!moving}
          onClose={() => setMoving(null)}
          title={<>Move {moving && name(moving)}</>}
          description={moving?.archived ? 'Moving it also restores it from the archive.' : undefined}
        >
          {moving && (
            <div className="move-list">
              {[{ id: null as string | null, name: 'No folder' }, ...folders].map(f => {
                const here = !moving.archived && (moving.folder_id || null) === f.id;
                return (
                  <button
                    key={f.id ?? UNFILED}
                    type="button"
                    className={cx('move-option', here && 'current')}
                    disabled={here}
                    onClick={() => {
                      setMoving(null);
                      void moveTo(moving, f.id);
                    }}
                  >
                    {f.id ? <FolderGlyph folder={f as Folder} /> : <LayoutDashboard size={15} />}
                    <span className="truncate">{f.name}</span>
                    {here && <Check size={15} className="move-check" />}
                  </button>
                );
              })}
              <form
                className="move-new"
                onSubmit={async e => {
                  e.preventDefault();
                  const m = moving;
                  const f = await createFolder(movingNew);
                  if (!f) return;
                  setMoving(null);
                  void organize(m, { folder_id: f.id, ...(m.archived ? { archived: false } : {}) }, `Moved ${name(m)} to ${f.name}.`);
                }}
              >
                <input aria-label="New folder name" placeholder="New folder…" maxLength={200} value={movingNew} onChange={e => setMovingNew(e.target.value)} />
                <button type="submit" className="primary" disabled={!movingNew.trim()}>
                  <FolderPlus size={15} /> Create &amp; move
                </button>
              </form>
            </div>
          )}
        </Modal>
        <Modal open={!!renameDialog} onClose={() => setRenameDialog(null)} title="Rename meeting">
          {renameDialog && (
            <form
              className="rename-form"
              onSubmit={e => {
                e.preventDefault();
                const r = renameDialog;
                setRenameDialog(null);
                void rename(r.id, r.title);
              }}
            >
              <input
                autoFocus
                aria-label="Meeting name"
                maxLength={500}
                value={renameDialog.title}
                onFocus={e => e.target.select()}
                onChange={e => setRenameDialog({ ...renameDialog, title: e.target.value })}
              />
              <div className="row rename-actions">
                <button type="button" className="ghost" onClick={() => setRenameDialog(null)}>
                  Cancel
                </button>
                <button type="submit" className="primary">
                  Rename
                </button>
              </div>
            </form>
          )}
        </Modal>
        <ConfirmDialog
          open={!!deleting}
          onClose={() => setDeleting(null)}
          icon={<Trash2 size={20} />}
          title={<>Delete “{deleting?.title || 'Untitled meeting'}”?</>}
          description="Its notes, AI notes and their history, transcript and audio recordings will be permanently removed from the server and this device. This can’t be undone."
          confirmLabel="Delete meeting"
          busy={deleteBusy}
          onConfirm={() => void confirmDelete()}
        />
        <Recorder meeting={selected} meetings={meetings} hideWhenIdle={page !== 'meeting'} onOpenMeeting={open} onChange={() => setRefreshKey(k => k + 1)} />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <App />
  </ToastProvider>,
);

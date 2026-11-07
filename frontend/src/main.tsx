import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BookOpen, Download, LayoutDashboard, Ellipsis, ExternalLink, Lock, Menu as MenuIcon, Mic, Pencil, Plus, Search, Settings as SettingsIcon, Sparkles, Trash2, X } from 'lucide-react';
import { api, errorText, Meeting, send, Settings as SettingsT, Template } from './api';
import Recorder from './Recorder';
import Settings, { SettingsSection } from './Settings';
import MeetingView, { MeetingRequest as Req } from './Meeting';
import SearchPalette, { SearchResult } from './SearchPalette';
import { defaultTitle } from './format';
import { forgetMeeting } from './queue';

type MeetingRequest = Req & { meetingId: string };
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
import Dashboard from './Dashboard';
import { Callout, ConfirmDialog, ContextMenu, cx, MenuItem, Spinner, ToastProvider, useToast } from './ui';
import './style.css';

type Auth = { authenticated: boolean; setup_required: boolean };

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
  const [page, setPage] = useState<'home' | 'meeting' | 'settings'>('home');
  const pageRef = useRef(page);
  pageRef.current = page;
  const [section, setSection] = useState<SettingsSection>('ai');
  const query = '';
  const [palette, setPalette] = useState<{ open: boolean; initial: string }>({ open: false, initial: '' });
  const [request, setRequest] = useState<MeetingRequest | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [views, setViews] = useState<{ notes: 'write' | 'preview'; ai: 'write' | 'preview' }>({ notes: 'write', ai: 'preview' });
  const [menu, setMenu] = useState<{ meeting: Meeting; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<Meeting | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const applySettings = useCallback(
    (s: SettingsT) => setViews({ notes: s.notes_view === 'preview' ? 'preview' : 'write', ai: s.ai_notes_view === 'write' ? 'write' : 'preview' }),
    [],
  );

  const reloadMeetings = useCallback(async () => setMeetings(await api<Meeting[]>('/meetings')), []);
  const reloadTemplates = useCallback(async () => setTemplates(await api<Template[]>('/templates')), []);

  useEffect(() => {
    api<Auth>('/auth/status')
      .then(setAuth)
      .catch(e => setAuthError(errorText(e)));
  }, []);
  useEffect(() => {
    if (!auth?.authenticated) return;
    Promise.all([reloadMeetings(), reloadTemplates()]).catch(e => toast(errorText(e), 'error'));
    api<SettingsT>('/settings')
      .then(applySettings)
      .catch(() => {});
    const timer = setInterval(() => void reloadMeetings().catch(() => {}), 15000);
    return () => clearInterval(timer);
  }, [auth?.authenticated, reloadMeetings, reloadTemplates, toast, applySettings]);

  useEffect(() => {
    if (!auth?.authenticated) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || document.body.classList.contains('focus-active')) return;
      const k = e.code;
      if (k === 'KeyK' || (k === 'KeyF' && pageRef.current !== 'meeting')) {
        e.preventDefault();
        setPalette({ open: true, initial: '' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [auth?.authenticated]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = meetings.filter(m => !q || (m.title + ' ' + m.notes).toLowerCase().includes(q));
    const out: { label: string; items: Meeting[] }[] = [];
    for (const m of list) {
      const label = groupLabel(new Date(m.created_at || m.updated_at));
      const g = out.find(x => x.label === label);
      if (g) g.items.push(m);
      else out.push({ label, items: [m] });
    }
    return out;
  }, [meetings, query]);

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

  function open(id: string) {
    setRequest(null);
    setSelected(id);
    setPage('meeting');
    setDrawer(false);
  }

  async function newMeeting(title?: string, importAfter = false) {
    setCreating(true);
    try {
      const m = await send<Meeting>('/meetings', { title: title ?? defaultTitle(new Date()) });
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

  const goHome = () => {
    setPage('home');
    setDrawer(false);
  };

  const openSettings = (s: SettingsSection = section) => {
    setSection(s);
    setPage('settings');
    setDrawer(false);
  };

  const current = meetings.find(m => m.id === selected);

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
      if (selected === deleting.id) {
        setSelected(null);
        if (page === 'meeting') setPage('home');
      }
      toast(`Deleted “${deleting.title || 'Untitled meeting'}”.`);
      setDeleting(null);
      await reloadMeetings();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setDeleteBusy(false);
    }
  }

  const meetingActions = (m: Meeting): MenuItem[] => [
    { label: 'Open', icon: <ExternalLink size={15} />, onSelect: () => open(m.id) },
    { label: 'Rename', icon: <Pencil size={15} />, onSelect: () => setRenaming({ id: m.id, title: m.title }) },
    { label: 'Export as Markdown', icon: <Download size={15} />, onSelect: () => window.open(`/api/meetings/${m.id}/export?format=md`, '_blank') },
    'divider',
    { label: 'Delete…', icon: <Trash2 size={15} />, danger: true, onSelect: () => setDeleting(m) },
  ];

  return (
    <div className="app">
      <div className={cx('drawer-scrim', drawer && 'open')} onClick={() => setDrawer(false)} />
      <aside className={cx('sidebar', drawer && 'open')}>
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
        <button type="button" className="search-button" onClick={() => setPalette({ open: true, initial: '' })}>
          <Search size={15} />
          <span>Search everything</span>
          <kbd>{isMac ? '⌘' : 'Ctrl'} K</kbd>
        </button>
        <nav className="meeting-list" aria-label="Meetings">
          {groups.map(g => (
            <div key={g.label} className="meeting-group">
              <div className="group-label">{g.label}</div>
              {g.items.map(m =>
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
                    <button type="button" className={cx('meeting-link', selected === m.id && page === 'meeting' && 'selected')} onClick={() => open(m.id)}>
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
                ),
              )}
            </div>
          ))}
          {!meetings.length && <p className="hint pad">Your meetings will appear here.</p>}

        </nav>
        <div className="sidebar-bottom">
          <button type="button" className={cx('nav-button', page === 'settings' && 'on')} onClick={() => openSettings()}>
            <SettingsIcon size={17} /> Settings
          </button>
          <button
            type="button"
            className="nav-button"
            onClick={async () => {
              try {
                await send('/auth/logout');
                setAuth(await api('/auth/status'));
              } catch (e) {
                toast(errorText(e), 'error');
              }
            }}
          >
            <Lock size={16} /> Lock notebook
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="mobile-bar">
          <button type="button" className="icon-button" aria-label="Toggle sidebar" onClick={() => setDrawer(d => !d)}>
            <MenuIcon size={20} />
          </button>
          <span className="truncate">{page === 'settings' ? 'Settings' : page === 'home' ? 'Home' : current?.title || 'huh'}</span>
          <button type="button" className="icon-button" aria-label="New meeting (mobile)" onClick={() => void newMeeting()}>
            <Plus size={20} />
          </button>
        </header>
        <div className="page">
          {page === 'settings' ? (
            <Settings templates={templates} reloadTemplates={reloadTemplates} section={section} onSection={setSection} onSettingsChange={applySettings} />
          ) : page === 'meeting' && selected ? (
            <MeetingView
              key={selected}
              id={selected}
              templates={templates}
              refreshKey={refreshKey}
              onListChanged={() => void reloadMeetings().catch(() => {})}
              onRequestDelete={() => current && setDeleting(current)}
              onManageTemplates={() => openSettings('templates')}
              views={views}
              request={request?.meetingId === selected ? request : null}
            />
          ) : (
            <Dashboard
              meetings={meetings}
              creating={creating}
              onOpen={open}
              onNew={() => void newMeeting()}
              onImport={() => void newMeeting(undefined, true)}
              onSettings={s => openSettings(s)}
              reloadMeetings={reloadMeetings}
            />
          )}
        </div>
        <SearchPalette
          open={palette.open}
          initial={palette.initial}
          onClose={() => setPalette(p => ({ ...p, open: false }))}
          onSelect={(r: SearchResult, q: string) => {
            const tab = r.field === 'transcript' ? 'transcript' : r.field === 'enhanced' ? 'enhanced' : 'notes';
            open(r.meeting_id);
            setRequest({
              meetingId: r.meeting_id,
              tab,
              query: r.field === 'title' ? undefined : q,
              recordingId: r.recording_id,
              start: r.start,
              segmentId: r.segment_id,
              n: Date.now(),
            });
          }}
        />
        <ContextMenu
          at={menu && { x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          label="Meeting actions"
          header={menu && <div className="menu-header truncate">{menu.meeting.title || 'Untitled meeting'}</div>}
          items={menu ? meetingActions(menu.meeting) : []}
        />
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown, { SourceInfo } from './Markdown';
import AudioPlayer, { clock, PlayerHandle } from './AudioPlayer';
import FindBar from './FindBar';
import { defaultTitle } from './format';
import { MeetingWhen } from './MeetingTime';
import { fmt, useZone } from './time';
import { Archive, BookA, Pause, Play, Square, Columns2, ListTodo, Maximize2, NotebookPen, PanelRightClose, Rows3, AudioLines, ChevronDown, CircleAlert, Download, Ellipsis, FileAudio, History, Languages, LocateFixed, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { api, Detail, errorText, Folder, Generation, Job, Meeting, peek, send, Template } from './api';
import { FolderGlyph, folderVars } from './folders';
import Editor, { type NoteView } from './Editor';
import { noteLanguageLabel, OUTPUT_LANGUAGES } from './providers';
import { DeviceIcon } from './Recorder';
import { Badge, Callout, ConfirmDialog, cx, Menu, MenuItem, Modal, Select, Spinner, useToast } from './ui';

export type Tab = 'notes' | 'enhanced' | 'transcript' | 'history';
/** Things the command palette can ask the open meeting to do. */
export type MeetingCommand = 'find' | 'focus' | 'generate' | 'ai-options';
const MEETING_COMMAND = 'huh:meeting-command';
export const runMeetingCommand = (what: MeetingCommand) => window.dispatchEvent(new CustomEvent<MeetingCommand>(MEETING_COMMAND, { detail: what }));

export type MeetingRequest ={ tab: Tab; query?: string; recordingId?: string; start?: number; segmentId?: string; line?: number; lineText?: string; n: number };
type SeekRequest = { rec: string; t: number; n: number };

const importAudio = () => window.dispatchEvent(new Event('huh:import-audio'));

/** Side by side (My notes beside AI notes / transcript / history) is offered when the page is at least this wide. */
const SPLIT_MIN = 1180;
/** The outline + details rail appears beside a single tab from this page width. */
const RAIL_MIN = 1180;
/** Opt-in: by default a meeting opens on one tab (AI notes once they exist). */
const SPLIT_KEY = 'huh:meeting-side-by-side';
type SideTab = Exclude<Tab, 'notes'>;
function readSplit() {
  try {
    return localStorage.getItem(SPLIT_KEY) === '1';
  } catch {
    return false;
  }
}

type Heading = { level: number; text: string; line: number; raw: string };
/** Markdown headings (# to ###) outside code fences, with their 1-based line numbers. */
function outline(md: string): Heading[] {
  const out: Heading[] = [];
  let fence = false;
  md.split('\n').forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence;
    if (fence) return;
    const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (m) out.push({ level: m[1].length, text: m[2].replace(/[*_`]/g, '').trim(), line: i + 1, raw });
  });
  return out;
}
const openTodos = (md: string) => (md.match(/^\s*[-*+]\s+\[ \]/gm) || []).length;
const doneTodos = (md: string) => (md.match(/^\s*[-*+]\s+\[[xX]\]/gm) || []).length;
const words = (md: string) => (md.trim() ? md.trim().split(/\s+/).length : 0);

const time = clock;

const versionTime = (iso: string) => fmt(iso, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/** The saved AI version whose text is currently shown in AI notes, if any. */
/** The tab a meeting opens on: AI notes once they exist, otherwise My notes. */
const openingTab = (d: Detail | null): Tab => (d?.enhanced_notes.trim() ? 'enhanced' : 'notes');
const shownVersion = (detail: Detail) => detail.generations.find(g => g.content.trim() === detail.enhanced_notes.trim());

function VersionPicker({ detail, onShow, placement }: { detail: Detail; onShow: (g: Generation) => void; placement?: 'bottom-start' | 'bottom-end' }) {
  const versions = detail.generations; // newest first
  const shown = shownVersion(detail);
  const latest = versions[0];
  const older = shown && shown.id !== latest.id;
  return (
    <div className="version-row">
      <Select
        ariaLabel="AI notes version"
        size="sm"
        placement={placement}
        value={shown?.id ?? ''}
        minWidth={300}
        options={versions.map((g, i) => ({
          value: g.id,
          label: `v${versions.length - i} · ${versionTime(g.created_at)}`,
          description: `${g.template_name} · ${g.model || g.provider}`,
          badge: i === 0 ? <Badge tone="accent">Latest</Badge> : undefined,
        }))}
        onChange={v => {
          const g = versions.find(x => x.id === v);
          if (g && g.id !== shown?.id) onShow(g);
        }}
        renderValue={o => (
          <>
            <History size={14} className="muted-icon" />
            <span className="muted">Version:</span>
            <span className="truncate">{!shown ? 'Edited by you' : shown.id === latest.id ? `Latest · ${o?.label}` : o?.label}</span>
          </>
        )}
      />
      {older && (
        <span className="version-note">
          You’re viewing an older version.{' '}
          <button type="button" className="link" onClick={() => onShow(latest)}>
            Show latest
          </button>
        </span>
      )}
      {!shown && <span className="version-note muted">Your edits are kept until you pick a version.</span>}
    </div>
  );
}

const JOB_LABEL: Record<string, string> = {
  transcribe: 'Transcribing audio',
  generate: 'Writing AI notes',
  download: 'Downloading speech model',
};

const STATUS_LABEL: Record<string, { label: string; tone: 'live' | 'warn' | 'neutral' | 'accent' }> = {
  recording: { label: 'Recording', tone: 'live' },
  starting: { label: 'Starting', tone: 'neutral' },
  switching: { label: 'Switching device', tone: 'neutral' },
  paused: { label: 'Paused', tone: 'warn' },
};

export default function MeetingView({
  id,
  templates,
  refreshKey,
  onListChanged,
  onRequestDelete,
  onManageTemplates,
  views,
  request,
  organize = [],
  folder,
  onOpenFolder,
  onUnarchive,
  defaultNoteLanguage = 'auto',
  glossaryCount = 0,
  onGlossary,
  phone = false,
}: {
  /** The phone layout: one tab at a time, bigger controls; the actions menu lives in the phone's top bar. */
  phone?: boolean;
  id: string;
  /** The "Language of AI notes" setting, used when the meeting has no choice of its own. */
  defaultNoteLanguage?: string;
  templates: Template[];
  refreshKey: number;
  onListChanged: () => void;
  onRequestDelete: () => void;
  onManageTemplates: () => void;
  /** Move-to-folder and archive actions, owned by the sidebar. */
  organize?: MenuItem[];
  folder?: Folder;
  onOpenFolder?: (id: string) => void;
  onUnarchive?: () => void;
  /** Glossary terms the AI will know for this meeting (all notes + folder + meeting). */
  glossaryCount?: number;
  onGlossary?: () => void;
  views: { notes: NoteView; ai: NoteView };
  /** Open a tab, optionally searching and/or moving the transcript playhead (from the palette or a to-do link). */
  request?: MeetingRequest | null;
}) {
  const toast = useToast();
  useZone(); // dates and times re-render when the time zone setting changes
  // A meeting opened before (or prefetched on hover/touch) shows at once; the load below refreshes it.
  const [detail, setDetail] = useState<Detail | null>(() => peek<Detail>(`/meetings/${id}`) || null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>(() => openingTab(detail));
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  /** A transcription / AI-notes job the owner asked to stop, waiting for confirmation. */
  const [stopJob, setStopJob] = useState<Job | null>(null);
  const [focus, setFocus] = useState(false);
  const tabRef = useRef<Tab>('notes');
  tabRef.current = tab;
  const focusRef = useRef(false);
  focusRef.current = focus;
  const panels = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  /** The page is wide enough for two columns, and the user wants them. */
  const [roomy, setRoomy] = useState(false);
  const [pageWidth, setPageWidth] = useState(0);
  const [split, setSplit] = useState(readSplit);
  /** What the right-hand column shows in side-by-side mode. */
  const [side, setSide] = useState<SideTab>('enhanced');
  useEffect(() => {
    if (tab !== 'notes') setSide(tab);
  }, [tab]);
  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_KEY, split ? '1' : '0');
    } catch {}
  }, [split]);
  /** Actions the phone's ⋯ menu can run here; refreshed every render. */
  const commands = useRef<{ generate: () => Promise<void> }>({ generate: async () => {} });
  const [findOpen, setFindOpen] = useState(false);
  /** Phone: the sheet with Format and Language for AI notes. */
  const [aiOptions, setAiOptions] = useState(false);
  const [findInit, setFindInit] = useState<{ text: string; n: number } | null>(null);
  const [findAnchor, setFindAnchor] = useState<string | null>(null);
  const [seek, setSeek] = useState<SeekRequest | null>(null);
  const [reveal, setReveal] = useState<{ tab: Tab; line: number; text?: string; n: number } | null>(null);
  const idRef = useRef(id);
  idRef.current = id;
  // The first load of a meeting picks its opening tab: AI notes once they exist, otherwise My notes.
  const firstLoad = useRef(!detail);

  const load = useCallback(async () => {
    try {
      const d = await api<Detail>(`/meetings/${id}`);
      if (idRef.current === id) {
        setDetail(d);
        setError('');
        if (firstLoad.current) {
          firstLoad.current = false;
          setTab(openingTab(d));
        }
      }
    } catch (e) {
      if (idRef.current === id) setError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
    // Poll while the page is visible; an unchanged meeting costs a tiny 304. Catch up as soon as it's shown again.
    const timer = setInterval(() => document.hidden || void load(), 4000);
    const onShow = () => document.hidden || void load();
    document.addEventListener('visibilitychange', onShow);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [id, load]);
  useEffect(() => {
    if (refreshKey) void load();
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setTitle(detail?.title || ''), [detail?.id, detail?.title]);

  // Ctrl/⌘ + Shift + F toggles focus mode for the open notes tab (My notes otherwise).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.code !== 'KeyF') return;
      e.preventDefault();
      if (e.shiftKey) {
        // Focus mode is for writing: the shortcut always uses My notes.
        setTab('notes');
        setFocus(f => !f);
      } else if (!focusRef.current) {
        // Find within the open tab; pressing again re-selects the query.
        setFindOpen(false);
        requestAnimationFrame(() => setFindOpen(true));
      }
    };
    // The same two, run from the command palette.
    const onCommand = (e: Event) => {
      const what = (e as CustomEvent<MeetingCommand>).detail;
      if (what === 'focus') {
        setTab('notes');
        setFocus(true);
      } else if (what === 'find') {
        setFocus(false);
        setFindOpen(false);
        requestAnimationFrame(() => setFindOpen(true));
      } else if (what === 'generate') void commands.current.generate();
      else if (what === 'ai-options') setAiOptions(true);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(MEETING_COMMAND, onCommand);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(MEETING_COMMAND, onCommand);
    };
  }, []);

  const refresh = useCallback(async () => {
    await load();
    onListChanged();
  }, [load, onListChanged]);

  // Requests from elsewhere (palette, dashboard to-dos): open the tab, search, move the playhead, reveal a line.
  const loaded = !!detail;
  useEffect(() => {
    if (!request || !loaded) return;
    setFocus(false);
    setTab(request.tab);
    if (request.query) {
      setFindAnchor(request.segmentId ? `#seg-${request.segmentId}` : null);
      setFindInit({ text: request.query, n: request.n });
      setFindOpen(true);
    }
    if (request.recordingId != null && request.start != null) setSeek({ rec: request.recordingId, t: request.start, n: request.n });
    if (request.line) setReveal({ tab: request.tab, line: request.line, text: request.lineText, n: request.n });
  }, [request?.n, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const sources = useMemo<SourceInfo | undefined>(
    () =>
      detail
        ? {
            segments: detail.transcript,
            recordings: detail.recordings,
            onJump: (rec, t) => {
              setTab('transcript');
              setSeek({ rec, t, n: Date.now() });
            },
          }
        : undefined,
    [detail?.transcript, detail?.recordings], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Measure the page (not the meeting column, whose width depends on the mode).
  const hasRoot = !!detail;
  useEffect(() => {
    const page = root.current?.parentElement;
    if (!page) return;
    const measure = (width: number) => {
      setRoomy(width >= SPLIT_MIN);
      setPageWidth(width);
    };
    measure(page.clientWidth);
    const ro = new ResizeObserver(([e]) => measure(e.contentRect.width));
    ro.observe(page);
    return () => ro.disconnect();
  }, [hasRoot]);

  // The phone's top bar shows Edit only on a note tab.
  useEffect(() => {
    if (!phone) return;
    document.body.dataset.phoneTab = tab;
    return () => void delete document.body.dataset.phoneTab;
  }, [phone, tab]);

  const aiTemplates = useMemo(() => templates.filter(t => t.kind === 'ai'), [templates]);
  const noteTemplates = useMemo(() => templates.filter(t => t.kind === 'notes'), [templates]);
  const defaultAi = aiTemplates.find(t => t.is_default) || aiTemplates[0];

  if (error && !detail)
    return (
      <div className="page-pad">
        <Callout tone="bad">{error}</Callout>
      </div>
    );
  if (!detail) return <MeetingSkeleton id={id} phone={phone} />;

  const created = new Date(detail.created_at || detail.updated_at);
  const jobs = [...detail.jobs].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const active = jobs.filter(j => j.status === 'queued' || j.status === 'running' || j.status === 'paused');
  // Finished audio nobody has started processing (automatic processing is off, or a job was stopped).
  const audioWaiting = detail.recordings.some(r => r.status === 'ready') && !active.some(j => j.kind === 'transcribe');
  const failed = (['transcribe', 'generate'] as const)
    .map(kind => jobs.find(j => j.kind === kind))
    .filter((j): j is Job => !!j && j.status === 'failed');
  const status = STATUS_LABEL[detail.recording_state?.status || detail.status];
  const hasTranscript = detail.transcript.length > 0;
  const generating = active.some(j => j.kind === 'generate' && j.status !== 'paused');
  const templateValue = detail.template_id && aiTemplates.some(t => t.id === detail.template_id) ? detail.template_id : defaultAi?.id || '';

  async function patch(body: Record<string, unknown>) {
    try {
      await send(`/meetings/${id}`, body, 'PATCH');
      await refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  async function generate() {
    setBusy(true);
    try {
      await send(`/meetings/${id}/generate`, { template_id: templateValue || null });
      setTab('enhanced');
      await refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  commands.current.generate = generate;

  /** Main language for this meeting's AI notes; "default" follows Settings. */
  const languageValue = detail.notes_language || 'default';
  const languageOptions = [
    { value: 'default', label: `Settings default`, description: noteLanguageLabel(defaultNoteLanguage) },
    ...OUTPUT_LANGUAGES,
    ...(detail.notes_language && !OUTPUT_LANGUAGES.some(o => o.value === detail.notes_language) ? [{ value: detail.notes_language, label: detail.notes_language }] : []),
  ];

  async function setNotesLanguage(v: string) {
    const value = v === 'default' ? null : v;
    if (value === (detail!.notes_language || null)) return;
    await patch({ notes_language: value });
    if (detail!.generations.length) toast(`Next AI notes will be written in ${noteLanguageLabel(value || defaultNoteLanguage)}. Click Regenerate to redo them now.`, 'success');
  }

  /** Make a saved AI version the one shown in AI notes (syncs to every device). */
  async function showVersion(g: Generation, quiet = false) {
    try {
      await send(`/meetings/${id}`, { enhanced_notes: g.content, enhanced_revision: detail!.enhanced_revision }, 'PATCH');
      await refresh();
      setTab('enhanced');
      if (!quiet) toast(`Showing the AI notes from ${versionTime(g.created_at)}.`, 'success');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  async function jobControl(j: Job, action: 'pause' | 'resume' | 'cancel') {
    try {
      await send(`/jobs/${j.id}/control`, { action });
      await refresh();
    } catch (e) {
      toast(errorText(e), 'error');
      await refresh();
    }
  }

  async function transcribe() {
    setBusy(true);
    try {
      await send(`/meetings/${id}/transcribe`);
      toast('Transcription queued.', 'success');
      await refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const sideBySide = split && roomy;
  /** The right-hand column in side-by-side mode. */
  const right: SideTab = tab === 'notes' ? side : tab;
  const shown = (t: Tab) => (sideBySide ? t === 'notes' || t === right : t === tab);
  const rail = !sideBySide && pageWidth >= RAIL_MIN;
  /** Format + Generate: in the tab row, or in the rail when the rail replaces it. */
  const formatSelect = (
      <Select
        ariaLabel="AI template"
        size="sm"
        value={templateValue}
        placement="bottom-end"
        minWidth={260}
        options={aiTemplates.map(t => ({ value: t.id, label: t.name, description: t.is_default ? 'Default' : undefined }))}
        onChange={v => void patch({ template_id: v })}
        renderValue={o => (
          <>
            <span className="muted">Format:</span> <span className="truncate">{o?.label || 'Default'}</span>
          </>
        )}
        footer={
          <button type="button" className="link small" onClick={onManageTemplates}>
            Edit AI templates…
          </button>
        }
      />
  );
  const languageSelect = (
      <Select
        ariaLabel="Main language of AI notes"
        size="sm"
        value={languageValue}
        placement="bottom-end"
        minWidth={260}
        options={languageOptions}
        onChange={v => void setNotesLanguage(v)}
        searchable
        allowCustom
        customLabel={q => `Use “${q}”`}
        renderValue={o => (
          <>
            <Languages size={14} className="muted-icon" />{' '}
            <span className="truncate">{o?.value === 'default' || !o ? noteLanguageLabel(defaultNoteLanguage) : o.label}</span>
          </>
        )}
        footer={<small className="muted">Main language of the AI notes. Names and terms can stay as spoken.</small>}
      />
  );
  const generateButton = (
      <button type="button" className="primary sm" disabled={busy || generating || !hasTranscript} title={hasTranscript ? undefined : 'Record or import audio first'} onClick={() => void generate()}>
        {generating ? <Spinner size={14} /> : <Sparkles size={15} />} {detail.generations.length ? 'Regenerate' : 'Generate'}
        <span className="gen-suffix">AI notes</span>
      </button>
  );
  const aiControls = (
    <>
      {formatSelect}
      {languageSelect}
      {generateButton}
    </>
  );

  /** Jump to a heading from the rail: scroll the rendered heading, or select its line in the editor. */
  function jumpTo(t: 'notes' | 'enhanced', h: Heading, index: number) {
    const pane = panels.current?.querySelector<HTMLElement>(`[data-pane="${t}"]`);
    const rendered = pane?.querySelector('.note-preview')?.querySelectorAll<HTMLElement>('h1, h2, h3')[index];
    if (rendered) {
      rendered.scrollIntoView({ behavior: 'smooth', block: 'start' });
      rendered.classList.remove('line-flash');
      void rendered.offsetWidth;
      rendered.classList.add('line-flash');
      rendered.addEventListener('animationend', () => rendered.classList.remove('line-flash'), { once: true });
    } else setReveal({ tab: t, line: h.line, text: h.raw, n: Date.now() });
  }

  const allTabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'notes', label: 'My notes' },
    { id: 'enhanced', label: 'AI notes' },
    { id: 'transcript', label: 'Transcript', count: detail.recordings.length || undefined },
    { id: 'history', label: 'History', count: detail.generations.length || undefined },
  ];
  // On a phone, History is reached from the ⋯ menu and only shown as a tab while it's open.
  const tabs = sideBySide ? allTabs.filter(t => t.id !== 'notes') : phone ? allTabs.filter(t => t.id !== 'history' || tab === 'history') : allTabs;
  const isOn = (t: Tab) => (sideBySide ? t === right : t === tab);

  return (
    <div className={cx('meeting', sideBySide && 'split', phone && 'phone')} ref={root}>
      <header className="meeting-header">
        <div className="meeting-meta">
          <MeetingWhen
            meeting={detail}
            phone={phone}
            onSave={async body => {
              await patch(body);
              onListChanged();
            }}
          />
          {status && <Badge tone={status.tone}>{status.label}</Badge>}
          {folder && (
            <button type="button" className="meeting-folder" style={folderVars(folder)} title={`Open ${folder.name}`} onClick={() => onOpenFolder?.(folder.id)}>
              <FolderGlyph folder={folder} size={13} /> {folder.name}
            </button>
          )}
          {onGlossary && (
            <button
              type="button"
              className={cx('glossary-chip', glossaryCount > 0 && 'on')}
              title={glossaryCount ? `The AI knows ${glossaryCount} glossary term${glossaryCount === 1 ? '' : 's'} for this meeting. Edit…` : 'Add names, terms or acronyms the AI should know'}
              onClick={onGlossary}
            >
              <BookA size={13} /> Glossary{glossaryCount > 0 && <span className="glossary-count">{glossaryCount}</span>}
            </button>
          )}
          <span className="spacer" />
          {roomy && (
            <button
              type="button"
              className={cx('ghost sm split-toggle', sideBySide && 'on')}
              aria-pressed={sideBySide}
              title={sideBySide ? 'Show one tab at a time' : 'Show My notes beside AI notes, the transcript or history'}
              onClick={() => setSplit(v => !v)}
            >
              {sideBySide ? <PanelRightClose size={15} /> : <Columns2 size={15} />}
              <span>{sideBySide ? 'One column' : 'Side by side'}</span>
            </button>
          )}
          {!phone && <Menu
            label="Meeting actions"
            items={[
              {
                label: 'Focus mode',
                hint: 'Ctrl/⌘ + Shift + F',
                icon: <Maximize2 size={15} />,
                onSelect: () => {
                  setTab('notes');
                  setFocus(true);
                },
              },
              { label: 'Import audio file…', icon: <FileAudio size={15} />, onSelect: importAudio },
              ...(onGlossary ? [{ label: 'Glossary…', hint: 'Terms the AI should know', icon: <BookA size={15} />, onSelect: onGlossary }] : []),
              { label: 'Export as Markdown', icon: <Download size={15} />, onSelect: () => window.open(`/api/meetings/${id}/export?format=md`, '_blank') },
              ...(organize.length ? (['divider', ...organize] as MenuItem[]) : []),
              'divider',
              { label: 'Delete meeting…', icon: <Trash2 size={15} />, danger: true, onSelect: onRequestDelete },
            ]}
            trigger={p => (
              <button type="button" className="icon-button" aria-label="Meeting actions" {...p} ref={p.ref}>
                <Ellipsis size={18} />
              </button>
            )}
          />}
        </div>
        {phone ? (
          // A long title wraps onto more lines instead of scrolling sideways out of sight.
          <textarea
            className="title-input phone-title"
            aria-label="Meeting title"
            placeholder="Untitled meeting"
            rows={1}
            value={title}
            maxLength={500}
            ref={el => {
              if (el) {
                el.style.setProperty('height', 'auto', 'important');
                el.style.setProperty('height', `${el.scrollHeight}px`, 'important');
              }
            }}
            onFocus={e => (title === 'Untitled meeting' || title === defaultTitle(created)) && e.target.select()}
            onChange={e => setTitle(e.target.value.replace(/\n/g, ' '))}
            onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())}
            onBlur={() => {
              if (title !== detail.title) void patch({ title });
            }}
          />
        ) : (
          <input
            className="title-input"
            aria-label="Meeting title"
            placeholder="Untitled meeting"
            value={title}
            maxLength={500}
            onFocus={e => (title === 'Untitled meeting' || title === defaultTitle(created)) && e.target.select()}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            onBlur={() => {
              if (title !== detail.title) void patch({ title });
            }}
          />
        )}
        {detail.archived && (
          <div className="archived-banner">
            <Archive size={15} />
            <span>Archived. It’s kept as is and still searchable, listed after everything else.</span>
            {onUnarchive && (
              <button type="button" className="link small" onClick={onUnarchive}>
                Restore
              </button>
            )}
          </div>
        )}
      </header>

      <div className={cx('meeting-body', rail && 'with-rail')}>
        <div className="meeting-main">
          {phone && (
            <Menu
              label="Show"
              placement="bottom-start"
              items={allTabs
                .filter(t => t.id !== 'history' || detail.generations.length > 0)
                .map(t => ({
                  label: t.label + (t.count ? ` (${t.count})` : ''),
                  icon: t.id === 'notes' ? <NotebookPen size={17} /> : t.id === 'enhanced' ? <Sparkles size={17} /> : t.id === 'transcript' ? <AudioLines size={17} /> : <History size={17} />,
                  onSelect: () => setTab(t.id),
                }))}
              trigger={p => (
                <button type="button" className="phone-view" {...p} ref={p.ref}>
                  {allTabs.find(t => t.id === tab)?.label}
                  <ChevronDown size={15} />
                </button>
              )}
            />
          )}
          {!rail && !phone && (
          <div className={cx('tabbar', sideBySide && 'split')}>
            {sideBySide && (
              <div className="tabs pane-label">
                <span className="tab on">My notes</span>
              </div>
            )}
            <div className="tabs" role="tablist">
              {tabs.map(t => (
                <button key={t.id} type="button" role="tab" aria-selected={isOn(t.id)} className={cx('tab', isOn(t.id) && 'on')} onClick={() => setTab(t.id)}>
                  {t.label}
                  {t.count ? <span className="tab-count">{t.count}</span> : null}
                </button>
              ))}
            </div>
            {!phone && (
              <div className="generate-group">
                {aiControls}
              </div>
            )}
          </div>
          )}

          {(active.length > 0 || failed.length > 0 || audioWaiting) && (
            <div className="job-strip">
              {audioWaiting && (
                <div className="job paused">
                  <AudioLines size={15} />
                  <span>Audio waiting to be processed</span>
                  <span className="job-actions">
                    <button type="button" className="ghost xs" disabled={busy} onClick={() => void transcribe()}>
                      <Play size={13} /> Process
                    </button>
                  </span>
                </div>
              )}
              {active.map(j => (
                <div key={j.id} className={cx('job', j.status === 'paused' && 'paused')}>
                  {j.status === 'paused' ? <Pause size={15} /> : <Spinner size={15} />}
                  <span>
                    {JOB_LABEL[j.kind] || j.kind}
                    {j.status === 'paused' ? ' — paused' : j.status === 'queued' ? ' — waiting to start' : j.progress ? ` — ${Math.round(j.progress * 100)}%` : '…'}
                    {(() => {
                      // After a fallback, say which backup model is writing now.
                      const last = j.notices?.[j.notices.length - 1];
                      if (!last) return null;
                      if (last.exhausted) return <span className="muted"> · no model in your AI order worked; trying again shortly</span>;
                      return last.to_label ? <span className="muted"> · using {last.to_label} ({last.from_label} {last.reason})</span> : null;
                    })()}
                  </span>
                  {j.status === 'running' && !!j.progress && !phone && (
                    <span className="progress">
                      <span style={{ width: `${Math.round(j.progress * 100)}%` }} />
                    </span>
                  )}
                  {(j.kind === 'transcribe' || j.kind === 'generate') && (
                    <span className="job-actions">
                      {j.status === 'paused' ? (
                        <button type="button" className="ghost xs" onClick={() => void jobControl(j, 'resume')}>
                          <Play size={13} /> Resume
                        </button>
                      ) : (
                        <button type="button" className="ghost xs" onClick={() => void jobControl(j, 'pause')}>
                          <Pause size={13} /> Pause
                        </button>
                      )}
                      <button type="button" className="ghost xs" onClick={() => setStopJob(j)}>
                        <Square size={11} fill="currentColor" /> Stop
                      </button>
                    </span>
                  )}
                </div>
              ))}
              {failed.map(j => (
                <div key={j.id} className="job failed">
                  <CircleAlert size={15} />
                  <span>
                    {JOB_LABEL[j.kind] || j.kind} failed{j.error ? `: ${j.error}` : '.'}
                  </span>
                  <button type="button" className="ghost xs" disabled={busy} onClick={() => void (j.kind === 'generate' ? generate() : transcribe())}>
                    <RotateCcw size={13} /> Try again
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className={cx('tab-panels', sideBySide && 'split')} ref={panels}>
            <FindBar open={findOpen} onClose={() => setFindOpen(false)} root={panels} initialQuery={findInit} anchorSelector={findAnchor} watch={tab} />
            {(['notes', 'enhanced'] as const).map(t => (
              <div
                key={t}
                hidden={!shown(t)}
                className={cx('tab-panel', t === 'notes' ? 'pane-main' : 'pane-side')}
                data-find-root
                data-pane={t}
                data-find-active={sideBySide && tab === t ? '' : undefined}
                onFocusCapture={sideBySide ? () => setTab(t) : undefined}
                onPointerDownCapture={sideBySide ? () => setTab(t) : undefined}
              >
                {t === 'enhanced' && phone && !detail.generations.length && !generating && (
                  <div className="phone-ai-empty">
                    {hasTranscript ? generateButton : <p className="muted">No AI notes yet. Record or import audio first.</p>}
                  </div>
                )}
                {t === 'enhanced' && !rail && !phone && detail.generations.length > 0 && <VersionPicker detail={detail} onShow={showVersion} />}
                <Editor
                  key={detail.id + t}
                  meeting={detail}
                  field={t === 'notes' ? 'notes' : 'enhanced_notes'}
                  noteTemplates={noteTemplates}
                  onManageTemplates={onManageTemplates}
                  defaultView={t === 'notes' ? views.notes : views.ai}
                  focus={focus && tab === t}
                  onFocusChange={setFocus}
                  title={title}
                  sources={sources}
                  reveal={reveal?.tab === t ? reveal : null}
                  onSave={() => void refresh()}
                />
                {t === 'enhanced' && !detail.enhanced_notes && !generating && (
                  <div className="hint-card">
                    <Sparkles size={18} />
                    <div>
                      <strong>AI notes combine your notes with the transcript.</strong>
                      <p className="muted">
                        {hasTranscript ? 'Click “Generate AI notes”. Pick a format first if you like.' : 'Record or import audio first. AI notes are generated automatically when a recording finishes.'}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {shown('transcript') && (
              <div
                className="pane-side"
                data-find-active={sideBySide && tab === 'transcript' ? '' : undefined}
                onFocusCapture={sideBySide ? () => setTab('transcript') : undefined}
                onPointerDownCapture={sideBySide ? () => setTab('transcript') : undefined}
              >
                <Transcript
                  detail={detail}
                  busy={busy}
                  onTranscribe={() => void transcribe()}
                  onLanguage={language => void patch({ language })}
                  seek={seek}
                  onRetranscribe={async rid => {
                    try {
                      await send(`/recordings/${rid}/transcribe`);
                      toast('Transcribing this recording again…', 'success');
                      await refresh();
                    } catch (e) {
                      toast(errorText(e), 'error');
                    }
                  }}
                />
              </div>
            )}

            {shown('history') && (
              <div
                className="pane-side"
                data-find-active={sideBySide && tab === 'history' ? '' : undefined}
                onFocusCapture={sideBySide ? () => setTab('history') : undefined}
                onPointerDownCapture={sideBySide ? () => setTab('history') : undefined}
              >
                <HistoryView detail={detail} sources={sources} onShow={g => void showVersion(g)} />
              </div>
            )}
          </div>
        </div>
        {rail && (
          <MeetingRail
            detail={detail}
            tab={tab}
            onTab={setTab}
            onJump={jumpTo}
            aiControls={aiControls}
            version={detail.generations.length > 0 && <VersionPicker detail={detail} onShow={showVersion} placement="bottom-end" />}
          />
        )}
      </div>
      {phone && (
        <Modal open={aiOptions} onClose={() => setAiOptions(false)} title="AI notes">
          <div className="phone-ai-sheet">
            <label>Format</label>
            {formatSelect}
            <label>Language</label>
            {languageSelect}
          </div>
        </Modal>
      )}
      <ConfirmDialog
        open={!!stopJob}
        onClose={() => setStopJob(null)}
        icon={<Square size={18} fill="currentColor" />}
        title={stopJob?.kind === 'transcribe' ? 'Stop transcribing?' : 'Stop writing AI notes?'}
        description={
          stopJob?.kind === 'transcribe'
            ? 'The audio is kept. You can transcribe it again any time from Process or the Transcript.'
            : 'Your notes and earlier AI versions are kept. You can generate AI notes again any time.'
        }
        confirmLabel="Stop"
        onConfirm={() => {
          const j = stopJob;
          setStopJob(null);
          if (j) void jobControl(j, 'cancel');
        }}
      />
    </div>
  );
}

/** Beside a single tab on wide pages: the meeting at a glance (fixed, on top), then the open note's outline (changes with the tab). */
function MeetingRail({
  detail,
  tab,
  onTab,
  onJump,
  aiControls,
  version,
}: {
  detail: Detail;
  tab: Tab;
  onTab: (t: Tab) => void;
  onJump: (t: 'notes' | 'enhanced', h: Heading, index: number) => void;
  /** Format + Generate, moved here from the tab row. */
  aiControls: React.ReactNode;
  version: React.ReactNode;
}) {
  const noteTab: 'notes' | 'enhanced' | null = tab === 'notes' || tab === 'enhanced' ? tab : null;
  const text = noteTab === 'notes' ? detail.notes : noteTab === 'enhanced' ? detail.enhanced_notes : '';
  const heads = useMemo(() => outline(text), [text]);
  const seconds = detail.recordings.reduce((n, r) => n + (r.duration || 0), 0);
  const shown = shownVersion(detail);
  const vIndex = shown ? detail.generations.length - detail.generations.indexOf(shown) : 0;
  // To-dos live in AI notes once they exist, otherwise in your notes (same rule as Home).
  const todoSource = detail.enhanced_notes.trim() ? detail.enhanced_notes : detail.notes;
  const open = openTodos(todoSource);
  const done = doneTodos(todoSource);
  return (
    <aside className="meeting-rail" aria-label="About this meeting">
      <section className="rail-card rail-facts">
        <h3>At a glance</h3>
        <nav aria-label="Meeting views" className="rail-tabs">
        <button type="button" className={cx('rail-fact', tab === 'enhanced' && 'on')} aria-current={tab === 'enhanced' ? 'page' : undefined} onClick={() => onTab('enhanced')}>
          <Sparkles size={15} />
          <span>
            <strong>AI notes</strong>
            <small>{!detail.generations.length ? 'Not generated yet' : shown ? `v${vIndex} of ${detail.generations.length} · ${shown.template_name}` : 'Edited by you'}</small>
          </span>
        </button>
        <button type="button" className={cx('rail-fact', tab === 'notes' && 'on')} aria-current={tab === 'notes' ? 'page' : undefined} onClick={() => onTab('notes')}>
          <NotebookPen size={15} />
          <span>
            <strong>My notes</strong>
            <small>{words(detail.notes) ? `${words(detail.notes)} words` : 'Empty'}</small>
          </span>
        </button>
        <button type="button" className={cx('rail-fact', tab === 'transcript' && 'on')} aria-current={tab === 'transcript' ? 'page' : undefined} onClick={() => onTab('transcript')}>
          <AudioLines size={15} />
          <span>
            <strong>Transcript</strong>
            <small>
              {detail.recordings.length
                ? `${detail.recordings.length} recording${detail.recordings.length === 1 ? '' : 's'}${seconds ? ` · ${time(seconds)}` : ''}`
                : 'No recordings yet'}
            </small>
          </span>
        </button>
        {open + done > 0 && (
          <div className="rail-fact static">
            <ListTodo size={15} />
            <span>
              <strong>To-dos</strong>
              <small>
                {open} open{done ? ` · ${done} done` : ''}
              </small>
            </span>
          </div>
        )}
        {detail.generations.length > 0 && (
          <button type="button" className={cx('rail-fact', tab === 'history' && 'on')} aria-current={tab === 'history' ? 'page' : undefined} onClick={() => onTab('history')}>
            <Rows3 size={15} />
            <span>
              <strong>History</strong>
              <small>
                {detail.generations.length} AI version{detail.generations.length === 1 ? '' : 's'}
              </small>
            </span>
          </button>
        )}
        </nav>
      </section>
      <section className="rail-card rail-ai" aria-label="AI notes controls">
        <h3>AI notes</h3>
        <div className="rail-ai-controls">{aiControls}</div>
        {version && <div className="rail-version">{version}</div>}
      </section>
      {noteTab && heads.length > 1 && (
        <nav className="rail-card rail-outline" aria-label="Contents">
          <h3>Contents</h3>
          <ol>
            {heads.map((h, i) => (
              <li key={i} className={`lvl-${h.level - Math.min(...heads.map(x => x.level)) + 1}`}>
                <button type="button" className="rail-link truncate" title={h.text} onClick={() => onJump(noteTab, h, i)}>
                  {h.text}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}
    </aside>
  );
}

const LIVE_STATUSES = ['starting', 'recording', 'stopping', 'uploading'];

function Transcript({
  detail,
  busy,
  onTranscribe,
  onLanguage,
  onRetranscribe,
  seek,
}: {
  detail: Detail;
  busy: boolean;
  onTranscribe: () => void;
  onLanguage: (v: string) => void;
  onRetranscribe: (recordingId: string) => void;
  seek: SeekRequest | null;
}) {
  const player = useRef<PlayerHandle | null>(null);
  const recordings = detail.recordings;
  // One recording is open at a time; the player for it stays pinned above its lines.
  const [picked, setPicked] = useState<string | null>(seek?.rec ?? null);
  const current = recordings.find(r => r.id === picked) ?? recordings[0];
  const rid = current?.id;
  // The line under the playhead in the open recording; updated only when it changes.
  const [active, setActive] = useState<string | undefined>();
  const [playing, setPlaying] = useState(false);
  const bySource = useMemo(() => {
    const map: Record<string, Detail['transcript']> = {};
    for (const s of detail.transcript) (map[s.recording_id] ||= []).push(s);
    return map;
  }, [detail.transcript]);
  const segments = (rid && bySource[rid]) || [];
  const lineAt = (t: number) => {
    let found: string | undefined;
    for (const s of segments) {
      if (s.start <= t + 0.05) found = s.id;
      else break;
    }
    return found;
  };
  const track = (t: number) => {
    const id = lineAt(t);
    setActive(a => (a === id ? a : id));
  };

  function reveal(id: string | undefined, flash: boolean) {
    requestAnimationFrame(() => {
      const el = id ? document.getElementById(`seg-${id}`) : null;
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (!flash) return;
      el?.classList.remove('flash');
      void el?.offsetWidth;
      el?.classList.add('flash');
    });
  }

  function moveTo(t: number, scroll: boolean) {
    player.current?.seek(t);
    track(t);
    if (scroll) reveal(lineAt(t), true);
  }

  function open(id: string) {
    if (id === rid) return;
    setPicked(id);
    setActive(undefined);
    setPlaying(false);
  }

  // A citation or search hit: open its recording first, then seek once the player for it is mounted.
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!seek || handled.current === seek.n) return;
    if (seek.rec !== rid) {
      if (recordings.some(r => r.id === seek.rec)) open(seek.rec);
      return;
    }
    handled.current = seek.n;
    moveTo(seek.t, true);
  }, [seek?.n, rid]); // eslint-disable-line react-hooks/exhaustive-deps

  const needsRun = recordings.some(r => ['ready', 'error'].includes(r.status));
  const statusTone = (s: string) => (s === 'transcribed' ? 'good' : s === 'error' ? 'bad' : s === 'recording' ? 'live' : 'neutral');
  const statusText: Record<string, string> = {
    starting: 'Starting',
    recording: 'Recording',
    stopping: 'Finishing',
    uploading: 'Uploading',
    ready: 'Waiting to transcribe',
    queued: 'Queued',
    transcribed: 'Transcribed',
    error: 'Failed',
  };
  const startedAt = (r: { created_at: string }) => fmt(r.created_at, { hour: 'numeric', minute: '2-digit' });
  const playable = current ? !LIVE_STATUSES.includes(current.status) : false;
  const index = current ? recordings.indexOf(current) : -1;

  return (
    <section className="transcript" data-find-root>
      <div className="section-bar" data-find-skip>
        <h2>The conversation</h2>
        <span className="spacer" />
        <Select
          ariaLabel="Transcription language"
          size="sm"
          value={detail.language || 'auto'}
          placement="bottom-end"
          minWidth={240}
          onChange={onLanguage}
          renderValue={o => (
            <>
              <Languages size={14} className="muted-icon" /> <span className="truncate">{o?.label}</span>
            </>
          )}
          options={[
            { value: 'auto', label: 'Language: from Settings' },
            { value: 'mixed', label: 'English + 中文' },
            { value: 'en', label: 'English' },
            { value: 'zh', label: '中文' },
          ]}
        />
        {needsRun && (
          <button type="button" className="ghost sm" disabled={busy} onClick={onTranscribe}>
            <AudioLines size={15} /> Transcribe now
          </button>
        )}
        <button type="button" className="ghost sm" onClick={importAudio}>
          <FileAudio size={15} /> Import audio
        </button>
      </div>

      {!current && (
        <div className="empty-mini">
          <AudioLines size={28} />
          <strong>No audio yet</strong>
          <p className="muted">Press “Start recording” at the bottom of the screen, or import a recording such as an iPhone Voice Memo.</p>
        </div>
      )}

      {current && (
        <>
          {recordings.length > 1 && (
            <div className="rec-picker" role="tablist" aria-label="Recordings" data-find-skip>
              {recordings.map((r, i) => {
                const on = r.id === rid;
                return (
                  <button
                    key={r.id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    className={cx('rec-chip', on && 'on', r.status === 'recording' && 'live', r.status === 'error' && 'bad')}
                    title={`${r.label || 'Audio'} · ${statusText[r.status] || r.status}`}
                    onClick={() => open(r.id)}
                  >
                    <span className="rec-chip-n">{i + 1}</span>
                    <DeviceIcon name={r.label || ''} size={14} />
                    <span className="rec-chip-text">
                      <span className="truncate">{r.label || 'Audio'}</span>
                      <span className="rec-chip-sub">
                        {startedAt(r)}
                        {r.duration ? ` · ${time(r.duration)}` : ''}
                      </span>
                    </span>
                    {on && playing && <span className="rec-chip-eq" aria-label="Playing" />}
                  </button>
                );
              })}
            </div>
          )}

          <div className={cx('rec-dock', playing && 'playing')} data-find-skip>
            <div className="rec-dock-head">
              <DeviceIcon name={current.label || ''} />
              <strong className="truncate">{current.label || 'Audio'}</strong>
              <span className="muted small nowrap">
                {recordings.length > 1 && `${index + 1} of ${recordings.length} · `}
                {startedAt(current)}
                {current.duration ? ` · ${time(current.duration)}` : ''}
              </span>
              <span className="spacer" />
              <Badge tone={statusTone(current.status) as any}>{statusText[current.status] || current.status}</Badge>
              {['transcribed', 'error'].includes(current.status) && (
                <button type="button" className="ghost xs" title="Run speech recognition on this audio again" onClick={() => onRetranscribe(current.id)}>
                  <RotateCcw size={13} /> <span className="hide-narrow">Transcribe again</span>
                </button>
              )}
            </div>
            {playable ? (
              <div className="rec-dock-player">
                <AudioPlayer
                  key={current.id}
                  ref={player}
                  src={`/api/recordings/${current.id}/audio`}
                  knownDuration={current.duration}
                  label={current.label || 'recording'}
                  onTime={track}
                  onPlayingChange={setPlaying}
                />
                <button
                  type="button"
                  className="icon-button sm"
                  title="Scroll to the line being played"
                  aria-label="Scroll to the line being played"
                  disabled={!active}
                  onClick={() => reveal(active, false)}
                >
                  <LocateFixed size={16} />
                </button>
              </div>
            ) : (
              <p className="hint">Playback is available once this recording finishes uploading.</p>
            )}
          </div>

          {segments.length > 0 ? (
            <div className="segments" key={current.id}>
              {segments.map(s => (
                <div className={cx('segment', active === s.id && 'active')} key={s.id} id={`seg-${s.id}`}>
                  <button type="button" className="timestamp" title={playable ? 'Move the playhead here' : undefined} disabled={!playable} onClick={() => moveTo(s.start, false)}>
                    {time(s.start)}
                  </button>
                  <p>{s.text}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="hint">{current.status === 'transcribed' ? 'No speech was detected in this audio.' : 'The transcript will appear here once processing finishes.'}</p>
          )}
        </>
      )}
    </section>
  );
}

function HistoryView({ detail, onShow, sources }: { detail: Detail; onShow: (g: Generation) => void; sources?: SourceInfo }) {
  const shown = shownVersion(detail);
  const [selected, setSelected] = useState<string | null>(shown?.id || detail.generations[0]?.id || null);
  const g = detail.generations.find(x => x.id === selected);
  if (!detail.generations.length)
    return (
      <div className="empty-mini">
        <History size={28} />
        <strong>No AI versions yet</strong>
        <p className="muted">Every time AI notes are generated, the result is kept here so you can compare it or show it again.</p>
      </div>
    );
  return (
    <section className="history">
      <aside className="history-list">
        {detail.generations.map((x, i) => (
          <button key={x.id} type="button" className={cx('history-item', selected === x.id && 'on')} onClick={() => setSelected(x.id)}>
            <strong>
              v{detail.generations.length - i} · {versionTime(x.created_at)}
              {i === 0 && <Badge tone="accent">Latest</Badge>}
              {shown?.id === x.id && <Badge tone="good">Showing</Badge>}
            </strong>
            <small>
              {x.template_name}
              {x.output_language ? ` · ${noteLanguageLabel(x.output_language)}` : ''} · {x.model || x.provider}
            </small>
          </button>
        ))}
      </aside>
      {g && (
        <div className="history-preview" data-find-root>
          <div className="section-bar">
            <span className="muted small">
              {g.provider} / {g.model} · {g.template_name}
              {g.output_language ? ` · ${noteLanguageLabel(g.output_language)}` : ''}
            </span>
            <span className="spacer" />
            {shown?.id === g.id ? (
              <Badge tone="good">Shown in AI notes</Badge>
            ) : (
              <button type="button" className="ghost sm" onClick={() => onShow(g)}>
                <RotateCcw size={14} /> Show this version in AI notes
              </button>
            )}
          </div>
          <Markdown text={g.content} sources={sources} />
        </div>
      )}
    </section>
  );
}

/**
 * Stands in for a meeting that hasn't loaded yet: its title (already known from the meeting list) and a few
 * placeholder lines, faded in only if loading takes long enough to notice, so fast opens don't flicker.
 */
function MeetingSkeleton({ id, phone }: { id: string; phone?: boolean }) {
  const title = peek<Meeting[]>('/meetings')?.find(m => m.id === id)?.title;
  return (
    <div className={cx('meeting', 'meeting-skeleton', phone && 'phone')} aria-busy="true" aria-label="Opening meeting">
      <header className="meeting-header">
        <div className="meeting-meta">
          <span className="sk" style={{ width: 120 }} />
        </div>
        <div className="sk-title">{title || <span className="sk" style={{ width: '45%', height: 28 }} />}</div>
      </header>
      <div className="sk-body">
        <span className="sk" style={{ width: 180, height: 30, borderRadius: 999 }} />
        {['92%', '78%', '85%', '60%', '88%', '70%', '40%'].map((w, i) => (
          <span key={i} className="sk" style={{ width: w }} />
        ))}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown, { SourceInfo } from './Markdown';
import AudioPlayer, { clock, PlayerHandle } from './AudioPlayer';
import FindBar from './FindBar';
import { defaultTitle } from './format';
import { Archive, Folder as FolderIcon, Maximize2, AudioLines, CircleAlert, Download, Ellipsis, FileAudio, History, Languages, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { api, Detail, errorText, Generation, Job, send, Template } from './api';
import Editor from './Editor';
import { DeviceIcon } from './Recorder';
import { Badge, Callout, cx, Menu, MenuItem, Select, Spinner, useToast } from './ui';

export type Tab = 'notes' | 'enhanced' | 'transcript' | 'history';
export type MeetingRequest = { tab: Tab; query?: string; recordingId?: string; start?: number; segmentId?: string; n: number };
type SeekRequest = { rec: string; t: number; n: number };

const importAudio = () => window.dispatchEvent(new Event('huh:import-audio'));

const time = clock;

const versionTime = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/** The saved AI version whose text is currently shown in AI notes, if any. */
const shownVersion = (detail: Detail) => detail.generations.find(g => g.content.trim() === detail.enhanced_notes.trim());

function VersionPicker({ detail, onShow }: { detail: Detail; onShow: (g: Generation) => void }) {
  const versions = detail.generations; // newest first
  const shown = shownVersion(detail);
  const latest = versions[0];
  const older = shown && shown.id !== latest.id;
  return (
    <div className="version-row">
      <Select
        ariaLabel="AI notes version"
        size="sm"
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
  folderName,
  onUnarchive,
}: {
  id: string;
  templates: Template[];
  refreshKey: number;
  onListChanged: () => void;
  onRequestDelete: () => void;
  onManageTemplates: () => void;
  /** Move-to-folder and archive actions, owned by the sidebar. */
  organize?: MenuItem[];
  folderName?: string;
  onUnarchive?: () => void;
  views: { notes: 'write' | 'preview'; ai: 'write' | 'preview' };
  /** Open a tab, optionally searching and/or moving the transcript playhead (from global search). */
  request?: MeetingRequest | null;
}) {
  const toast = useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('notes');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState(false);
  const tabRef = useRef<Tab>('notes');
  tabRef.current = tab;
  const focusRef = useRef(false);
  focusRef.current = focus;
  const panels = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findInit, setFindInit] = useState<{ text: string; n: number } | null>(null);
  const [findAnchor, setFindAnchor] = useState<string | null>(null);
  const [seek, setSeek] = useState<SeekRequest | null>(null);
  const idRef = useRef(id);
  idRef.current = id;
  // The first load of a meeting picks its opening tab: AI notes once they exist, otherwise My notes.
  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    try {
      const d = await api<Detail>(`/meetings/${id}`);
      if (idRef.current === id) {
        setDetail(d);
        setError('');
        if (firstLoad.current) {
          firstLoad.current = false;
          setTab(d.enhanced_notes.trim() ? 'enhanced' : 'notes');
        }
      }
    } catch (e) {
      if (idRef.current === id) setError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    setDetail(null);
    setTab('notes');
    firstLoad.current = true;
    void load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
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
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const refresh = useCallback(async () => {
    await load();
    onListChanged();
  }, [load, onListChanged]);

  // Requests from global search: open the tab, search, and move the playhead to the hit.
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

  const aiTemplates = useMemo(() => templates.filter(t => t.kind === 'ai'), [templates]);
  const noteTemplates = useMemo(() => templates.filter(t => t.kind === 'notes'), [templates]);
  const defaultAi = aiTemplates.find(t => t.is_default) || aiTemplates[0];

  if (error && !detail)
    return (
      <div className="page-pad">
        <Callout tone="bad">{error}</Callout>
      </div>
    );
  if (!detail)
    return (
      <div className="loading-block page-pad">
        <Spinner /> Opening meeting…
      </div>
    );

  const created = new Date(detail.created_at || detail.updated_at);
  const jobs = [...detail.jobs].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const active = jobs.filter(j => j.status === 'queued' || j.status === 'running');
  const failed = (['transcribe', 'generate'] as const)
    .map(kind => jobs.find(j => j.kind === kind))
    .filter((j): j is Job => !!j && j.status === 'failed');
  const status = STATUS_LABEL[detail.recording_state?.status || detail.status];
  const hasTranscript = detail.transcript.length > 0;
  const generating = active.some(j => j.kind === 'generate');
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

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'notes', label: 'My notes' },
    { id: 'enhanced', label: 'AI notes' },
    { id: 'transcript', label: 'Transcript', count: detail.recordings.length || undefined },
    { id: 'history', label: 'History', count: detail.generations.length || undefined },
  ];

  return (
    <div className="meeting">
      <header className="meeting-header">
        <div className="meeting-meta">
          <span>
            {created.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} ·{' '}
            {created.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
          </span>
          {status && <Badge tone={status.tone}>{status.label}</Badge>}
          {folderName && (
            <span className="meeting-folder">
              <FolderIcon size={13} /> {folderName}
            </span>
          )}
          <span className="spacer" />
          <Menu
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
          />
        </div>
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

      <div className="tabbar">
        <div className="tabs" role="tablist">
          {tabs.map(t => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={cx('tab', tab === t.id && 'on')} onClick={() => setTab(t.id)}>
              {t.label}
              {t.count ? <span className="tab-count">{t.count}</span> : null}
            </button>
          ))}
        </div>
        <div className="generate-group">
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
          <button type="button" className="primary sm" disabled={busy || generating || !hasTranscript} title={hasTranscript ? undefined : 'Record or import audio first'} onClick={() => void generate()}>
            {generating ? <Spinner size={14} /> : <Sparkles size={15} />} {detail.generations.length ? 'Regenerate' : 'Generate'} AI notes
          </button>
        </div>
      </div>

      {(active.length > 0 || failed.length > 0) && (
        <div className="job-strip">
          {active.map(j => (
            <div key={j.id} className="job">
              <Spinner size={15} />
              <span>
                {JOB_LABEL[j.kind] || j.kind}
                {j.status === 'queued' ? ' — waiting to start' : j.progress ? ` — ${Math.round(j.progress * 100)}%` : '…'}
              </span>
              {j.status === 'running' && !!j.progress && (
                <span className="progress">
                  <span style={{ width: `${Math.round(j.progress * 100)}%` }} />
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

      <div className="tab-panels" ref={panels}>
        <FindBar open={findOpen} onClose={() => setFindOpen(false)} root={panels} initialQuery={findInit} anchorSelector={findAnchor} watch={tab} />
        {(['notes', 'enhanced'] as const).map(t => (
          <div key={t} hidden={tab !== t} className="tab-panel" data-find-root>
            {t === 'enhanced' && detail.generations.length > 0 && <VersionPicker detail={detail} onShow={showVersion} />}
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
              onSave={() => void refresh()}
            />
            {t === 'enhanced' && !detail.enhanced_notes && !generating && (
              <div className="hint-card">
                <Sparkles size={18} />
                <div>
                  <strong>AI notes combine your notes with the transcript.</strong>
                  <p className="muted">
                    {hasTranscript ? 'Click “Generate AI notes” above. Pick a format first if you like.' : 'Record or import audio first. AI notes are generated automatically when a recording finishes.'}
                  </p>
                </div>
              </div>
            )}
          </div>
        ))}

        {tab === 'transcript' && (
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
        )}

        {tab === 'history' && <HistoryView detail={detail} sources={sources} onShow={g => void showVersion(g)} />}
      </div>

    </div>
  );
}

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
  const players = useRef<Record<string, PlayerHandle | null>>({});
  // The line under the playhead, per recording; updated only when it changes.
  const [active, setActive] = useState<Record<string, string | undefined>>({});
  const bySource = useMemo(() => {
    const map: Record<string, Detail['transcript']> = {};
    for (const s of detail.transcript) (map[s.recording_id] ||= []).push(s);
    return map;
  }, [detail.transcript]);
  const lineAt = (rid: string, t: number) => {
    const segs = bySource[rid] || [];
    let found: string | undefined;
    for (const s of segs) {
      if (s.start <= t + 0.05) found = s.id;
      else break;
    }
    return found;
  };
  const track = (rid: string, t: number) => {
    const id = lineAt(rid, t);
    setActive(a => (a[rid] === id ? a : { ...a, [rid]: id }));
  };

  function moveTo(rid: string, t: number, scroll: boolean) {
    players.current[rid]?.seek(t);
    track(rid, t);
    if (!scroll) return;
    const id = lineAt(rid, t);
    requestAnimationFrame(() => {
      const el = id ? document.getElementById(`seg-${id}`) : null;
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.classList.remove('flash');
      void el?.offsetWidth;
      el?.classList.add('flash');
    });
  }

  useEffect(() => {
    if (seek) moveTo(seek.rec, seek.t, true);
  }, [seek?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const needsRun = detail.recordings.some(r => ['ready', 'error'].includes(r.status));
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

      {!detail.recordings.length && (
        <div className="empty-mini">
          <AudioLines size={28} />
          <strong>No audio yet</strong>
          <p className="muted">Press “Start recording” at the bottom of the screen, or import a recording such as an iPhone Voice Memo.</p>
        </div>
      )}

      {detail.recordings.map(r => {
        const segments = bySource[r.id] || [];
        const playable = !['starting', 'recording', 'stopping', 'uploading'].includes(r.status);
        return (
          <article className="source-card" key={r.id}>
            <header data-find-skip>
              <DeviceIcon name={r.label || ''} />
              <strong className="truncate">{r.label || 'Audio'}</strong>
              <span className="muted small">
                {new Date(r.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                {r.duration ? ` · ${time(r.duration)}` : ''}
              </span>
              <span className="spacer" />
              <Badge tone={statusTone(r.status) as any}>{statusText[r.status] || r.status}</Badge>
              {['transcribed', 'error'].includes(r.status) && (
                <button type="button" className="ghost xs" title="Run speech recognition on this audio again" onClick={() => onRetranscribe(r.id)}>
                  <RotateCcw size={13} /> Transcribe again
                </button>
              )}
            </header>
            {playable && (
              <div className="player-wrap" data-find-skip>
                <AudioPlayer
                  ref={el => void (players.current[r.id] = el)}
                  src={`/api/recordings/${r.id}/audio`}
                  knownDuration={r.duration}
                  label={r.label || 'recording'}
                  onTime={t => track(r.id, t)}
                />
              </div>
            )}
            {segments.length > 0 ? (
              <div className="segments">
                {segments.map(s => (
                  <div className={cx('segment', active[r.id] === s.id && 'active')} key={s.id} id={`seg-${s.id}`}>
                    <button type="button" className="timestamp" title="Move the playhead here" disabled={!playable} onClick={() => moveTo(r.id, s.start, false)}>
                      {time(s.start)}
                    </button>
                    <p>{s.text}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="hint">{r.status === 'transcribed' ? 'No speech was detected in this audio.' : 'The transcript will appear here once processing finishes.'}</p>
            )}
          </article>
        );
      })}
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
              {x.template_name} · {x.model || x.provider}
            </small>
          </button>
        ))}
      </aside>
      {g && (
        <div className="history-preview" data-find-root>
          <div className="section-bar">
            <span className="muted small">
              {g.provider} / {g.model} · {g.template_name}
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

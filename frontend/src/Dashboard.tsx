import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, AudioLines, CircleAlert, Clock, FileAudio, ListTodo, Mic, Plus, Sparkles, CalendarDays } from 'lucide-react';
import { api, ApiError, errorText, Job, Meeting, send, Settings as SettingsT } from './api';
import { stripSources, toggleTask } from './Markdown';
import { Callout, cx, Spinner, useToast } from './ui';

type MeetingStats = { recorded_seconds: number; recordings: number; segments: number; generations: number };
type DashJob = Job & { meeting_id: string; meeting_title: string | null };
type DashData = { meetings: Record<string, MeetingStats>; jobs: DashJob[] };
type Todo = { meeting: Meeting; field: 'notes' | 'enhanced_notes'; line: number; text: string; key: string };

const OPEN_TASK = /^(?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+(.+)$/;

function startOfWeek(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (x.getDay() + 6) % 7; // Monday first
  x.setDate(x.getDate() - day);
  return x.getTime();
}

function duration(seconds: number) {
  if (seconds < 60) return seconds > 0 ? '<1m' : '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function plain(markdown: string) {
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

function delta(now: number, before: number, unit = '') {
  const d = now - before;
  if (!before && !now) return 'Nothing yet';
  if (d === 0) return 'Same as last week';
  return `${d > 0 ? '+' : '−'}${Math.abs(d)}${unit} vs last week`;
}

export default function Dashboard({
  meetings,
  onOpen,
  onNew,
  onImport,
  onSettings,
  reloadMeetings,
  creating,
}: {
  meetings: Meeting[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onImport: () => void;
  onSettings: (section: 'ai' | 'transcription') => void;
  reloadMeetings: () => Promise<void>;
  creating: boolean;
}) {
  const toast = useToast();
  const [data, setData] = useState<DashData | null>(null);
  const [settings, setSettings] = useState<SettingsT | null>(null);
  const [ticking, setTicking] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<DashData>('/dashboard'));
    } catch {}
  }, []);
  useEffect(() => {
    void load();
    api<SettingsT>('/settings')
      .then(setSettings)
      .catch(() => {});
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const summary = useMemo(() => {
    const week = startOfWeek(now);
    const lastWeek = week - 7 * 86400000;
    let thisCount = 0,
      lastCount = 0,
      thisSec = 0,
      lastSec = 0,
      totalSec = 0,
      ai = 0;
    for (const m of meetings) {
      const t = new Date(m.created_at || m.updated_at).getTime();
      const s = data?.meetings[m.id];
      totalSec += s?.recorded_seconds || 0;
      ai += s?.generations || 0;
      if (t >= week) {
        thisCount++;
        thisSec += s?.recorded_seconds || 0;
      } else if (t >= lastWeek) {
        lastCount++;
        lastSec += s?.recorded_seconds || 0;
      }
    }
    return { thisCount, lastCount, thisSec, lastSec, totalSec, ai };
  }, [meetings, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const todos = useMemo(() => {
    const out: Todo[] = [];
    for (const m of meetings) {
      // One source per meeting: AI notes when they exist (they already fold in your notes), otherwise My notes.
      const field = (m.enhanced_notes || '').trim() ? 'enhanced_notes' : 'notes';
      (m[field] || '').split('\n').forEach((l, i) => {
        const match = l.match(OPEN_TASK);
        if (match) out.push({ meeting: m, field, line: i + 1, text: stripSources(match[1]).replace(/[*_`]/g, '').trim(), key: `${m.id}:${field}:${i}` });
      });
    }
    return out;
  }, [meetings]);

  const recent = meetings.slice(0, 4);
  const active = (data?.jobs || []).filter(j => j.status === 'queued' || j.status === 'running');
  const failed = (data?.jobs || []).filter(j => j.status === 'failed');
  const meetingsWithTodos = new Set(todos.map(t => t.meeting.id)).size;

  async function tick(t: Todo) {
    setTicking(t.key);
    const revision = t.field === 'notes' ? 'notes_revision' : 'enhanced_revision';
    try {
      await send(`/meetings/${t.meeting.id}`, { [t.field]: toggleTask(t.meeting[t.field], t.line), [revision]: t.meeting[revision] }, 'PATCH');
      await reloadMeetings();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast('That note just changed on another device. The list has been refreshed.', 'error');
        await reloadMeetings();
      } else toast(errorText(e), 'error');
    } finally {
      setTicking(null);
    }
  }

  const visibleTodos = showAll ? todos : todos.slice(0, 7);

  return (
    <div className="dashboard">
      <header className="dash-head">
        <div>
          <p className="dash-date">{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          <h1>{greeting}</h1>
          <p className="muted">
            {meetings.length === 0
              ? 'Your notebook is empty. Start your first meeting below.'
              : todos.length
                ? `${todos.length} open to-do${todos.length === 1 ? '' : 's'} across ${meetingsWithTodos} meeting${meetingsWithTodos === 1 ? '' : 's'}.`
                : 'No open to-dos. Nice.'}
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

      <section className="stat-row" aria-label="Summary">
        <div className="stat">
          <span className="stat-label">
            <CalendarDays size={15} /> Meetings this week
          </span>
          <span className="stat-value">{summary.thisCount}</span>
          <span className="stat-delta">{delta(summary.thisCount, summary.lastCount)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">
            <Clock size={15} /> Recorded this week
          </span>
          <span className="stat-value">{duration(summary.thisSec)}</span>
          <span className="stat-delta">{duration(summary.totalSec)} recorded in total</span>
        </div>
        <div className="stat">
          <span className="stat-label">
            <ListTodo size={15} /> Open to-dos
          </span>
          <span className="stat-value">{todos.length}</span>
          <span className="stat-delta">From AI notes, or your notes if none</span>
        </div>
        <div className="stat">
          <span className="stat-label">
            <Sparkles size={15} /> AI notes written
          </span>
          <span className="stat-value">{summary.ai}</span>
          <span className="stat-delta">
            Across {meetings.length} meeting{meetings.length === 1 ? '' : 's'}
          </span>
        </div>
      </section>

      {(active.length > 0 || failed.length > 0) && (
        <section className="dash-activity" aria-label="Processing">
          {active.map(j => (
            <button key={j.id} type="button" className="activity-item" onClick={() => onOpen(j.meeting_id)}>
              <Spinner size={15} />
              <span className="truncate">
                {j.kind === 'transcribe' ? 'Transcribing' : 'Writing AI notes for'} <strong>{j.meeting_title || 'Untitled meeting'}</strong>
                {j.status === 'queued' ? ' — waiting' : j.progress ? ` — ${Math.round(j.progress * 100)}%` : '…'}
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
            <div className="recent-grid">
              {recent.map(m => {
                const s = data?.meetings[m.id];
                const snippet = plain(m.notes) || plain(m.enhanced_notes);
                return (
                  <button key={m.id} type="button" className="recent-card" onClick={() => onOpen(m.id)}>
                    <span className="recent-top">
                      <strong className="truncate">{m.title || 'Untitled meeting'}</strong>
                      {m.status === 'recording' && <span className="rec-dot small-dot" title="Recording" />}
                    </span>
                    <span className="recent-date">
                      {new Date(m.updated_at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                    <span className={cx('recent-snippet', !snippet && 'empty')}>{snippet || 'No notes yet'}</span>
                    <span className="recent-meta">
                      {s?.recorded_seconds ? (
                        <span>
                          <AudioLines size={13} /> {duration(s.recorded_seconds)}
                        </span>
                      ) : null}
                      {s?.generations ? (
                        <span>
                          <Sparkles size={13} /> AI notes
                        </span>
                      ) : null}
                      {!s?.recorded_seconds && !s?.generations && <span>Notes only</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="panel dash-todos">
          <div className="panel-head">
            <div>
              <h2>Open to-dos</h2>
              <p className="muted">
                From each meeting’s AI notes, or your own notes when it has none. Tick to complete.
              </p>
            </div>
          </div>
          {todos.length === 0 ? (
            <p className="hint">Nothing open. Add a checkbox in any note with “- [ ] ”.</p>
          ) : (
            <ul className="todo-list">
              {visibleTodos.map(t => (
                <li key={t.key} className={cx(ticking === t.key && 'ticking')}>
                  <input type="checkbox" className="task-box inline" aria-label={`Complete: ${t.text}`} checked={ticking === t.key} disabled={!!ticking} onChange={() => void tick(t)} />
                  <span className="todo-text">
                    <span>{t.text}</span>
                    <button type="button" className="link small todo-source" onClick={() => onOpen(t.meeting.id)}>
                      {t.meeting.title || 'Untitled meeting'}
                      {t.field === 'enhanced_notes' ? ' · AI notes' : ''}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {todos.length > 7 && (
            <button type="button" className="ghost sm" onClick={() => setShowAll(v => !v)}>
              {showAll ? 'Show fewer' : `Show all ${todos.length}`}
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

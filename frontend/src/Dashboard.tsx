import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, CircleCheck, Undo2, X, AudioLines, CircleAlert, Clock, FileAudio, ListTodo, Mic, Plus, Sparkles, CalendarDays } from 'lucide-react';
import { api, ApiError, errorText, Job, Meeting, send, Settings as SettingsT } from './api';
import { stripSources, toggleTask } from './Markdown';
import { Callout, cx, Spinner, useToast } from './ui';

type MeetingStats = { recorded_seconds: number; recordings: number; segments: number; generations: number };
type DashJob = Job & { meeting_id: string; meeting_title: string | null };
type DashData = { meetings: Record<string, MeetingStats>; jobs: DashJob[] };
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
  onReveal,
  onNew,
  onImport,
  onSettings,
  reloadMeetings,
  creating,
}: {
  meetings: Meeting[];
  onOpen: (id: string) => void;
  /** Open a meeting's note at a source line and highlight it. */
  onReveal: (id: string, field: Field, line: number, lineText: string) => void;
  onNew: () => void;
  onImport: () => void;
  onSettings: (section: 'ai' | 'transcription') => void;
  reloadMeetings: () => Promise<void>;
  creating: boolean;
}) {
  const toast = useToast();
  const [data, setData] = useState<DashData | null>(null);
  const [settings, setSettings] = useState<SettingsT | null>(null);
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
        if (match) out.push({ meeting: m, field, line: i + 1, raw: l, text: stripSources(match[1]).replace(/[*_`]/g, '').trim(), key: `${m.id}:${field}:${i}` });
      });
    }
    return out;
  }, [meetings]);

  const recent = meetings.slice(0, 4);
  const active = (data?.jobs || []).filter(j => j.status === 'queued' || j.status === 'running');
  const failed = (data?.jobs || []).filter(j => j.status === 'failed');
  const meetingsWithTodos = new Set(todos.map(t => t.meeting.id)).size;

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

  const shown = todos.filter(t => !gone.has(t.key));
  const visibleTodos = showAll ? shown : shown.slice(0, 7);

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
                From each meeting’s AI notes, or your own notes when it has none. Tick to complete, or click one to see it in its note.
              </p>
            </div>
          </div>
          {shown.length === 0 ? (
            <p className="hint">Nothing open. Add a checkbox in any note with “- [ ] ”.</p>
          ) : (
            <ul className="todo-list">
              {visibleTodos.map(t => {
                const done = checked.has(t.key);
                return (
                  <li
                    key={t.key}
                    ref={el => rowRef(t.key, el)}
                    className={cx(done && 'done')}
                  >
                    <input type="checkbox" className="task-box inline" aria-label={`Complete: ${t.text}`} checked={done} disabled={done} onChange={() => void tick(t)} />
                    <button
                      type="button"
                      className="todo-text"
                      title="Show in the note"
                      disabled={done}
                      onClick={() => onReveal(t.meeting.id, t.field, t.line, t.raw)}
                    >
                      <span className="todo-label">
                        <span>{t.text}</span>
                      </span>
                      <span className="todo-source">
                        {t.meeting.title || 'Untitled meeting'}
                        {t.field === 'enhanced_notes' ? ' · AI notes' : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {shown.length > 7 && (
            <button type="button" className="ghost sm" onClick={() => setShowAll(v => !v)}>
              {showAll ? 'Show fewer' : `Show all ${shown.length}`}
            </button>
          )}
        </section>
      </div>
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
    </div>
  );
}

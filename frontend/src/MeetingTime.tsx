import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Minus, Plus } from 'lucide-react';
import type { Meeting } from './api';
import { cx, Popover } from './ui';
import { dayNumber, deviceZone, durationLabel, fmt, fromWall, meetingSpan, timeRange, useZone, wall, Wall, zoneAbbr, zoneLong } from './time';

const DURATIONS = [15, 30, 45, 60, 90, 120];
const MAX_MINUTES = 24 * 60;
/** Wall-clock labels are formatted as UTC so they never shift with daylight saving. */
const clockLabel = (h: number, mi: number) => fmt(Date.UTC(2000, 0, 1, h, mi), { hour: 'numeric', minute: '2-digit' }, 'UTC');
const dayOf = (w: Pick<Wall, 'y' | 'mo' | 'd'>) => Math.round(Date.UTC(w.y, w.mo - 1, w.d) / 86400000);

/**
 * Reads a typed time: "2", "2pm", "2:30", "230p", "14:30", "noon". Without am/pm, an hour up to 12
 * keeps the half of the day already chosen ("2:30" on a 2:00 PM meeting means 2:30 PM).
 */
export function parseClock(text: string, pm: boolean): { h: number; mi: number } | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  if (t === 'noon') return { h: 12, mi: 0 };
  if (t === 'midnight') return { h: 0, mi: 0 };
  const m = t.match(/^(\d{1,2})(?:[:.h]?(\d{2}))?(a|p|am|pm|a\.m\.|p\.m\.)?$/);
  if (!m) return null;
  let h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  if (mi > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    const isPm = m[3].startsWith('p');
    h = (h % 12) + (isPm ? 12 : 0);
  } else {
    if (h > 23) return null;
    if (pm && h >= 1 && h < 12) h += 12;
  }
  return { h, mi };
}

/** The meeting's date line; click to pick its date, start time and length. */
export function MeetingWhen({ meeting, phone, onSave }: { meeting: Meeting; phone?: boolean; onSave: (body: { starts_at: string; duration_minutes: number }) => Promise<void> | void }) {
  const zone = useZone();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { start, end } = meetingSpan(meeting);
  const upcoming = start.getTime() > Date.now();
  const away = zone !== deviceZone();
  const date = fmt(start, phone ? { weekday: 'short', month: 'short', day: 'numeric' } : { weekday: 'long', month: 'long', day: 'numeric' });
  const year = wall(start).y !== wall(Date.now()).y ? `, ${wall(start).y}` : '';
  return (
    <>
      <button
        type="button"
        ref={anchor}
        className={cx('when-chip', open && 'on', upcoming && 'upcoming')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${fmt(start, { dateStyle: 'full', timeStyle: 'short' })} – ${fmt(end, { timeStyle: 'short' })} (${zoneLong(start)}) · ${durationLabel(meeting.duration_minutes || 60)}. Change…`}
        onClick={() => setOpen(v => !v)}
      >
        <CalendarDays size={13} aria-hidden />
        <span>
          {date}
          {year} · {timeRange(start, end)}
          {away && <span className="when-zone"> {zoneAbbr(start)}</span>}
        </span>
        {upcoming && <span className="when-tag">Upcoming</span>}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-start" minWidth={phone ? 300 : 520} maxWidth={560} className="when-popover" label="Meeting time">
        {open && (
          <WhenPicker
            meeting={meeting}
            onCancel={() => setOpen(false)}
            onSave={async body => {
              setOpen(false);
              await onSave(body);
            }}
          />
        )}
      </Popover>
    </>
  );
}

function WhenPicker({ meeting, onSave, onCancel }: { meeting: Meeting; onSave: (body: { starts_at: string; duration_minutes: number }) => void; onCancel: () => void }) {
  const zone = useZone();
  const initial = useMemo(() => wall(meetingSpan(meeting).start), [meeting, zone]); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<Wall>(initial);
  const [minutes, setMinutes] = useState(meeting.duration_minutes || 60);
  const [view, setView] = useState({ y: initial.y, mo: initial.mo });
  const [typed, setTyped] = useState<string | null>(null);
  const today = wall(Date.now());
  const start = fromWall(draft);
  const end = new Date(start.getTime() + minutes * 60000);
  const changed = start.getTime() !== new Date(meeting.starts_at || meeting.created_at).getTime() || minutes !== (meeting.duration_minutes || 60);

  /* Calendar: six weeks starting on the Sunday on or before the 1st. */
  const cells = useMemo(() => {
    const first = Date.UTC(view.y, view.mo - 1, 1);
    const lead = new Date(first).getUTCDay();
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(first + (i - lead) * 86400000);
      return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
    });
  }, [view]);
  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, i) => fmt(Date.UTC(2023, 0, 1 + i), { weekday: 'narrow' }, 'UTC')), []);
  const weekdaysLong = useMemo(() => Array.from({ length: 7 }, (_, i) => fmt(Date.UTC(2023, 0, 1 + i), { weekday: 'long' }, 'UTC')), []);

  const pickDay = (c: { y: number; mo: number; d: number }) => {
    setDraft(w => ({ ...w, ...c }));
    if (c.y !== view.y || c.mo !== view.mo) setView({ y: c.y, mo: c.mo });
  };
  const shiftMonth = (n: number) =>
    setView(v => {
      const d = new Date(Date.UTC(v.y, v.mo - 1 + n, 1));
      return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1 };
    });
  const grid = useRef<HTMLDivElement>(null);
  const focusDay = useRef(false);
  useEffect(() => {
    if (!focusDay.current) return;
    focusDay.current = false;
    grid.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  }, [draft.y, draft.mo, draft.d]);
  const onGridKey = (e: React.KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!step) return;
    e.preventDefault();
    const d = new Date(Date.UTC(draft.y, draft.mo - 1, draft.d + step));
    focusDay.current = true;
    pickDay({ y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() });
  };

  /* Start times every 15 minutes, plus the chosen one when it's off the grid. */
  const slots = useMemo(() => {
    const out: { h: number; mi: number }[] = [];
    for (let i = 0; i < 96; i++) out.push({ h: Math.floor(i / 4), mi: (i % 4) * 15 });
    if (draft.mi % 15) out.splice(draft.h * 4 + Math.floor(draft.mi / 15) + 1, 0, { h: draft.h, mi: draft.mi });
    return out;
  }, [draft.h, draft.mi]);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    centreSlot();
    const raf = requestAnimationFrame(centreSlot); // again once the popover has its final size
    return () => cancelAnimationFrame(raf);
  }, [draft.h, draft.mi]);
  function centreSlot() {
    const el = list.current?.querySelector<HTMLElement>('.when-slot.on');
    const box = list.current;
    if (!el || !box) return;
    // A column on desktop; a sideways strip in the phone's sheet.
    if (box.scrollWidth > box.clientWidth + 1) box.scrollLeft = el.offsetLeft - box.clientWidth / 2 + el.offsetWidth / 2;
    else box.scrollTop = el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2;
  }

  const commitTyped = () => {
    if (typed === null) return;
    const t = parseClock(typed, draft.h >= 12);
    if (t) setDraft(w => ({ ...w, ...t }));
    setTyped(null);
  };

  const save = () => onSave({ starts_at: start.toISOString(), duration_minutes: minutes });
  const sameDay = (c: { y: number; mo: number; d: number }) => c.y === draft.y && c.mo === draft.mo && c.d === draft.d;
  const daysAway = dayOf(draft) - dayNumber(Date.now());
  const relative = daysAway === 0 ? 'Today' : daysAway === 1 ? 'Tomorrow' : daysAway === -1 ? 'Yesterday' : daysAway > 1 ? `In ${daysAway} days` : `${-daysAway} days ago`;

  return (
    <div
      className="when-picker"
      onKeyDown={e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          save();
        }
      }}
    >
      <header className="when-head">
        <div>
          <div className="when-title">{fmt(start, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
          <div className="when-sub">
            {timeRange(start, end)} · {durationLabel(minutes)} · <span className="when-rel">{relative}</span>
          </div>
        </div>
        <span className="when-tz" title={`Times are in ${zone}. Change it in Settings → Notes & navigation.`}>
          {zoneAbbr(start)}
        </span>
      </header>

      <div className="when-body">
        <section className="when-cal" aria-label="Date">
          <div className="when-month">
            <button type="button" className="icon-button" aria-label="Previous month" onClick={() => shiftMonth(-1)}>
              <ChevronLeft size={16} />
            </button>
            <strong>{fmt(Date.UTC(view.y, view.mo - 1, 1), { month: 'long', year: 'numeric' }, 'UTC')}</strong>
            <button type="button" className="icon-button" aria-label="Next month" onClick={() => shiftMonth(1)}>
              <ChevronRight size={16} />
            </button>
            <button type="button" className="ghost xs when-today" onClick={() => pickDay(today)} disabled={sameDay(today) && view.y === today.y && view.mo === today.mo}>
              Today
            </button>
          </div>
          <div className="when-grid" role="grid" ref={grid} onKeyDown={onGridKey}>
            {weekdays.map((w, i) => (
              <span key={i} className="when-dow" role="columnheader" aria-label={weekdaysLong[i]}>
                {w}
              </span>
            ))}
            {cells.map(c => {
              const on = sameDay(c);
              const isToday = c.y === today.y && c.mo === today.mo && c.d === today.d;
              return (
                <button
                  key={`${c.y}-${c.mo}-${c.d}`}
                  type="button"
                  role="gridcell"
                  aria-selected={on}
                  tabIndex={on ? 0 : -1}
                  aria-label={fmt(Date.UTC(c.y, c.mo - 1, c.d), { dateStyle: 'full' }, 'UTC')}
                  className={cx('when-day', on && 'on', isToday && 'today', c.mo !== view.mo && 'out', dayOf(c) < dayOf(today) && 'past')}
                  onClick={() => pickDay(c)}
                >
                  {c.d}
                </button>
              );
            })}
          </div>
        </section>

        <section className="when-times" aria-label="Start time">
          <label className="when-field">
            <Clock3 size={14} aria-hidden />
            <input
              aria-label="Start time"
              inputMode="text"
              autoComplete="off"
              value={typed ?? clockLabel(draft.h, draft.mi)}
              onFocus={e => {
                setTyped(clockLabel(draft.h, draft.mi));
                requestAnimationFrame(() => e.target.select());
              }}
              onChange={e => setTyped(e.target.value)}
              onBlur={commitTyped}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  commitTyped();
                  (e.target as HTMLInputElement).blur();
                }
                if (e.key === 'Escape' && typed !== null) {
                  e.stopPropagation();
                  setTyped(null);
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          </label>
          <div className="when-slots" ref={list} role="listbox" aria-label="Start times">
            {slots.map(s => {
              const on = s.h === draft.h && s.mi === draft.mi;
              return (
                <button key={`${s.h}:${s.mi}`} type="button" role="option" aria-selected={on} className={cx('when-slot', on && 'on', s.mi === 0 && 'hour')} onClick={() => setDraft(w => ({ ...w, ...s }))}>
                  {clockLabel(s.h, s.mi)}
                </button>
              );
            })}
          </div>
        </section>
      </div>

      <section className="when-length" aria-label="Length">
        <span className="when-label">Length</span>
        <div className="when-chips">
          {DURATIONS.map(d => (
            <button key={d} type="button" className={cx('when-pill', minutes === d && 'on')} aria-pressed={minutes === d} onClick={() => setMinutes(d)}>
              {d < 60 ? `${d}m` : `${d / 60}h`}
            </button>
          ))}
        </div>
        <div className="when-stepper">
          <button type="button" className="icon-button" aria-label="15 minutes shorter" disabled={minutes <= 5} onClick={() => setMinutes(m => Math.max(5, m % 15 ? m - (m % 15) : m - 15))}>
            <Minus size={14} />
          </button>
          <span aria-live="polite">{durationLabel(minutes)}</span>
          <button type="button" className="icon-button" aria-label="15 minutes longer" disabled={minutes >= MAX_MINUTES} onClick={() => setMinutes(m => Math.min(MAX_MINUTES, m - (m % 15) + 15))}>
            <Plus size={14} />
          </button>
        </div>
        <span className="when-ends">Ends {fmt(end, { hour: 'numeric', minute: '2-digit' })}{dayNumber(end) !== dayNumber(start) ? ` ${fmt(end, { weekday: 'short' })}` : ''}</span>
      </section>

      <footer className="when-foot">
        <button
          type="button"
          className="link small"
          onClick={() => {
            const n = wall(Date.now());
            setDraft(n);
            setView({ y: n.y, mo: n.mo });
          }}
        >
          Start now
        </button>
        <span className="spacer" />
        <button type="button" className="ghost sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary sm" disabled={!changed} onClick={save}>
          Save
        </button>
      </footer>
    </div>
  );
}

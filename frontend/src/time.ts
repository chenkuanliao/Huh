import { useSyncExternalStore } from 'react';

/**
 * Dates and times in the owner's chosen time zone (Settings → Time zone).
 * Meetings are stored as instants (UTC), so changing the zone shows the same moment in the new zone.
 */

export const DEFAULT_ZONE = 'America/Chicago';
let zone = DEFAULT_ZONE;
const listeners = new Set<() => void>();

export function isZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const getZone = () => zone;
export function setZone(tz: string | null | undefined) {
  const next = tz && isZone(tz) ? tz : DEFAULT_ZONE;
  if (next === zone) return;
  zone = next;
  formatters.clear();
  listeners.forEach(f => f());
}
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};
/** The current zone; re-renders the caller when Settings changes it. */
export const useZone = () => useSyncExternalStore(subscribe, getZone);

/** The zone this browser is in. */
export const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(opts: Intl.DateTimeFormatOptions, tz = zone, locale?: string) {
  const key = tz + '|' + (locale || '') + '|' + JSON.stringify(opts);
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: tz });
    formatters.set(key, f);
  }
  return f;
}

type When = Date | string | number;
const toDate = (d: When) => (d instanceof Date ? d : new Date(d));

/** Format an instant in the chosen zone (same options as toLocaleString). */
export const fmt = (d: When, opts: Intl.DateTimeFormatOptions, tz = zone) => formatter(opts, tz).format(toDate(d));
export const fmtTime = (d: When, tz = zone) => fmt(d, { hour: 'numeric', minute: '2-digit' }, tz);

/** Wall-clock parts of an instant in a zone. Month is 1–12; weekday 0 = Sunday. */
export type Wall = { y: number; mo: number; d: number; h: number; mi: number };
export function wall(d: When, tz = zone): Wall & { weekday: number } {
  const parts = formatter({ year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short' }, tz, 'en-US').formatToParts(toDate(d));
  const get = (t: string) => parts.find(p => p.type === t)?.value || '0';
  const y = +get('year');
  const mo = +get('month');
  const day = +get('day');
  return { y, mo, d: day, h: +get('hour') % 24, mi: +get('minute'), weekday: new Date(Date.UTC(y, mo - 1, day)).getUTCDay() };
}

/** Minutes the zone is ahead of UTC at an instant. */
export function offsetMinutes(t: number, tz = zone) {
  const w = wall(t, tz);
  return Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(t / 60000) * 60000) / 60000);
}

/** The instant a wall-clock time happens in a zone (a time skipped by a DST jump moves forward). */
export function fromWall(w: Wall, tz = zone): Date {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  let t = guess - offsetMinutes(guess, tz) * 60000;
  const second = guess - offsetMinutes(t, tz) * 60000;
  if (second !== t) t = Math.max(t, second);
  return new Date(t);
}

/** Calendar-day number of an instant in the zone (days since 1970-01-01 there). */
export const dayNumber = (d: When, tz = zone) => {
  const w = wall(d, tz);
  return Math.round(Date.UTC(w.y, w.mo - 1, w.d) / 86400000);
};

/** Whole calendar days from `d` until today in the zone (negative for future days). */
export const daysAgo = (d: When, tz = zone) => dayNumber(Date.now(), tz) - dayNumber(d, tz);

/** "CST", "GMT+8", … for the zone at an instant. */
export function zoneAbbr(d: When = Date.now(), tz = zone) {
  return formatter({ timeZoneName: 'short', hour: 'numeric' }, tz).formatToParts(toDate(d)).find(p => p.type === 'timeZoneName')?.value || tz;
}

/** "Central Standard Time" etc. */
export function zoneLong(d: When = Date.now(), tz = zone) {
  return formatter({ timeZoneName: 'long', hour: 'numeric' }, tz).formatToParts(toDate(d)).find(p => p.type === 'timeZoneName')?.value || tz;
}

/** "GMT−6" style offset for listing zones. */
export function offsetLabel(tz: string, at = Date.now()) {
  const m = offsetMinutes(at, tz);
  const sign = m < 0 ? '−' : '+';
  const a = Math.abs(m);
  return `GMT${sign}${Math.floor(a / 60)}${a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''}`;
}

/** Every IANA zone this browser knows (falls back to a short list on old browsers). */
export function allZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  let list: string[] = [];
  try {
    list = intl.supportedValuesOf?.('timeZone') || [];
  } catch {}
  if (!list.length)
    list = ['America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Taipei', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'Asia/Kolkata', 'Australia/Sydney', 'UTC'];
  return list.includes('UTC') ? list : [...list, 'UTC'];
}

/** "1 hr", "45 min", "1 hr 30 min". */
export function durationLabel(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** Start and end of a meeting, as instants. */
export function meetingSpan(m: { starts_at?: string | null; created_at: string; duration_minutes?: number | null }) {
  const start = new Date(m.starts_at || m.created_at);
  return { start, end: new Date(start.getTime() + (m.duration_minutes || 60) * 60000) };
}

/** When a meeting happens, for sorting and grouping lists (falls back for older clients' data). */
export const meetingDate = (m: { starts_at?: string | null; created_at: string; updated_at?: string }) => m.starts_at || m.created_at || m.updated_at || '';

/** "2:00 – 3:00 PM", "11:30 AM – 12:30 PM", or with the end day when it runs past midnight. */
export function timeRange(start: Date, end: Date, tz = zone) {
  const a = fmt(start, { hour: 'numeric', minute: '2-digit' }, tz);
  const b = fmt(end, { hour: 'numeric', minute: '2-digit' }, tz);
  if (dayNumber(start, tz) !== dayNumber(end, tz)) return `${a} – ${fmt(end, { weekday: 'short' }, tz)} ${b}`;
  // Drop a repeated AM/PM: "2:00 – 3:00 PM".
  const suffix = (s: string) => s.match(/\s?[^\d\s:.]+$/)?.[0] || '';
  const sa = suffix(a);
  return sa && sa === suffix(b) ? `${a.slice(0, -sa.length)} – ${b}` : `${a} – ${b}`;
}

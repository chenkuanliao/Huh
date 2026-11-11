import { fmt } from './time';

/** Default title for a new meeting: its creation time in the chosen zone, e.g. "Fri, Nov 6 · 4:36 PM". */
export function defaultTitle(date: Date) {
  return `${fmt(date, { weekday: 'short', month: 'short', day: 'numeric' })} · ${fmt(date, { hour: 'numeric', minute: '2-digit' })}`;
}

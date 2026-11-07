/** Default title for a new meeting: its creation time, e.g. "Fri, Nov 6 · 4:36 PM". */
export function defaultTitle(date: Date) {
  return `${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

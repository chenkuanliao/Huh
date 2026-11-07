/** The ranked list of AI models (Settings.ai_order). Notes use the first usable one and fall back down the list. */
export type AIEntry = { provider: string; model: string };

/** Why an entry can't be used right now, or null when it can. `connected` is undefined while still loading. */
export function entryProblem(e: AIEntry, connected: boolean | undefined): 'not-connected' | 'no-model' | null {
  if (connected === false) return 'not-connected';
  if (!e.model.trim()) return 'no-model';
  return null;
}

/** Index of the entry that will write the next AI notes: the first one that is connected and has a model. */
export function activeIndex(order: AIEntry[], connected: (provider: string) => boolean | undefined) {
  return order.findIndex(e => !entryProblem(e, connected(e.provider)));
}

/** Move one entry to a new position (clamped), returning a new list. */
export function moveEntry<T>(list: T[], from: number, to: number): T[] {
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (from === target || from < 0 || from >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

export const sameEntry = (a: AIEntry, b: AIEntry) => a.provider === b.provider && a.model.trim() === b.model.trim();

/** Fill an entry's model, or update the first entry of that provider. Returns null when the provider isn't listed. */
export function setProviderModel(order: AIEntry[], provider: string, model: string): AIEntry[] | null {
  const i = order.findIndex(e => e.provider === provider);
  if (i < 0) return null;
  const next = order.map((e, j) => (j === i ? { ...e, model } : e));
  // Changing it to a model already listed elsewhere would duplicate it: keep the earlier one.
  return next.filter((e, j) => next.findIndex(x => sameEntry(x, e)) === j);
}

export type AINotice = {
  at: string;
  from: AIEntry | null;
  from_label: string | null;
  reason: string;
  to: AIEntry | null;
  to_label: string | null;
  exhausted?: boolean;
  final?: boolean;
};

/** Text for the pop-up shown when a model is skipped mid-generation; null when nothing should pop up. */
export function noticeText(n: AINotice, meetingTitle?: string | null) {
  const where = meetingTitle ? ` for “${meetingTitle}”` : '';
  if (n.exhausted) {
    return `None of the AI models in your order could write notes${where}.${n.final ? ' Check Settings → AI notes.' : ' Trying again shortly.'}`;
  }
  // A failure with nowhere to go ends in the "none could" message right after; don't announce it twice.
  if (!n.to_label) return null;
  return `${n.from_label} ${n.reason} — switching to ${n.to_label}${where}.`;
}

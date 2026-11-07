/** Matching and ranking for the command palette (Ctrl/⌘ + K). Pure, so it can be tested without React. */

export type CommandKind = 'action' | 'folder' | 'meeting' | 'setting';

export type Matchable = {
  id: string;
  kind: CommandKind;
  title: string;
  /** Extra words that should find this item (synonyms, folder name, section hints). */
  keywords?: string[];
  /** Archived meetings still match, but always rank after everything else. */
  archived?: boolean;
  /** Small nudge for items that fit where the user is (e.g. actions for the open meeting). */
  boost?: number;
};

/** Typing this first limits results to actions, like a command line. */
export const ACTION_PREFIX = '>';

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();

/** Word starts: after a space or punctuation, or the start of the text. */
const isWordStart = (text: string, i: number) => i === 0 || /[\s\-_/·.,:;()[\]“”"'’&]/.test(text[i - 1]);

/**
 * How well one query token matches one text, 0 when it doesn't.
 * Exact > prefix > start of a word > anywhere > letters in order (fuzzy, for typos like "nwe mtg").
 */
export function scoreToken(token: string, text: string): number {
  if (!token) return 0;
  if (text === token) return 100;
  if (text.startsWith(token)) return 85 - Math.min(10, (text.length - token.length) / 4);
  let wordHit = -1;
  for (let i = text.indexOf(token); i !== -1; i = text.indexOf(token, i + 1)) {
    if (isWordStart(text, i)) {
      wordHit = i;
      break;
    }
  }
  if (wordHit !== -1) return 70 - Math.min(10, wordHit / 4);
  if (token.length >= 2 && text.includes(token)) return 45;
  // Fuzzy: every letter in order; reward letters that start words and letters that run together.
  if (token.length < 2) return 0;
  let at = 0;
  let bonus = 0;
  let prev = -2;
  for (const ch of token) {
    const i = text.indexOf(ch, at);
    if (i === -1) return 0;
    if (isWordStart(text, i)) bonus += 3;
    if (i === prev + 1) bonus += 2;
    prev = i;
    at = i + 1;
  }
  const spread = prev - text.indexOf(token[0]) + 1;
  // Letters scattered across a long title aren't a real match; two letters must sit almost together.
  if (spread > (token.length === 2 ? 3 : token.length * 4)) return 0;
  return Math.min(40, 12 + bonus - Math.max(0, spread - token.length));
}

/** Score an item for a whole query: every word must match its title or keywords. 0 means no match. */
export function scoreItem(query: string, item: Matchable): number {
  const q = norm(query);
  if (!q) return 1;
  const title = norm(item.title);
  const keys = (item.keywords || []).map(norm).filter(Boolean);
  // The whole query against the title first, so "team sync" ranks "Team sync" above "sync with team".
  const whole = scoreToken(q, title);
  const tokens = q.split(/\s+/).filter(Boolean);
  let sum = 0;
  for (const t of tokens) {
    const best = Math.max(scoreToken(t, title), ...keys.map(k => scoreToken(t, k) * 0.7));
    if (!best) return whole ? whole : 0;
    sum += best;
  }
  const base = Math.max(whole, sum / tokens.length);
  // Only a real hit (a word or substring of the name) earns the nudge, so loose matches stay low.
  return base + (base >= 45 ? item.boost || 0 : 0);
}

export type Mode = { only?: CommandKind; text: string };

/** Reads an optional prefix: ">" means actions only. */
export function parseQuery(raw: string): Mode {
  const t = raw.trimStart();
  if (t.startsWith(ACTION_PREFIX)) return { only: 'action', text: t.slice(1).trim() };
  return { text: raw.trim() };
}

/** Filters and ranks; archived items always come after the rest. Stable for ties. */
export function rank<T extends Matchable>(items: T[], raw: string): { item: T; score: number }[] {
  const { only, text } = parseQuery(raw);
  const out: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    if (only && item.kind !== only) return;
    const score = scoreItem(text, item);
    if (score > 0) out.push({ item, score, i });
  });
  out.sort((a, b) => Number(!!a.item.archived) - Number(!!b.item.archived) || b.score - a.score || a.i - b.i);
  return out;
}

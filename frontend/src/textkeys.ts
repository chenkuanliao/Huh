/**
 * Note-taking keyboard behaviour for Markdown textareas:
 *  - Tab indents (list lines and multi-line selections indent whole lines), otherwise inserts a tab.
 *  - Shift+Tab outdents the current line(s).
 *  - Enter continues a bullet, numbered or checkbox list; Enter on an empty item ends the list.
 *  - Escape leaves the editor so Tab can move focus again.
 * Edits go through insertText so the browser's undo history keeps working.
 */
const INDENT = '    ';
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s/;
const ITEM = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;

function replace(el: HTMLTextAreaElement, start: number, end: number, text: string) {
  el.focus();
  el.setSelectionRange(start, end);
  let ok = false;
  try {
    // Removing text goes through "delete" (insertText with "" misplaces the caret in Chrome).
    ok = text ? document.execCommand('insertText', false, text) : start === end || document.execCommand('delete');
  } catch {}
  if (!ok) {
    // No execCommand support: edit directly (undo history is not preserved).
    el.setRangeText(text, start, end, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.setSelectionRange(start + text.length, start + text.length);
}

function lineBounds(value: string, start: number, end: number) {
  const from = value.lastIndexOf('\n', start - 1) + 1;
  // A selection ending right after a newline does not include the next line.
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const nl = value.indexOf('\n', last);
  return { from, to: nl === -1 ? value.length : nl };
}

export function handleEditorKeys(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
  // Never interfere with an IME composition (Chinese/Japanese input).
  if (e.nativeEvent.isComposing || e.keyCode === 229) return false;
  const el = e.currentTarget;
  const { value, selectionStart: s, selectionEnd: t } = el;

  if (e.key === 'Escape') {
    el.blur();
    return true;
  }

  if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    const { from, to } = lineBounds(value, s, t);
    const block = value.slice(from, to);
    const multi = block.includes('\n');
    if (!e.shiftKey && !multi && !LIST_LINE.test(block)) {
      replace(el, s, t, '\t');
      return true;
    }
    const lines = block.split('\n');
    const changed = lines.map(l => (e.shiftKey ? l.replace(/^(\t| {1,4})/, '') : l.length ? INDENT + l : l));
    const next = changed.join('\n');
    if (next === block) return true;
    const delta = changed[0].length - lines[0].length;
    replace(el, from, to, next);
    if (multi || t > s) el.setSelectionRange(from, from + next.length);
    else {
      const caret = Math.max(from, s + delta);
      el.setSelectionRange(caret, caret);
    }
    return true;
  }

  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && s === t) {
    const from = value.lastIndexOf('\n', s - 1) + 1;
    const nl = value.indexOf('\n', s);
    const line = value.slice(from, nl === -1 ? value.length : nl);
    const m = line.match(ITEM);
    if (!m || s < from + m[0].length) return false;
    e.preventDefault();
    const [marker, indent, bullet, num, punct, space, task] = m;
    if (!line.slice(marker.length).trim()) {
      // Empty item: end the list (or step out one level if nested).
      if (indent.length) replace(el, from, from + marker.length, indent.slice(Math.min(indent.length, INDENT.length)) + marker.trimStart());
      else replace(el, from, from + marker.length, '');
      return true;
    }
    const nextMarker = `${indent}${bullet ?? `${Number(num) + 1}${punct}`}${space}${task ? '[ ] ' : ''}`;
    replace(el, s, s, '\n' + nextMarker);
    return true;
  }
  return false;
}

/**
 * Indent (or outdent) one list line, as Tab / Shift+Tab would; for the phone's swipe on a line.
 * Returns false when the line isn't a bullet, numbered or checkbox item, or can't move further.
 */
export function shiftListLine(el: HTMLTextAreaElement, lineIndex: number, outdent: boolean): boolean {
  const { value } = el;
  let from = 0;
  for (let i = 0; i < lineIndex; i++) {
    const nl = value.indexOf('\n', from);
    if (nl === -1) return false;
    from = nl + 1;
  }
  const nl = value.indexOf('\n', from);
  const to = nl === -1 ? value.length : nl;
  const line = value.slice(from, to);
  if (!LIST_LINE.test(line)) return false;
  if (!outdent) {
    // Nest only under a list item on the line above (indenting a first item would make it a code block).
    // The nearest line above that has something on it (blank lines between items don't count).
    const above = value.slice(0, Math.max(0, from - 1)).split('\n').reverse();
    const prev = from > 0 ? above.find(l => l.trim()) ?? '' : '';
    const width = (l: string) => (l.match(/^\s*/)?.[0] ?? '').replace(/\t/g, INDENT).length;
    if (!LIST_LINE.test(prev) || width(line) > width(prev)) return false;
  }
  const next = outdent ? line.replace(/^(\t| {1,4})/, '') : INDENT + line;
  if (next === line) return false;
  replace(el, from, to, next);
  el.setSelectionRange(from + next.length, from + next.length);
  return true;
}

/**
 * List items with nothing written yet (a "- " or "- [ ] " left by Enter) are blanked for reading,
 * so they don't show as a stray bullet or a literal "[ ]". Line numbers stay the same.
 */
export function blankEmptyItems(md: string): string {
  let fence = false;
  return md
    .split('\n')
    .map(l => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      return !fence && /^\s*(?:[-*+]|\d+[.)])(?:\s+\[[ xX]\])?\s*$/.test(l) ? '' : l;
    })
    .join('\n');
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { cx } from './ui';

type Hit = { range?: Range; start?: number; end?: number };
const MAX_HITS = 5000;
const supportsHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof (window as any).Highlight === 'function';

/** The visible find target inside `root`: an element marked `data-find-root` that is currently shown. */
function findTarget(root: HTMLElement | null) {
  if (!root) return null;
  const candidates = Array.from(root.querySelectorAll<HTMLElement>('[data-find-root]'));
  return candidates.find(el => el.offsetParent !== null || el.getClientRects().length > 0) ?? null;
}

function visibleTextarea(el: HTMLElement) {
  const t = el.querySelector<HTMLTextAreaElement>('textarea');
  return t && t.offsetParent !== null ? t : null;
}

/* Mirror layer behind a textarea so matches can be highlighted while editing. */
const MIRRORED = [
  'boxSizing', 'width', 'height', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'tabSize', 'textIndent', 'textTransform', 'borderRadius',
] as const;

function buildMirror(area: HTMLTextAreaElement, hits: Hit[], current: number) {
  const parent = area.parentElement!;
  let mirror = parent.querySelector<HTMLDivElement>(':scope > .find-mirror');
  if (!mirror) {
    mirror = document.createElement('div');
    mirror.className = 'find-mirror';
    mirror.setAttribute('aria-hidden', 'true');
    parent.insertBefore(mirror, area);
  }
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  const cs = getComputedStyle(area);
  for (const k of MIRRORED) (mirror.style as any)[k] = (cs as any)[k];
  mirror.style.borderColor = 'transparent';
  mirror.style.borderStyle = 'solid';
  mirror.style.top = `${area.offsetTop}px`;
  mirror.style.left = `${area.offsetLeft}px`;
  mirror.style.background = cs.backgroundColor;
  // Same scrollbar presence as the textarea so lines wrap identically.
  mirror.style.overflowY = area.scrollHeight > area.clientHeight ? 'scroll' : 'hidden';
  area.classList.add('find-active');
  const text = area.value;
  mirror.textContent = '';
  let at = 0;
  hits.forEach((h, i) => {
    mirror!.append(document.createTextNode(text.slice(at, h.start)));
    const mark = document.createElement('mark');
    mark.className = i === current ? 'find-hit current' : 'find-hit';
    mark.textContent = text.slice(h.start, h.end);
    mirror!.append(mark);
    at = h.end!;
  });
  mirror.append(document.createTextNode(text.slice(at) + '\n'));
  mirror.scrollTop = area.scrollTop;
  return mirror;
}

function removeMirror(area: HTMLTextAreaElement | null) {
  if (!area) return;
  area.classList.remove('find-active');
  area.parentElement?.querySelector(':scope > .find-mirror')?.remove();
}

export default function FindBar({
  open,
  onClose,
  root,
  initialQuery,
  anchorSelector,
  watch,
}: {
  open: boolean;
  onClose: () => void;
  root: React.RefObject<HTMLElement | null>;
  initialQuery?: { text: string; n: number } | null;
  /** On an incoming query, start at the first match inside this element. */
  anchorSelector?: string | null;
  /** Re-run the search when this changes (e.g. the active tab). */
  watch?: unknown;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const hits = useRef<Hit[]>([]);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const indexRef = useRef(0);
  indexRef.current = index;
  const anchor = useRef<string | null>(null);

  const clear = useCallback(() => {
    if (supportsHighlights) {
      (CSS as any).highlights.delete('huh-find');
      (CSS as any).highlights.delete('huh-find-current');
    }
    removeMirror(area.current);
  }, []);

  const paint = useCallback((current: number, scroll: boolean) => {
    const list = hits.current;
    if (area.current) {
      const ta = area.current;
      const mirror = buildMirror(ta, list, current);
      if (scroll && list[current]) {
        const mark = mirror.querySelectorAll('mark')[current] as HTMLElement | undefined;
        if (mark) {
          ta.scrollTop = Math.max(0, mark.offsetTop - ta.clientHeight / 2);
          mirror.scrollTop = ta.scrollTop;
          const box = ta.getBoundingClientRect();
          if (box.bottom < 0 || box.top > innerHeight) ta.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
      return;
    }
    if (supportsHighlights) {
      const H = (window as any).Highlight;
      (CSS as any).highlights.set('huh-find', new H(...list.map(h => h.range!)));
      (CSS as any).highlights.set('huh-find-current', list[current] ? new H(list[current].range!) : new H());
    }
    if (scroll && list[current]?.range) {
      const el = list[current].range!.startContainer.parentElement;
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, []);

  const compute = useCallback(
    (keepIndex: boolean, scroll: boolean) => {
      const q = query.trim().toLowerCase();
      const target = findTarget(root.current);
      const ta = target ? visibleTextarea(target) : null;
      if (area.current && area.current !== ta) removeMirror(area.current);
      area.current = ta;
      const found: Hit[] = [];
      if (q && target) {
        if (ta) {
          const text = ta.value.toLowerCase();
          for (let i = text.indexOf(q); i !== -1 && found.length < MAX_HITS; i = text.indexOf(q, i + q.length)) found.push({ start: i, end: i + q.length });
        } else {
          const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
            acceptNode: n => ((n.parentElement?.closest('[data-find-skip], button, audio, .popover') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)),
          });
          for (let n = walker.nextNode(); n && found.length < MAX_HITS; n = walker.nextNode()) {
            const text = (n.nodeValue || '').toLowerCase();
            for (let i = text.indexOf(q); i !== -1 && found.length < MAX_HITS; i = text.indexOf(q, i + q.length)) {
              const r = document.createRange();
              r.setStart(n, i);
              r.setEnd(n, i + q.length);
              found.push({ range: r });
            }
          }
        }
      }
      hits.current = found;
      let next = keepIndex ? Math.min(indexRef.current, Math.max(0, found.length - 1)) : 0;
      if (!keepIndex && anchor.current && !ta) {
        const el = document.querySelector(anchor.current);
        const i = el ? found.findIndex(h => el.contains(h.range!.startContainer)) : -1;
        if (i >= 0) next = i;
        anchor.current = null;
      }
      setCount(found.length);
      setIndex(next);
      if (!q) clear();
      else paint(next, scroll);
    },
    [query, root, paint, clear],
  );

  // Incoming query (e.g. from global search).
  useEffect(() => {
    if (!initialQuery) return;
    anchor.current = anchorSelector ?? null;
    setQuery(initialQuery.text);
  }, [initialQuery?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open)
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.select();
      });
    else clear();
  }, [open, clear]);

  // Search as you type, and again when the tab changes.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => compute(false, true), anchor.current ? 120 : 0);
    return () => window.clearTimeout(t);
  }, [query, open, watch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep results fresh while content changes (polling updates, typing in the note).
  useEffect(() => {
    if (!open || !query.trim()) return;
    const target = findTarget(root.current);
    if (!target) return;
    let t = 0;
    const refresh = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => compute(true, false), 150);
    };
    const observer = new MutationObserver(refresh);
    observer.observe(target, { childList: true, subtree: true, characterData: true });
    const ta = visibleTextarea(target);
    const sync = () => {
      const m = ta?.parentElement?.querySelector<HTMLDivElement>(':scope > .find-mirror');
      if (m && ta) m.scrollTop = ta.scrollTop;
    };
    ta?.addEventListener('input', refresh);
    ta?.addEventListener('scroll', sync);
    window.addEventListener('resize', refresh);
    return () => {
      observer.disconnect();
      ta?.removeEventListener('input', refresh);
      ta?.removeEventListener('scroll', sync);
      window.removeEventListener('resize', refresh);
      window.clearTimeout(t);
    };
  }, [open, query, watch, compute, root]);

  useEffect(() => () => clear(), [clear]);

  const go = useCallback(
    (step: number) => {
      const n = hits.current.length;
      if (!n) return;
      const next = (indexRef.current + step + n) % n;
      setIndex(next);
      paint(next, true);
    },
    [paint],
  );

  // ⌘G / F3 for next, with Shift for previous, while the bar is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F3' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g')) {
        e.preventDefault();
        go(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, go]);

  if (!open) return null;
  const empty = query.trim() && !count;
  return (
    <div className={cx('find-bar', empty && 'none')} role="search">
      <Search size={15} className="muted-icon" />
      <input
        ref={input}
        aria-label="Find in this tab"
        placeholder="Find in this tab"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="find-count" aria-live="polite">
        {query.trim() ? (count ? `${index + 1} of ${count >= MAX_HITS ? `${MAX_HITS}+` : count}` : 'No results') : ''}
      </span>
      <button type="button" className="icon-button sm" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={!count} onClick={() => go(-1)}>
        <ChevronUp size={16} />
      </button>
      <button type="button" className="icon-button sm" aria-label="Next match" title="Next (Enter)" disabled={!count} onClick={() => go(1)}>
        <ChevronDown size={16} />
      </button>
      <button type="button" className="icon-button sm" aria-label="Close find" title="Close (Esc)" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}

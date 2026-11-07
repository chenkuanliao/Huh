import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AudioLines, FileText, Search, Sparkles, Type } from 'lucide-react';
import { api } from './api';
import { clock } from './AudioPlayer';
import { stripSources } from './Markdown';
import { cx, Spinner } from './ui';

export type SearchResult = {
  meeting_id: string;
  title: string;
  field: 'title' | 'notes' | 'enhanced' | 'transcript';
  snippet: string;
  updated_at: string;
  recording_id?: string;
  start?: number;
  segment_id?: string;
};

const FIELD = {
  title: { label: 'Title', icon: <Type size={14} /> },
  notes: { label: 'My notes', icon: <FileText size={14} /> },
  enhanced: { label: 'AI notes', icon: <Sparkles size={14} /> },
  transcript: { label: 'Transcript', icon: <AudioLines size={14} /> },
};

/** Snippets come from Markdown; show them as plain prose. */
const readable = (text: string) =>
  stripSources(text)
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/(^|\s)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (!q) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, i + q.length)) {
    parts.push(text.slice(at, i), <mark key={i}>{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

export default function SearchPalette({ open, onClose, onSelect, initial = '' }: { open: boolean; onClose: () => void; onSelect: (r: SearchResult, query: string) => void; initial?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery(initial);
    setActive(0);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const controller = new AbortController();
    const t = window.setTimeout(async () => {
      try {
        const r = await api<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        setResults(r.results);
        setActive(0);
      } catch {
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 140);
    return () => {
      controller.abort();
      window.clearTimeout(t);
    };
  }, [query, open]);

  // Group by meeting while keeping a flat order for keyboard navigation.
  const groups = useMemo(() => {
    const out: { id: string; title: string; updated: string; items: { r: SearchResult; i: number }[] }[] = [];
    let i = 0;
    for (const r of results) {
      let g = out.find(x => x.id === r.meeting_id);
      if (!g) out.push((g = { id: r.meeting_id, title: r.title, updated: r.updated_at, items: [] }));
      g.items.push({ r, i: 0 });
    }
    for (const g of out) for (const it of g.items) it.i = i++;
    return out;
  }, [results]);
  const flat = groups.flatMap(g => g.items.map(x => x.r));

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;
  const choose = (r: SearchResult) => {
    onSelect(r, query.trim());
    onClose();
  };

  return createPortal(
    <div className="modal-backdrop palette-backdrop" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search everything">
        <div className="palette-input">
          <Search size={18} className="muted-icon" />
          <input
            ref={input}
            aria-label="Search all meetings"
            placeholder="Search notes, AI notes and transcripts…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive(a => Math.min(a + 1, flat.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive(a => Math.max(a - 1, 0));
              } else if (e.key === 'Enter' && flat[active]) {
                e.preventDefault();
                choose(flat[active]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />
          {loading && <Spinner size={15} />}
          <kbd>Esc</kbd>
        </div>
        <div className="palette-results" ref={list} role="listbox" aria-label="Search results">
          {query.trim().length < 2 ? (
            <p className="palette-empty">Type at least two characters. Searches every meeting’s title, notes, AI notes and transcript.</p>
          ) : !loading && !results.length ? (
            <p className="palette-empty">No matches for “{query.trim()}”.</p>
          ) : (
            groups.map(g => (
              <Fragment key={g.id}>
                <div className="palette-group">
                  <span className="truncate">{g.title || 'Untitled meeting'}</span>
                  <span>{new Date(g.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                </div>
                {g.items.map(({ r, i }) => (
                  <div
                    key={i}
                    data-index={i}
                    role="option"
                    aria-selected={i === active}
                    className={cx('palette-item', i === active && 'active')}
                    onPointerMove={() => setActive(i)}
                    onClick={() => choose(r)}
                  >
                    <span className="palette-field">
                      {FIELD[r.field].icon}
                      {r.field === 'transcript' && r.start != null ? clock(r.start) : FIELD[r.field].label}
                    </span>
                    <span className="palette-snippet">
                      <Highlighted text={readable(r.snippet)} query={query} />
                    </span>
                  </div>
                ))}
              </Fragment>
            ))
          )}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>Enter</kbd> to open
          </span>
          <span>
            <kbd>Ctrl/⌘ F</kbd> inside a meeting finds within the open tab
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

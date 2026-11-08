import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { blankEmptyItems } from './textkeys';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AudioLines, ChevronRight, Copy, NotebookPen, Quote, X } from 'lucide-react';
import type { Recording, Segment } from './api';
import { ContextMenu, cx } from './ui';

const LineContext = createContext<number | null>(null);
const TASK = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/;

/** Hidden source markers written into AI notes: [[12:34]], [[1:02:03#2]], [[notes]], comma-separated. */
const TOKEN = String.raw`(?:notes|\d+(?::\d{2}){1,2}(?:#\d+)?)`;
export const SOURCE_MARKER = new RegExp(String.raw`[ \t]*\[\[\s*(${TOKEN}(?:\s*,\s*${TOKEN})*)\s*\]\]`, 'gi');
export const stripSources = (text: string) => text.replace(SOURCE_MARKER, '');

/** Flip the `[ ]` / `[x]` marker on a 1-based source line. */
export function toggleTask(text: string, line: number): string {
  const lines = text.split('\n');
  const current = lines[line - 1];
  if (current === undefined || !TASK.test(current)) return text;
  lines[line - 1] = current.replace(TASK, (_, a, mark, b) => `${a}${mark === ' ' ? 'x' : ' '}${b}`);
  return lines.join('\n');
}

export type SourceInfo = {
  segments: Segment[];
  recordings: Recording[];
  onJump?: (recordingId: string, seconds: number) => void;
};
const SourceContext = createContext<SourceInfo | null>(null);

function TaskBox({ checked, interactive }: { checked: boolean; interactive: boolean }) {
  const line = useContext(LineContext);
  return <input type="checkbox" className="task-box" checked={checked} readOnly tabIndex={interactive ? 0 : -1} aria-disabled={!interactive} data-line={line ?? undefined} />;
}

/* --------------------------------------------------------- source lookup */

type HastNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[]; position?: { start: { offset?: number } } };
const BLOCKS = new Set(['p', 'ul', 'ol', 'li', 'table', 'blockquote', 'pre']);

/** Source tokens attached to this block's own inline content (not nested blocks, which carry their own). */
function tokensOf(node: HastNode | undefined): string[] {
  const out: string[] = [];
  const walk = (n: HastNode, top: boolean) => {
    if (!top && n.type === 'element' && BLOCKS.has(n.tagName || '')) return;
    if (n.type === 'element' && n.tagName === 'a') {
      const href = String(n.properties?.href || '');
      if (href.startsWith('#src=')) out.push(...decodeURIComponent(href.slice(5)).split(','));
    }
    n.children?.forEach(c => walk(c, false));
  };
  if (node) walk(node, true);
  return [...new Set(out.map(t => t.trim().toLowerCase()).filter(Boolean))];
}

function toSeconds(stamp: string) {
  return stamp.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

function resolve(token: string, info: SourceInfo | null) {
  if (token === 'notes') return { kind: 'notes' as const };
  const [time, rec] = token.split('#');
  const seconds = toSeconds(time);
  const recording = info?.recordings[(Number(rec) || 1) - 1] ?? info?.recordings[0];
  const segs = info && recording ? info.segments.filter(s => s.recording_id === recording.id) : [];
  // The line that starts at (or just before) the cited time.
  const segment = segs.reduce<Segment | undefined>((best, s) => (s.start <= seconds + 0.6 && (!best || s.start > best.start) ? s : best), undefined) ?? segs[0];
  return { kind: 'time' as const, time, seconds, recording, segment, multi: (info?.recordings.length || 0) > 1 };
}

function SourceCard({ tokens, onClose }: { tokens: string[]; onClose: () => void }) {
  const info = useContext(SourceContext);
  return (
    <>
      <div className="source-card-head">
        <span>
          Sources <span className="source-count">{tokens.length}</span>
        </span>
        <button type="button" className="icon-button sm source-close" aria-label="Hide sources" title="Hide sources (Esc)" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="source-list">
        {tokens.map(t => {
          const r = resolve(t, info);
          if (r.kind === 'notes')
            return (
              <div key={t} className="source-row-item">
                <span className="source-when notes">
                  <NotebookPen size={12} /> Notes
                </span>
                <span className="source-quote">From your written notes</span>
              </div>
            );
          const jump = info?.onJump && r.recording ? () => info.onJump!(r.recording!.id, r.segment?.start ?? r.seconds) : undefined;
          return (
            <button key={t} type="button" className="source-row-item time" disabled={!jump} onClick={jump} title={jump ? 'Open the transcript here' : undefined}>
              <span className="source-when">
                <AudioLines size={12} /> {r.time}
              </span>
              <span className="source-quote">
                {r.multi && r.recording && <span className="source-rec">{r.recording.label}</span>}
                {r.segment ? `“${r.segment.text}”` : <span className="muted">No transcript line at this time</span>}
              </span>
              {jump && <ChevronRight size={14} className="muted-icon source-go" />}
            </button>
          );
        })}
      </div>
    </>
  );
}

/** Which cited block (by source offset) has its sources shown; one at a time per document. */
const OpenContext = createContext<{ open: string | null; setOpen: (id: string | null) => void } | null>(null);

/**
 * A block whose content has sources. Hovering only highlights it; right-click (or tap on touch screens)
 * offers "Show sources", which opens an inline panel right under the block, pushing text down rather than covering it.
 */
function SourceBlock({ tag, id, tokens, className, children, ...props }: { tag: string; id: string; tokens: string[]; className?: string; children?: ReactNode } & Record<string, unknown>) {
  const ref = useRef<HTMLElement>(null);
  const panel = useRef<HTMLElement>(null);
  const state = useContext(OpenContext);
  const open = state?.open === id;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const setOpen = (value: boolean) => state?.setOpen(value ? id : null);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => panel.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || document.querySelector('.popover')) return;
      e.stopPropagation();
      state?.setOpen(null);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = () => {
    const selected = window.getSelection()?.toString();
    const clone = ref.current?.cloneNode(true) as HTMLElement | undefined;
    clone?.querySelector('.source-panel')?.remove();
    void navigator.clipboard?.writeText(selected || clone?.textContent?.trim() || '');
  };
  // Inside list items and table cells the panel lives in the block; after paragraphs and headings it is a sibling.
  const inside = tag === 'li' || tag === 'td';
  const Panel = (inside ? 'span' : 'div') as 'div';
  const sourcePanel = open && (
    <Panel ref={panel as React.RefObject<HTMLDivElement>} className="source-panel" role="region" aria-label="Sources" contentEditable={false}>
      <SourceCard tokens={tokens} onClose={() => setOpen(false)} />
    </Panel>
  );
  const Tag = tag as 'p';
  return (
    <>
      <Tag
        ref={ref as React.RefObject<HTMLParagraphElement>}
        className={cx(className, 'has-source', open && 'source-open', menu && 'source-menu')}
        onContextMenu={(e: React.MouseEvent) => {
          const t = e.target as HTMLElement;
          // Shift+right-click (and links/inputs) keep the browser menu.
          if (e.shiftKey || t.closest('a, input, button, .source-panel')) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onClick={(e: React.MouseEvent) => {
          const t = e.target as HTMLElement;
          if (t.closest('a, input, button, .source-panel') || window.getSelection()?.toString()) return;
          if (matchMedia('(hover: none)').matches) setOpen(!open);
        }}
        {...props}
      >
        {children}
        {inside && sourcePanel}
      </Tag>
      {!inside && sourcePanel}
      <ContextMenu
        at={menu}
        onClose={() => setMenu(null)}
        label="Note actions"
        items={[
          {
            label: open ? 'Hide sources' : 'Show sources',
            hint: `${tokens.length} ${tokens.length === 1 ? 'source' : 'sources'}`,
            icon: <Quote size={15} />,
            onSelect: () => setOpen(!open),
          },
          { label: window.getSelection()?.toString() ? 'Copy selection' : 'Copy text', icon: <Copy size={15} />, onSelect: copy },
        ]}
      />
    </>
  );
}

function withSources(tag: string) {
  return ({ node, children, className, ...props }: { node?: HastNode; children?: ReactNode; className?: string } & Record<string, unknown>) => {
    const tokens = tokensOf(node);
    const Tag = tag as 'p';
    if (!tokens.length)
      return (
        <Tag className={className} {...props}>
          {children}
        </Tag>
      );
    return (
      <SourceBlock tag={tag} id={String(node?.position?.start.offset ?? '')} tokens={tokens} className={className} {...props}>
        {children}
      </SourceBlock>
    );
  };
}

const P = withSources('p');

/** Puts text on the clipboard; false when the browser refuses. */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A code block, with a button that copies its code. */
function Pre({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) {
  const ref = useRef<HTMLPreElement>(null);
  const [state, setState] = useState<'idle' | 'ok' | 'bad'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <div className="code-wrap">
      <pre ref={ref} {...props}>
        {children}
      </pre>
      <button
        type="button"
        className="code-copy"
        aria-label="Copy code"
        onClick={() => void copyText((ref.current?.innerText ?? '').replace(/\n$/, '')).then(ok => setState(ok ? 'ok' : 'bad'))}
      >
        {state === 'ok' ? 'Copied' : state === 'bad' ? 'Copy failed' : 'Copy'}
      </button>
    </div>
  );
}
const TD = withSources('td');
const H2 = withSources('h2');
const H3 = withSources('h3');
const LiInner = withSources('li');

/**
 * GitHub-flavored Markdown (task lists, tables, strikethrough). Raw HTML is not rendered.
 * When `onToggleTask` is given, clicking a checkbox reports its source line.
 * Hidden source markers are never shown; with `sources`, right-clicking a cited block offers to show them.
 */
export default function Markdown({ text, onToggleTask, className, empty, sources }: { text: string; onToggleTask?: (line: number) => void; className?: string; empty?: string; sources?: SourceInfo }) {
  const interactive = !!onToggleTask;
  // Markers become empty fragment links that the renderer hides and blocks pick up.
  const prepared = blankEmptyItems(text || '').replace(SOURCE_MARKER, (_, body: string) => `[​](#src=${encodeURIComponent(body.replace(/\s+/g, ''))})`);
  const [open, setOpen] = useState<string | null>(null);
  // Stable renderers: new component functions on each render would remount every block (and close any open menu).
  const components = useMemo<Components>(
    () => ({
      li: ({ node, children, className: liClass, ...props }) => (
        <LineContext.Provider value={node?.position?.start.line ?? null}>
          <LiInner node={node as HastNode} className={cx(liClass, liClass?.includes('task-list-item') && interactive && 'interactive')} {...props}>
            {children}
          </LiInner>
        </LineContext.Provider>
      ),
      p: ({ node, ...props }) => <P node={node as HastNode} {...props} />,
      pre: ({ node, ...props }) => <Pre {...props} />,
      td: ({ node, ...props }) => <TD node={node as HastNode} {...props} />,
      h2: ({ node, ...props }) => <H2 node={node as HastNode} {...props} />,
      h3: ({ node, ...props }) => <H3 node={node as HastNode} {...props} />,
      input: ({ node, ...props }) => (props.type === 'checkbox' ? <TaskBox checked={!!props.checked} interactive={interactive} /> : <input {...props} />),
      a: ({ node, href, ...props }) => (href?.startsWith('#src=') ? null : <a href={href} {...props} target="_blank" rel="noreferrer" />),
    }),
    [interactive],
  );
  const openState = useMemo(() => ({ open, setOpen }), [open]);
  return (
    <SourceContext.Provider value={sources ?? null}>
      <OpenContext.Provider value={openState}>
        <article
          className={cx('markdown', className)}
          onClick={e => {
            const t = e.target as HTMLElement;
            if (!onToggleTask || !(t instanceof HTMLInputElement) || t.type !== 'checkbox') return;
            const line = Number(t.dataset.line);
            if (line) onToggleTask(line);
          }}
          onKeyDown={e => {
            const t = e.target as HTMLElement;
            if (onToggleTask && t instanceof HTMLInputElement && t.type === 'checkbox' && (e.key === ' ' || e.key === 'Enter')) {
              e.preventDefault();
              const line = Number(t.dataset.line);
              if (line) onToggleTask(line);
            }
          }}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {prepared || (empty ? `*${empty}*` : '')}
          </ReactMarkdown>
        </article>
      </OpenContext.Provider>
    </SourceContext.Provider>
  );
}

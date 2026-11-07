import { createContext, ReactNode, useContext, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AudioLines, ChevronRight, NotebookPen } from 'lucide-react';
import type { Recording, Segment } from './api';
import { cx, Popover } from './ui';

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

type HastNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };
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
    <div className="source-card">
      <div className="source-card-head">Sources</div>
      {tokens.map(t => {
        const r = resolve(t, info);
        if (r.kind === 'notes')
          return (
            <div key={t} className="source-row-item">
              <NotebookPen size={14} />
              <span>From your written notes</span>
            </div>
          );
        const jump = info?.onJump && r.recording ? () => (info.onJump!(r.recording!.id, r.segment?.start ?? r.seconds), onClose()) : undefined;
        return (
          <button key={t} type="button" className="source-row-item time" disabled={!jump} onClick={jump}>
            <AudioLines size={14} />
            <span className="option-text">
              <span className="source-when">
                {r.time}
                {r.multi && r.recording ? ` · ${r.recording.label}` : ''}
              </span>
              {r.segment && <span className="source-quote">“{r.segment.text}”</span>}
            </span>
            {jump && <ChevronRight size={14} className="muted-icon" />}
          </button>
        );
      })}
    </div>
  );
}

/** A block whose content has sources: shows them in a card on hover (or tap). */
function SourceBlock({ tag, tokens, className, children, ...props }: { tag: string; tokens: string[]; className?: string; children?: ReactNode } & Record<string, unknown>) {
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const schedule = (value: boolean, delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(value), delay);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const Tag = tag as 'p';
  return (
    <>
      <Tag
        ref={ref as React.RefObject<HTMLParagraphElement>}
        className={cx(className, 'has-source', open && 'source-open')}
        onMouseEnter={() => schedule(true, 280)}
        onMouseLeave={() => schedule(false, 180)}
        onClick={(e: React.MouseEvent) => {
          const t = e.target as HTMLElement;
          if (t.closest('a, input, button') || window.getSelection()?.toString()) return;
          if (matchMedia('(hover: none)').matches) setOpen(o => !o);
        }}
        {...props}
      >
        {children}
      </Tag>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement="bottom-start" minWidth={260} maxWidth={380} className="source-popover" role="presentation">
        <div onMouseEnter={() => window.clearTimeout(timer.current)} onMouseLeave={() => schedule(false, 180)}>
          <SourceCard tokens={tokens} onClose={() => setOpen(false)} />
        </div>
      </Popover>
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
      <SourceBlock tag={tag} tokens={tokens} className={className} {...props}>
        {children}
      </SourceBlock>
    );
  };
}

const P = withSources('p');
const TD = withSources('td');
const H2 = withSources('h2');
const H3 = withSources('h3');
const LiInner = withSources('li');

/**
 * GitHub-flavored Markdown (task lists, tables, strikethrough). Raw HTML is not rendered.
 * When `onToggleTask` is given, clicking a checkbox reports its source line.
 * Hidden source markers are never shown; with `sources`, hovering a block reveals them.
 */
export default function Markdown({ text, onToggleTask, className, empty, sources }: { text: string; onToggleTask?: (line: number) => void; className?: string; empty?: string; sources?: SourceInfo }) {
  const interactive = !!onToggleTask;
  // Markers become empty fragment links that the renderer hides and blocks pick up.
  const prepared = (text || '').replace(SOURCE_MARKER, (_, body: string) => `[​](#src=${encodeURIComponent(body.replace(/\s+/g, ''))})`);
  return (
    <SourceContext.Provider value={sources ?? null}>
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
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            li: ({ node, children, className: liClass, ...props }) => (
              <LineContext.Provider value={node?.position?.start.line ?? null}>
                <LiInner node={node as HastNode} className={cx(liClass, liClass?.includes('task-list-item') && interactive && 'interactive')} {...props}>
                  {children}
                </LiInner>
              </LineContext.Provider>
            ),
            p: ({ node, ...props }) => <P node={node as HastNode} {...props} />,
            td: ({ node, ...props }) => <TD node={node as HastNode} {...props} />,
            h2: ({ node, ...props }) => <H2 node={node as HastNode} {...props} />,
            h3: ({ node, ...props }) => <H3 node={node as HastNode} {...props} />,
            input: ({ node, ...props }) => (props.type === 'checkbox' ? <TaskBox checked={!!props.checked} interactive={interactive} /> : <input {...props} />),
            a: ({ node, href, ...props }) => (href?.startsWith('#src=') ? null : <a href={href} {...props} target="_blank" rel="noreferrer" />),
          }}
        >
          {prepared || (empty ? `*${empty}*` : '')}
        </ReactMarkdown>
      </article>
    </SourceContext.Provider>
  );
}

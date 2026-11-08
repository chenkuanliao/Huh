import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { isPhoneLayout, setPhoneEditing } from './sheet';
import Markdown, { SourceInfo, toggleTask } from './Markdown';
import { handleEditorKeys, shiftListLine } from './textkeys';
import LiveEditor from './LiveEditor';
import { EditorView, revealLine, shiftLine } from './live';
import { ChevronDown, Expand, FileText, LayoutTemplate, Maximize2, Minimize2, Settings2, Shrink } from 'lucide-react';
import { api, ApiError, errorText, send, Meeting, Template } from './api';
import { cx, Menu, Segmented } from './ui';

type Field = 'notes' | 'enhanced_notes';
/** live: formatted as you type (the line being edited shows its Markdown); write: plain Markdown; preview: read only. */
export type NoteView = 'live' | 'write' | 'preview';
type FocusLayout = 'live' | 'split' | 'write' | 'preview';
const VIEW_OPTIONS = [
  { value: 'live' as const, label: 'Live' },
  { value: 'write' as const, label: 'Source' },
  { value: 'preview' as const, label: 'Read' },
];

/** Words for Latin text plus one per CJK character, which is how CJK writing is usually counted. */
function countWords(text: string) {
  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g)?.length || 0;
  const latin = text.replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length || 0;
  return cjk + latin;
}

/** Top offset and height of a source line inside a textarea, accounting for soft wrapping. */
function measureLine(el: HTMLTextAreaElement, lines: string[], index: number) {
  const cs = getComputedStyle(el);
  const mirror = document.createElement('div');
  const copy = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'tabSize', 'textTransform', 'wordSpacing', 'paddingTop', 'paddingLeft', 'paddingRight'] as const;
  for (const k of copy) mirror.style[k] = cs[k];
  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    top: '0',
    left: '-99999px',
    boxSizing: 'border-box',
    width: `${el.clientWidth}px`,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
  });
  const before = document.createElement('div');
  before.textContent = lines.slice(0, index).join('\n');
  const target = document.createElement('div');
  target.textContent = lines[index] || '\u200b';
  if (index > 0) mirror.appendChild(before);
  mirror.appendChild(target);
  document.body.appendChild(mirror);
  const result = { top: target.offsetTop, height: target.offsetHeight };
  mirror.remove();
  return result;
}

export default function Editor({
  meeting,
  field,
  onSave,
  noteTemplates = [],
  onManageTemplates,
  placeholder,
  defaultView = 'live',
  focus = false,
  onFocusChange,
  title,
  sources,
  reveal,
}: {
  meeting: Meeting;
  field: Field;
  onSave: () => void;
  noteTemplates?: Template[];
  onManageTemplates?: () => void;
  placeholder?: string;
  defaultView?: NoteView;
  /** Distraction-free, full-screen editing with a live preview. */
  focus?: boolean;
  onFocusChange?: (focus: boolean) => void;
  title?: string;
  /** Lets hidden source markers in the preview show their transcript lines on hover. */
  sources?: SourceInfo;
  /** Scroll to a source line (1-based) and flash it; `text` re-finds the line if it moved. */
  reveal?: { line: number; text?: string; n: number } | null;
}) {
  const draftKey = `huh-draft-${meeting.id}-${field}`;
  const draft = (() => {
    try {
      return JSON.parse(sessionStorage.getItem(draftKey) || 'null');
    } catch {
      return null;
    }
  })();
  const revision = field === 'notes' ? 'notes_revision' : 'enhanced_revision';
  const [text, setText] = useState<string>(draft?.text ?? meeting[field]);
  const [status, setStatus] = useState('Saved');
  // Phone: two modes only. Notes open for reading; the pencil edits the plain Markdown until Done (or leaving).
  const typingView: 'live' | 'write' = isPhoneLayout() || defaultView === 'write' ? 'write' : 'live';
  const [mode, setMode] = useState<NoteView>(() => (isPhoneLayout() ? 'preview' : defaultView));
  const preview = mode === 'preview';
  /** Leave reading for typing, in the view last used for typing. */
  const lastTyping = useRef<'live' | 'write'>(mode === 'preview' ? typingView : mode);
  if (mode !== 'preview') lastTyping.current = mode;
  const toTyping = () => setMode(m => (m === 'preview' ? lastTyping.current : m));
  const [conflict, setConflict] = useState<Meeting | null>(null);
  const base = useRef<number>(draft?.revision ?? meeting[revision]);
  const saved = useRef(meeting[field]);
  const current = useRef(text);
  current.current = text;
  const saving = useRef(false);
  const conflictRef = useRef(false);
  const area = useRef<HTMLTextAreaElement>(null);
  /** The live editor's view, while one is shown. */
  const cm = useRef<EditorView | null>(null);
  const onView = (v: EditorView | null) => void (cm.current = v);
  /** Put the caret at `pos` in whichever editor is shown. */
  const focusAt = (pos: number) => {
    if (cm.current) {
      cm.current.focus();
      const p = Math.min(pos, cm.current.state.doc.length);
      cm.current.dispatch({ selection: { anchor: p }, scrollIntoView: true });
    } else if (area.current) {
      area.current.focus();
      area.current.setSelectionRange(pos, pos);
    }
  };
  const caret = useRef<number | null>(null);
  const previewPane = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<FocusLayout>(() => {
    const v = localStorage.getItem('huh-focus-layout');
    return v === 'write' || v === 'preview' || v === 'split' ? v : 'live';
  });
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 820px)').matches);
  const [fullscreen, setFullscreen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<{ box: { top: number; left: number; width: number; height: number }; top: number; height: number; n: number } | null>(null);
  const band = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!reveal) return;
    // Wait for the tab panel to be shown and laid out.
    const timer = setTimeout(show, 40);
    function show() {
      const lines = current.current.split('\n');
      let index = reveal!.line - 1;
      if (reveal!.text != null && lines[index] !== reveal!.text) {
        const found = lines.indexOf(reveal!.text);
        if (found >= 0) index = found;
      }
      if (index < 0 || index >= lines.length) return;
      if (cm.current) {
        cm.current.focus();
        revealLine(cm.current, index);
        caret.current = cm.current.state.selection.main.head;
        cm.current.dom.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      const el = area.current;
      if (!el) {
        // Preview: flash the rendered list item for that line.
        const item = root.current?.querySelector(`.task-box[data-line="${index + 1}"]`)?.closest('li');
        if (!item) return;
        item.scrollIntoView({ block: 'center', behavior: 'smooth' });
        item.classList.remove('line-flash');
        void (item as HTMLElement).offsetWidth;
        item.classList.add('line-flash');
        item.addEventListener('animationend', () => item.classList.remove('line-flash'), { once: true });
        return;
      }
      // Write view: measure the (possibly wrapped) line, scroll it to the middle, and flash a band over it.
      const { top, height } = measureLine(el, lines, index);
      const start = lines.slice(0, index).join('\n').length + (index ? 1 : 0);
      el.setSelectionRange(start, start + lines[index].length);
      caret.current = start;
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      el.scrollTo({ top: Math.max(0, top - el.clientHeight / 2 + height / 2), behavior: 'smooth' });
      const cs = getComputedStyle(el);
      setFlash({
        box: { top: el.offsetTop + parseFloat(cs.borderTopWidth), left: el.offsetLeft + parseFloat(cs.borderLeftWidth), width: el.clientWidth, height: el.clientHeight },
        top,
        height,
        n: reveal!.n,
      });
    }
    return () => clearTimeout(timer);
  }, [reveal?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // Phone: the note is the page. The text box grows with its text (the page scrolls, not the box).
  // Editing lasts until Done, even with the keyboard put away, so the raw text stays put to scroll and tap back into.
  const phone = isPhoneLayout();
  useEffect(() => {
    if (!phone || preview) return;
    const key = `${meeting.id}:${field}`;
    setPhoneEditing(key, true);
    const done = () => {
      (document.activeElement as HTMLElement | null)?.blur();
      setMode('preview');
    };
    window.addEventListener('huh:phone-done', done);
    return () => {
      window.removeEventListener('huh:phone-done', done);
      setPhoneEditing(key, false);
    };
  }, [phone, preview, meeting.id, field]);
  useLayoutEffect(() => {
    const el = area.current;
    if (!phone || !el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [phone, text, preview]);
  // Phone: while typing, swipe right on a bullet / checkbox line to indent it, left to outdent (like Tab / Shift+Tab).
  // Swipes are read on a strip over the left edge of the note (the bullets and boxes): inside the text itself iOS
  // claims a dragging finger for text selection, so the swipe would never arrive. The line flashes when it moves,
  // or flashes red when it can't (not a list line, or nothing above it to nest under).
  const gutter = useRef<HTMLDivElement>(null);
  const [swipeMark, setSwipeMark] = useState<{ top: number; height: number; ok: boolean; n: number } | null>(null);
  useEffect(() => {
    const view = cm.current;
    const ta = area.current;
    const el: HTMLElement | null = view?.contentDOM ?? ta;
    const strip = gutter.current;
    const wrap = strip?.parentElement;
    if (!phone || !el || preview) return;
    const value = () => (view ? view.state.doc.toString() : ta!.value);
    let x0 = 0;
    let y0 = 0;
    let line = -1;
    let moved = false;
    let done = false;
    const lineAt = (clientY: number) => {
      if (view) return view.state.doc.lineAt(view.lineBlockAtHeight(clientY - view.documentTop).from).number - 1;
      const y = clientY - ta!.getBoundingClientRect().top + ta!.scrollTop;
      const lines = ta!.value.split('\n');
      let lo = 0;
      let hi = lines.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (measureLine(ta!, lines, mid).top <= y) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const mark = (index: number, ok: boolean) => {
      if (view) {
        const block = view.lineBlockAt(view.state.doc.line(index + 1).from);
        const top = view.documentTop + block.top - (wrap?.getBoundingClientRect().top ?? 0);
        setSwipeMark({ top, height: block.height, ok, n: Date.now() });
        return;
      }
      const m = measureLine(ta!, ta!.value.split('\n'), index);
      setSwipeMark({ top: m.top - ta!.scrollTop, height: m.height, ok, n: Date.now() });
    };
    const start = (e: TouchEvent) => {
      const fromStrip = e.currentTarget === strip;
      if (e.touches.length !== 1 || (!fromStrip && !el.contains(document.activeElement))) return void (line = -1);
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      line = lineAt(y0);
      moved = false;
      done = false;
    };
    const move = (e: TouchEvent) => {
      if (line < 0 || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - x0;
      const dy = e.touches[0].clientY - y0;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
      if (done) return void e.preventDefault();
      if (Math.abs(dx) < 28 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
      done = true;
      e.preventDefault();
      const ok = view ? shiftLine(view, line, dx < 0) : shiftListLine(ta!, line, dx < 0);
      mark(line, ok);
    };
    // On the strip, a tap (no swipe) puts the caret at the start of that line's text, and never closes the keyboard.
    const end = (e: TouchEvent) => {
      if (e.currentTarget !== strip || line < 0) return;
      e.preventDefault();
      if (moved || done) return;
      const lines = value().split('\n');
      let at = 0;
      for (let i = 0; i < line; i++) at += lines[i].length + 1;
      const marker = lines[line].match(/^\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/)?.[0].length ?? 0;
      focusAt(at + marker);
    };
    const targets: HTMLElement[] = strip ? [el, strip] : [el];
    for (const t of targets) {
      t.addEventListener('touchstart', start, { passive: true });
      t.addEventListener('touchmove', move, { passive: false });
      t.addEventListener('touchend', end, { passive: false });
    }
    return () => {
      for (const t of targets) {
        t.removeEventListener('touchstart', start);
        t.removeEventListener('touchmove', move);
        t.removeEventListener('touchend', end);
      }
    };
  }, [phone, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // The phone's Edit button: the visible editor switches to typing. It runs inside the tap, so the text box is
  // rendered and focused synchronously (iOS only raises the keyboard then).
  useEffect(() => {
    if (!phone) return;
    const onEdit = () => {
      if (!root.current || root.current.offsetParent === null) return;
      flushSync(toTyping);
      focusAt(current.current.length);
    };
    window.addEventListener('huh:phone-edit', onEdit);
    return () => window.removeEventListener('huh:phone-edit', onEdit);
  }, [phone]);

  const followScroll = () => {
    if (band.current && area.current) band.current.style.transform = `translateY(${-area.current.scrollTop}px)`;
  };
  useEffect(followScroll, [flash?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (text !== saved.current) sessionStorage.setItem(draftKey, JSON.stringify({ text, revision: base.current }));
    else sessionStorage.removeItem(draftKey);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (text === saved.current && !saving.current && !conflictRef.current) {
      saved.current = meeting[field];
      base.current = meeting[revision];
      setText(meeting[field]);
    }
  }, [meeting[field], meeting[revision]]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (text === saved.current || conflictRef.current) return;
    setStatus('Unsaved');
    const timer = setTimeout(() => void save(), 850);
    return () => clearTimeout(timer);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (conflictRef.current) {
      try {
        setConflict(await api(`/meetings/${meeting.id}`));
      } catch (e) {
        setStatus(errorText(e));
      }
      return;
    }
    if (saving.current || current.current === saved.current) return;
    saving.current = true;
    const snapshot = current.current;
    setStatus('Saving…');
    try {
      const result = await send<Meeting>(`/meetings/${meeting.id}`, { [field]: snapshot, [revision]: base.current }, 'PATCH');
      base.current = result[revision];
      saved.current = snapshot;
      if (current.current === snapshot) sessionStorage.removeItem(draftKey);
      else sessionStorage.setItem(draftKey, JSON.stringify({ text: current.current, revision: base.current }));
      setStatus(current.current === snapshot ? 'Saved' : 'Unsaved');
      onSave();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        conflictRef.current = true;
        setStatus('Conflict');
        try {
          setConflict(await api(`/meetings/${meeting.id}`));
        } catch (err) {
          setStatus(errorText(err));
        }
      } else setStatus('Save failed — retrying');
    } finally {
      saving.current = false;
    }
  }

  useEffect(() => {
    const timer = setInterval(() => {
      if (!saving.current && !conflictRef.current && saved.current !== current.current) void save();
    }, 3000);
    const before = (e: BeforeUnloadEvent) => {
      if (saved.current !== current.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', before);
    return () => {
      clearInterval(timer);
      window.removeEventListener('beforeunload', before);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function insertTemplate(t: Template) {
    const body = t.structure.replace(/\s+$/, '') + '\n';
    toTyping();
    const value = current.current;
    if (!value.trim()) {
      setText(body);
      requestAnimationFrame(() => focusAt(body.indexOf('- ') >= 0 ? body.indexOf('- ') + 2 : body.length));
      return;
    }
    const el = area.current;
    const at = cm.current?.hasFocus ? cm.current.state.selection.main.head : el && document.activeElement === el ? el.selectionStart : value.length;
    const before = value.slice(0, at).replace(/\s*$/, '');
    const after = value.slice(at);
    const next = `${before}${before ? '\n\n' : ''}${body}${after.trim() ? '\n' + after.replace(/^\s*/, '') : ''}`;
    setText(next);
    requestAnimationFrame(() => focusAt((before ? before.length + 2 : 0) + body.length));
  }

  // Focus mode: lock page scroll, hide non-critical toasts, restore the caret, Esc exits.
  useEffect(() => {
    if (!focus) return;
    document.body.classList.add('focus-active');
    requestAnimationFrame(() => focusAt(caret.current ?? current.current.length));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && document.activeElement !== area.current && !cm.current?.hasFocus) onFocusChange?.(false);
    };
    const media = window.matchMedia('(max-width: 820px)');
    const onMedia = () => setNarrow(media.matches);
    const onFull = () => setFullscreen(!!document.fullscreenElement);
    window.addEventListener('keydown', onKey);
    media.addEventListener('change', onMedia);
    document.addEventListener('fullscreenchange', onFull);
    return () => {
      document.body.classList.remove('focus-active');
      window.removeEventListener('keydown', onKey);
      media.removeEventListener('change', onMedia);
      document.removeEventListener('fullscreenchange', onFull);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  function chooseLayout(v: FocusLayout) {
    setLayout(v);
    localStorage.setItem('huh-focus-layout', v);
  }

  const conflictView = conflict && (
    <div className="conflict" role="alert">
          <strong>This note changed on another device.</strong>
          <p>Your version is kept below. Choose which one to keep.</p>
          <details>
            <summary>Show the other device’s version</summary>
            <pre>{conflict[field]}</pre>
          </details>
          <div className="row wrap">
            <button
              type="button"
              onClick={() => {
                saved.current = conflict[field];
                base.current = conflict[revision];
                setText(conflict[field]);
                setConflict(null);
                conflictRef.current = false;
                setStatus('Saved');
              }}
            >
              Use server version
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                base.current = conflict[revision];
                setConflict(null);
                conflictRef.current = false;
                void save();
              }}
            >
              Keep my version
            </button>
          </div>
        </div>
  );

  const tone = status === 'Saved' ? 'good' : status === 'Conflict' || status.startsWith('Save failed') ? 'bad' : 'pending';
  // The phone shows the save state in its top bar, next to the meeting's title.
  useEffect(() => {
    if (!phone) return;
    const key = `${meeting.id}:${field}`;
    window.dispatchEvent(new CustomEvent('huh:save-state', { detail: { key, meeting: meeting.id, status, tone } }));
  }, [phone, status, tone, meeting.id, field]);
  useEffect(() => {
    const key = `${meeting.id}:${field}`;
    return () => void window.dispatchEvent(new CustomEvent('huh:save-state', { detail: { key, meeting: meeting.id, gone: true } }));
  }, [meeting.id, field]);
  const isNotes = field === 'notes';

  return (
    <div className="editor" ref={root}>
      <div className="editor-toolbar">
        <span className={cx('save-state', tone)} role="status">
          <span className="save-dot" />
          {status}
        </span>
        <span className="spacer" />
        {isNotes && (
          <Menu
            label="Insert a note template"
            placement="bottom-end"
            header={<div className="menu-header">Insert a note template</div>}
            items={[
              ...noteTemplates.map(t => ({ label: t.name, icon: <FileText size={15} />, onSelect: () => insertTemplate(t) })),
              ...(noteTemplates.length ? (['divider'] as const) : []),
              ...(onManageTemplates ? [{ label: 'Manage templates…', icon: <Settings2 size={15} />, onSelect: onManageTemplates }] : []),
            ]}
            trigger={p => (
              <button type="button" className="ghost sm" {...p} ref={p.ref}>
                <LayoutTemplate size={15} /> Template <ChevronDown size={13} />
              </button>
            )}
          />
        )}
        <Segmented
          size="sm"
          ariaLabel="Editor view"
          value={mode}
          onChange={setMode}
          options={VIEW_OPTIONS}
        />
        {onFocusChange && (
          <button type="button" className="ghost sm" title="Focus mode (Ctrl/⌘ + Shift + F)" aria-label="Focus mode" onClick={() => onFocusChange(true)}>
            <Maximize2 size={15} /> Focus
          </button>
        )}
      </div>

      {!focus && conflictView}

      {isNotes && !text.trim() && !preview && noteTemplates.length > 0 && (
        <div className="template-chips">
          <span className="hint">Start from a template:</span>
          {noteTemplates.slice(0, 6).map(t => (
            <button key={t.id} type="button" className="chip" onClick={() => insertTemplate(t)}>
              <FileText size={13} /> {t.name}
            </button>
          ))}
        </div>
      )}

      {focus ? (
        <button type="button" className="focus-placeholder" onClick={() => onFocusChange?.(false)}>
          <Maximize2 size={18} /> Editing in focus mode — press Esc to come back
        </button>
      ) : preview ? (
        <div className="note-preview-wrap">
          <Markdown className="note-preview" text={text} empty={isNotes ? 'Nothing written yet.' : 'No AI notes yet.'} onToggleTask={line => setText(t => toggleTask(t, line))} sources={sources} />
        </div>
      ) : (
        <div className={cx('note-editor-wrap', phone && 'with-swipe')}>
          {mode === 'live' && !phone ? (
            <LiveEditor
              key="live"
              className="note-live-main"
              ariaLabel={isNotes ? 'Meeting notes' : 'AI notes'}
              value={text}
              onChange={setText}
              onSelect={h => (caret.current = h)}
              onView={onView}
              hideSources={!isNotes}
              placeholder={placeholder ?? (phone ? 'Start typing…' : isNotes ? 'Jot down what matters. Markdown works — # headings, - bullets, - [ ] to-dos.' : 'AI notes appear here after you generate them. You can edit them freely.')}
            />
          ) : (
            <textarea
              ref={area}
              aria-label={isNotes ? 'Meeting notes' : 'AI notes'}
              className="note-editor"
              placeholder={placeholder ?? (phone ? 'Start typing…' : isNotes ? 'Jot down what matters. Markdown works — # headings, - bullets, - [ ] to-dos.' : 'AI notes appear here after you generate them. You can edit them freely.')}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={handleEditorKeys}
              onSelect={e => (caret.current = e.currentTarget.selectionStart)}
              onScroll={followScroll}
            />
          )}
            {phone && <div ref={gutter} className="swipe-gutter" aria-hidden="true" />}
            {swipeMark && (
              <div key={swipeMark.n} className={cx('swipe-band', !swipeMark.ok && 'refused')} style={{ top: swipeMark.top, height: swipeMark.height }} onAnimationEnd={() => setSwipeMark(null)} aria-hidden="true" />
            )}
        </div>
      )}
      {flash && !focus && !preview && (
        <div className="line-flash-box" style={flash.box} aria-hidden="true">
          <div ref={band} key={flash.n} className="line-flash-band" style={{ top: flash.top - 3, height: flash.height + 6 }} onAnimationEnd={() => setFlash(null)} />
        </div>
      )}
      {focus && createPortal(focusView(), document.body)}
    </div>
  );

  function focusView() {
    const effective: FocusLayout = narrow && layout === 'split' ? 'write' : layout;
    return (
      <div className="focus-mode" role="dialog" aria-modal="true" aria-label="Focus mode">
        <header className="focus-bar">
          <span className="focus-title truncate">{title || 'Untitled meeting'}</span>
          <span className={cx('save-state', tone)} role="status">
            <span className="save-dot" />
            {status}
          </span>
          <span className="spacer" />
          <span className="hint focus-count">{countWords(text).toLocaleString()} words</span>
          <Segmented
            size="sm"
            ariaLabel="Focus layout"
            value={effective}
            onChange={chooseLayout}
            options={[
              { value: 'live', label: 'Live' },
              { value: 'write', label: 'Source' },
              ...(narrow ? [] : [{ value: 'split' as const, label: 'Side by side' }]),
              { value: 'preview', label: 'Read' },
            ]}
          />
          {document.fullscreenEnabled && (
            <button
              type="button"
              className="icon-button sm"
              title={fullscreen ? 'Exit full screen' : 'Full screen'}
              aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
              onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {})}
            >
              {fullscreen ? <Shrink size={16} /> : <Expand size={16} />}
            </button>
          )}
          <button type="button" className="ghost sm" onClick={() => onFocusChange?.(false)}>
            <Minimize2 size={15} /> Exit <kbd>Esc</kbd>
          </button>
        </header>
        {conflictView && <div className="focus-conflict">{conflictView}</div>}
        <div className={cx('focus-body', effective)}>
          {effective === 'live' && (
            <div className="focus-pane write">
              <LiveEditor
                key="focus-live"
                className="focus-live"
                ariaLabel={isNotes ? 'Meeting notes' : 'AI notes'}
                value={text}
                onChange={setText}
                onSelect={h => (caret.current = h)}
                onView={onView}
                onEscape={() => onFocusChange?.(false)}
                hideSources={!isNotes}
                placeholder={isNotes ? 'Start writing…' : 'AI notes'}
              />
            </div>
          )}
          {(effective === 'write' || effective === 'split') && (
            <div className="focus-pane write">
              <textarea
                ref={area}
                aria-label={isNotes ? 'Meeting notes' : 'AI notes'}
                className="focus-editor"
                placeholder={isNotes ? 'Start writing…' : 'AI notes'}
                value={text}
                spellCheck
                onChange={e => setText(e.target.value)}
                onSelect={e => (caret.current = e.currentTarget.selectionStart)}
                onKeyDown={e => {
                  if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    onFocusChange?.(false);
                    return;
                  }
                  handleEditorKeys(e);
                }}
                onScroll={e => {
                  // Keep the live preview roughly aligned with the writing position.
                  const el = e.currentTarget;
                  const pane = previewPane.current;
                  if (!pane) return;
                  const ratio = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight);
                  pane.scrollTop = ratio * (pane.scrollHeight - pane.clientHeight);
                }}
              />
            </div>
          )}
          {(effective === 'preview' || effective === 'split') && (
            <div className="focus-pane preview" ref={previewPane}>
              <Markdown className="focus-preview" text={text} empty="Your formatted notes appear here as you type." onToggleTask={line => setText(t => toggleTask(t, line))} sources={sources} />
            </div>
          )}
        </div>
      </div>
    );
  }
}

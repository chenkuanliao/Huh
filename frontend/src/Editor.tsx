import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Markdown, { SourceInfo, toggleTask } from './Markdown';
import { handleEditorKeys } from './textkeys';
import { ChevronDown, Expand, FileText, LayoutTemplate, Maximize2, Minimize2, Settings2, Shrink } from 'lucide-react';
import { api, ApiError, errorText, send, Meeting, Template } from './api';
import { cx, Menu, Segmented } from './ui';

type Field = 'notes' | 'enhanced_notes';
type FocusLayout = 'split' | 'write' | 'preview';

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
  defaultView = 'write',
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
  defaultView?: 'write' | 'preview';
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
  const [preview, setPreview] = useState(defaultView === 'preview');
  const [conflict, setConflict] = useState<Meeting | null>(null);
  const base = useRef<number>(draft?.revision ?? meeting[revision]);
  const saved = useRef(meeting[field]);
  const current = useRef(text);
  current.current = text;
  const saving = useRef(false);
  const conflictRef = useRef(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const previewPane = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<FocusLayout>(() => {
    const v = localStorage.getItem('huh-focus-layout');
    return v === 'write' || v === 'preview' ? v : 'split';
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
    setPreview(false);
    const value = current.current;
    if (!value.trim()) {
      setText(body);
      requestAnimationFrame(() => {
        area.current?.focus();
        const firstBlank = body.indexOf('- ') >= 0 ? body.indexOf('- ') + 2 : body.length;
        area.current?.setSelectionRange(firstBlank, firstBlank);
      });
      return;
    }
    const el = area.current;
    const at = el && document.activeElement === el ? el.selectionStart : value.length;
    const before = value.slice(0, at).replace(/\s*$/, '');
    const after = value.slice(at);
    const next = `${before}${before ? '\n\n' : ''}${body}${after.trim() ? '\n' + after.replace(/^\s*/, '') : ''}`;
    setText(next);
    requestAnimationFrame(() => {
      area.current?.focus();
      const pos = (before ? before.length + 2 : 0) + body.length;
      area.current?.setSelectionRange(pos, pos);
    });
  }

  // Focus mode: lock page scroll, hide non-critical toasts, restore the caret, Esc exits.
  useEffect(() => {
    if (!focus) return;
    document.body.classList.add('focus-active');
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      const at = caret.current ?? el.value.length;
      el.setSelectionRange(at, at);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && document.activeElement !== area.current) onFocusChange?.(false);
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
          value={preview ? 'preview' : 'write'}
          onChange={v => setPreview(v === 'preview')}
          options={[
            { value: 'write', label: 'Write' },
            { value: 'preview', label: 'Preview' },
          ]}
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
        <Markdown className="note-preview" text={text} empty={isNotes ? 'Nothing written yet.' : 'No AI notes yet.'} onToggleTask={line => setText(t => toggleTask(t, line))} sources={sources} />
      ) : (
        <textarea
          ref={area}
          aria-label={isNotes ? 'Meeting notes' : 'AI notes'}
          className="note-editor"
          placeholder={placeholder ?? (isNotes ? 'Jot down what matters. Markdown works — # headings, - bullets, - [ ] to-dos.' : 'AI notes appear here after you generate them. You can edit them freely.')}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleEditorKeys}
          onSelect={e => (caret.current = e.currentTarget.selectionStart)}
          onScroll={followScroll}
        />
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
              { value: 'write', label: 'Write' },
              ...(narrow ? [] : [{ value: 'split' as const, label: 'Side by side' }]),
              { value: 'preview', label: 'Preview' },
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
          {effective !== 'preview' && (
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
          {effective !== 'write' && (
            <div className="focus-pane preview" ref={previewPane}>
              <Markdown className="focus-preview" text={text} empty="Your formatted notes appear here as you type." onToggleTask={line => setText(t => toggleTask(t, line))} sources={sources} />
            </div>
          )}
        </div>
      </div>
    );
  }
}

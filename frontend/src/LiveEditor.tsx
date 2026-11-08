import { useLayoutEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, liveExtensions, syncDoc } from './live';
import { cx } from './ui';

/** A Markdown note you type into directly, with formatting shown as you go (see live.ts). */
export default function LiveEditor({
  value,
  onChange,
  onSelect,
  onEscape,
  onBlur,
  onView,
  placeholder,
  ariaLabel,
  hideSources,
  className,
}: {
  value: string;
  onChange: (text: string) => void;
  onSelect?: (head: number) => void;
  /** Esc: leaves the editor by default. */
  onEscape?: () => void;
  onBlur?: () => void;
  /** Gets the CodeMirror view once it exists (and null when it goes). */
  onView?: (view: EditorView | null) => void;
  placeholder?: string;
  ariaLabel: string;
  hideSources?: boolean;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onSelect, onEscape, onBlur });
  handlers.current = { onChange, onSelect, onEscape, onBlur };

  useLayoutEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: liveExtensions({
          doc: value,
          placeholder,
          ariaLabel,
          hideSources,
          onChange: t => handlers.current.onChange(t),
          onSelect: h => handlers.current.onSelect?.(h),
          onEscape: () => (handlers.current.onEscape ? handlers.current.onEscape() : v.contentDOM.blur()),
        }),
      }),
    });
    view.current = v;
    const blur = () => handlers.current.onBlur?.();
    v.contentDOM.addEventListener('blur', blur);
    onView?.(v);
    return () => {
      v.contentDOM.removeEventListener('blur', blur);
      onView?.(null);
      v.destroy();
      view.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Outside changes (a template, a checkbox ticked elsewhere, the server's copy) flow into the editor.
  useLayoutEffect(() => {
    if (view.current) syncDoc(view.current, value);
  }, [value]);

  return <div ref={host} className={cx('note-live', className)} />;
}

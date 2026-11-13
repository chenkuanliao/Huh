/**
 * Live editing for Markdown notes (like Obsidian's Live Preview), built on CodeMirror 6.
 *
 * The text stays plain Markdown. Lines the caret isn't on hide their markup (`**`, `#`, link URLs, `>`),
 * bullets show as dots and `- [ ]` as a checkbox you can click; the line being edited shows its raw text.
 */
import { EditorSelection, EditorState, Extension, Range, StateEffect, StateField, Transaction, Annotation } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, keymap, placeholder as placeholderExt, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { defineLanguageFacet, Language, LanguageSupport, syntaxTree } from '@codemirror/language';
import { GFM, parser } from '@lezer/markdown';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import { indentEdit, listEnterEdit, shiftListEdit, TextEdit } from './textkeys';
import { copyText, SOURCE_MARKER } from './Markdown';

export { EditorView };

const markdownLanguage = new Language(defineLanguageFacet({ commentTokens: { block: { open: '<!--', close: '-->' } } }), parser.configure([GFM]), [], 'markdown');

/** Marks a change that came from outside (React state), so it isn't echoed back as an edit. */
export const External = Annotation.define<boolean>();

/* ------------------------------------------------------------- widgets */

/*
 * List layout. Every list line sits on one grid: each level indents by LIST_STEP, and the marker (dot, number or
 * checkbox) gets a LIST_SLOT-wide slot, so text lines up across bullets, numbers and to-dos, and wrapped lines
 * continue under the text. The source indentation is hidden; Tab / Shift-Tab still change it.
 */
const LIST_SLOT = 1.6; // em
const LIST_STEP = 1.6; // em

/** The marker slot at the start of a list line. */
function markerSlot(kind: string) {
  const el = document.createElement('span');
  el.className = `cm-lp-mk cm-lp-mk-${kind}`;
  return el;
}

class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }
  eq(o: BulletWidget) {
    return o.depth === this.depth;
  }
  toDOM() {
    const el = markerSlot('bullet');
    el.setAttribute('aria-hidden', 'true');
    const dot = document.createElement('span');
    dot.className = `cm-lp-dot cm-lp-dot-${this.depth % 3}`;
    el.append(dot);
    return el;
  }
}

class NumberWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(o: NumberWidget) {
    return o.text === this.text;
  }
  toDOM() {
    const el = markerSlot('num');
    el.setAttribute('aria-hidden', 'true');
    el.textContent = this.text;
    return el;
  }
}

class CheckWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly at: number, // position of the [ ] marker
  ) {
    super();
  }
  eq(o: CheckWidget) {
    return o.checked === this.checked && o.at === this.at;
  }
  toDOM(view: EditorView) {
    const slot = markerSlot('check');
    slot.addEventListener('mousedown', e => e.preventDefault());
    const el = document.createElement('span');
    slot.append(el);
    el.className = 'cm-lp-check' + (this.checked ? ' checked' : '');
    el.setAttribute('role', 'checkbox');
    el.setAttribute('aria-checked', String(this.checked));
    el.setAttribute('aria-label', this.checked ? 'Done' : 'To do');
    // Keep the caret where it is; toggle on click.
    el.addEventListener('mousedown', e => e.preventDefault());
    el.addEventListener('click', e => {
      e.preventDefault();
      toggleTaskAt(view, this.at);
    });
    return slot;
  }
  ignoreEvent() {
    return true;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-lp-hr';
    return el;
  }
}

/** The top of a code block when its fences are hidden: the language, and a button that copies the code. */
class CodeHeadWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly code: string,
  ) {
    super();
  }
  eq(o: CodeHeadWidget) {
    return o.lang === this.lang && o.code === this.code;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-lp-codehead';
    const lang = document.createElement('span');
    lang.className = 'cm-lp-codelang';
    lang.textContent = this.lang;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code');
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      void copyText(this.code).then(ok => {
        btn.textContent = ok ? 'Copied' : 'Copy failed';
        setTimeout(() => (btn.textContent = 'Copy'), 1500);
      });
    });
    el.append(lang, btn);
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

const listLineCache = new Map<number, Decoration>();
/** Line layout for a list line at `depth`: wrapped lines start where the text starts. */
const listLine = (depth: number) =>
  listLineCache.get(depth) ??
  (listLineCache.set(
    depth,
    Decoration.line({ class: 'cm-lp-li', attributes: { style: `--li-pad: ${depth * LIST_STEP + LIST_SLOT}em; --li-hang: ${LIST_SLOT}em` } }),
  ),
  listLineCache.get(depth)!);
const contLineCache = new Map<number, Decoration>();
/** A continuation line of a list item's paragraph: under the item's text. */
const contLine = (depth: number) =>
  contLineCache.get(depth) ??
  (contLineCache.set(depth, Decoration.line({ class: 'cm-lp-li', attributes: { style: `--li-pad: ${depth * LIST_STEP + LIST_SLOT}em` } })), contLineCache.get(depth)!);
const listDepth = (item: SyntaxNode) => {
  let depth = 0;
  let quoted = false;
  for (let p = item.parent; p; p = p.parent) {
    if (p.name === 'ListItem') depth++;
    if (p.name === 'Blockquote') quoted = true;
  }
  return { depth, quoted };
};
const rule = Decoration.replace({ widget: new RuleWidget() });
const hide = Decoration.replace({});
const markCache = new Map<string, Decoration>();
const mark = (cls: string) => markCache.get(cls) ?? (markCache.set(cls, Decoration.mark({ class: cls })), markCache.get(cls)!);
const lineCache = new Map<string, Decoration>();
const lineDeco = (cls: string) => lineCache.get(cls) ?? (lineCache.set(cls, Decoration.line({ class: cls })), lineCache.get(cls)!);

/** Flip the `[ ]` / `[x]` marker that starts at `at`. */
function toggleTaskAt(view: EditorView, at: number) {
  const text = view.state.sliceDoc(at, at + 3);
  if (!/^\[[ xX]\]$/.test(text)) return;
  view.dispatch({ changes: { from: at + 1, to: at + 2, insert: text[1] === ' ' ? 'x' : ' ' }, userEvent: 'input.toggle' });
}

/* ---------------------------------------------------------- live preview */

function buildLive(view: EditorView, hideSources: boolean): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const focused = view.hasFocus;
  const active = new Set<number>();
  if (focused)
    for (const r of state.selection.ranges) for (let l = doc.lineAt(r.from).number; l <= doc.lineAt(r.to).number; l++) active.add(l);
  const onActive = (pos: number) => active.has(doc.lineAt(pos).number);
  const touches = (from: number, to: number) => focused && state.selection.ranges.some(r => r.from <= to && r.to >= from);
  const out: Range<Decoration>[] = [];
  const lines = (from: number, to: number, cls: string) => {
    for (let l = doc.lineAt(from).number, end = doc.lineAt(to).number; l <= end; l++) out.push(lineDeco(cls).range(doc.line(l).from));
  };
  // Hide a marker plus the space after it.
  const hideMark = (from: number, to: number) => {
    const after = to < doc.length && doc.sliceString(to, to + 1) === ' ' ? to + 1 : to;
    if (after > from) out.push(hide.range(from, after));
  };
  // A list item's text block (paragraph or task): lines other than the marker's line go under the item's text.
  const underItem = (block: SyntaxNode) => {
    const item = block.parent;
    if (item?.name !== 'ListItem') return;
    const { depth, quoted } = listDepth(item);
    const markLine = doc.lineAt(item.from).number;
    for (let l = Math.max(doc.lineAt(block.from).number, markLine + 1), last = doc.lineAt(block.to).number; l <= last; l++) {
      const line = doc.line(l);
      out.push(contLine(depth).range(line.from));
      const ws = /^[ \t]+/.exec(line.text);
      if (!quoted && ws && ws[0].length < line.length) out.push(hide.range(line.from, line.from + ws[0].length));
    }
  };
  const { from: vFrom, to: vTo } = view.viewport;

  syntaxTree(state).iterate({
    from: vFrom,
    to: vTo,
    enter(node: SyntaxNodeRef) {
      const { name, from, to } = node;
      const parent = node.node.parent?.name ?? '';
      const heading = /^ATXHeading(\d)$/.exec(name);
      if (heading) {
        out.push(lineDeco(`cm-lp-h cm-lp-h${heading[1]}`).range(doc.lineAt(from).from));
        return;
      }
      switch (name) {
        case 'SetextHeading1':
        case 'SetextHeading2':
          out.push(lineDeco(`cm-lp-h cm-lp-h${name.slice(-1)}`).range(doc.lineAt(from).from));
          return;
        case 'HeaderMark':
          if (parent.startsWith('ATXHeading') && !onActive(from)) hideMark(from, to);
          else if (parent.startsWith('Setext')) out.push(mark('cm-lp-dim').range(from, to));
          else out.push(mark('cm-lp-dim').range(from, to));
          return;
        case 'Emphasis':
          if (to > from) out.push(mark('cm-lp-em').range(from, to));
          return;
        case 'StrongEmphasis':
          if (to > from) out.push(mark('cm-lp-strong').range(from, to));
          return;
        case 'Strikethrough':
          if (to > from) out.push(mark('cm-lp-strike').range(from, to));
          return;
        case 'EmphasisMark':
        case 'StrikethroughMark':
          if (!onActive(from)) out.push(hide.range(from, to));
          else out.push(mark('cm-lp-dim').range(from, to));
          return;
        case 'InlineCode':
          out.push(mark('cm-lp-code').range(from, to));
          return;
        case 'CodeMark':
          if (parent === 'InlineCode') {
            if (!onActive(from)) out.push(hide.range(from, to));
          } else out.push(mark('cm-lp-dim').range(from, to));
          return;
        case 'CodeInfo':
          out.push(mark('cm-lp-dim').range(from, to));
          return;
        case 'FencedCode': {
          lines(from, to, 'cm-lp-codeblock');
          // Away from the caret the ``` lines go: the opening one becomes a header with a Copy button,
          // the closing one shrinks to the block's bottom padding.
          if (touches(from, to)) {
            node.node.getChildren('CodeMark').forEach(m => out.push(mark('cm-lp-dim').range(m.from, m.to)));
            const info = node.node.getChild('CodeInfo');
            if (info) out.push(mark('cm-lp-dim').range(info.from, info.to));
            return false;
          }
          const marks = node.node.getChildren('CodeMark');
          const open = doc.lineAt(from);
          const closeMark = marks.length > 1 ? marks[marks.length - 1] : null;
          const close = closeMark && doc.lineAt(closeMark.from).number > open.number ? doc.lineAt(closeMark.from) : null;
          const info = node.node.getChild('CodeInfo');
          const body = open.number + 1 <= (close ? close.number - 1 : doc.lineAt(to).number) ? doc.sliceString(Math.min(open.to + 1, doc.length), close ? Math.max(open.to + 1, close.from - 1) : to) : '';
          const indent = marks[0] ? marks[0].from : open.from;
          out.push(lineDeco('cm-lp-fence-open').range(open.from));
          out.push(Decoration.replace({ widget: new CodeHeadWidget(info ? doc.sliceString(info.from, info.to) : '', body) }).range(indent, open.to));
          if (close) {
            out.push(lineDeco('cm-lp-fence-close').range(close.from));
            if (close.to > closeMark!.from) out.push(hide.range(closeMark!.from, close.to));
          }
          return false;
        }
        case 'CodeBlock':
          lines(from, to, 'cm-lp-codeblock');
          return false;
        case 'Blockquote':
          lines(from, to, 'cm-lp-quote');
          return;
        case 'QuoteMark':
          if (!onActive(from)) hideMark(from, to);
          else out.push(mark('cm-lp-dim').range(from, to));
          return;
        case 'HorizontalRule':
          if (!onActive(from)) out.push(rule.range(from, to));
          return;
        case 'Table':
          lines(from, to, 'cm-lp-table');
          return false;
        case 'Link': {
          const n = node.node;
          const marks = n.getChildren('LinkMark');
          const url = n.getChild('URL');
          if (marks.length >= 2 && marks[0].to - marks[0].from === 1 && doc.sliceString(marks[0].from, marks[0].to) === '[') {
            const close = marks.find(m => doc.sliceString(m.from, m.to) === ']');
            if (close && close.from > marks[0].to) {
              out.push(Decoration.mark({ class: 'cm-lp-link', attributes: url ? { 'data-href': doc.sliceString(url.from, url.to) } : {} }).range(marks[0].to, close.from));
              if (!onActive(from)) {
                out.push(hide.range(marks[0].from, marks[0].to));
                out.push(hide.range(close.from, to));
              }
            }
          }
          return;
        }
        case 'URL':
          if (parent !== 'Link' && parent !== 'Image') out.push(Decoration.mark({ class: 'cm-lp-link', attributes: { 'data-href': doc.sliceString(from, to) } }).range(from, to));
          return;
        case 'Image':
          out.push(mark('cm-lp-dim').range(from, to));
          return false;
        case 'ListMark': {
          const item = node.node.parent;
          if (!item) return;
          const list = item.parent?.name;
          const task = item.getChild('Task');
          const taskMark = task?.getChild('TaskMarker');
          const markEnd = taskMark ? taskMark.to : to;
          const line = doc.lineAt(from);
          const { depth, quoted } = listDepth(item);
          // The text starts after the marker and its spaces.
          let text = markEnd;
          while (text < line.to && /[ \t]/.test(doc.sliceString(text, text + 1))) text++;
          const raw = touches(from, markEnd);
          out.push(listLine(depth).range(line.from));
          // Source indentation is replaced by the layout (inside a quote it stays: the quote mark owns that space).
          if (!quoted && from > line.from && /^[ \t]+$/.test(doc.sliceString(line.from, from))) out.push(hide.range(line.from, from));
          const end = text;
          if (raw) out.push(mark('cm-lp-dim cm-lp-mk-raw').range(from, end));
          else if (taskMark) {
            const checked = /x/i.test(doc.sliceString(taskMark.from, taskMark.to));
            out.push(Decoration.replace({ widget: new CheckWidget(checked, taskMark.from) }).range(from, end));
          } else if (list === 'BulletList') out.push(Decoration.replace({ widget: new BulletWidget(depth) }).range(from, end));
          else out.push(Decoration.replace({ widget: new NumberWidget(doc.sliceString(from, to)) }).range(from, end));
          return;
        }
        case 'Paragraph':
          underItem(node.node);
          return;
        case 'Task': {
          underItem(node.node);
          const marker = node.node.getChild('TaskMarker');
          if (marker && /x/i.test(doc.sliceString(marker.from, marker.to))) {
            const end = doc.lineAt(marker.to).to;
            if (end > marker.to) out.push(mark('cm-lp-done').range(marker.to, end));
          }
          return;
        }
      }
    },
  });

  // Hidden source markers in AI notes ([[12:34]]): out of the way unless their line is being edited.
  if (hideSources) {
    const text = doc.sliceString(vFrom, vTo);
    const re = new RegExp(SOURCE_MARKER.source, 'gi');
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const from = vFrom + m.index;
      const to = from + m[0].length;
      out.push(onActive(from) ? mark('cm-lp-source').range(from, to) : hide.range(from, to));
    }
  }
  return Decoration.set(out, true);
}

function livePreview(hideSources: boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildLive(view, hideSources);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state))
          this.decorations = buildLive(u.view, hideSources);
      }
    },
    {
      decorations: v => v.decorations,
      // Hidden markup is skipped over as one unit by the arrow keys.
      provide: p => EditorView.atomicRanges.of(view => view.plugin(p)?.decorations ?? Decoration.none),
    },
  );
}

/* ------------------------------------------------- find hits and flashes */

export const setFindHits = StateEffect.define<{ hits: [number, number][]; current: number }>();
const findField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects)
      if (e.is(setFindHits))
        deco = Decoration.set(
          e.value.hits.filter(([a, b]) => b > a && b <= tr.state.doc.length).map(([a, b], i) => mark(i === e.value.current ? 'find-hit current' : 'find-hit').range(a, b)),
          true,
        );
    return deco;
  },
  provide: f => EditorView.decorations.from(f),
});

const flashEffect = StateEffect.define<number | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(flashEffect)) deco = e.value == null ? Decoration.none : Decoration.set([lineDeco('cm-lp-flash').range(e.value)]);
    return deco;
  },
  provide: f => EditorView.decorations.from(f),
});

/** Select a line (0-based), scroll it to the middle and flash it. */
export function revealLine(view: EditorView, index: number) {
  const line = view.state.doc.line(Math.min(view.state.doc.lines, index + 1));
  view.dispatch({
    selection: EditorSelection.range(line.from, line.to),
    effects: [flashEffect.of(line.from), EditorView.scrollIntoView(line.from, { y: 'center' })],
  });
  window.setTimeout(() => view.dispatch({ effects: flashEffect.of(null) }), 2400);
}

/* ------------------------------------------------------------- editing */

function applyEdit(view: EditorView, edit: TextEdit) {
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: EditorSelection.single(edit.anchor, edit.head),
    scrollIntoView: true,
    userEvent: 'input',
  });
}

/** Indent / outdent a list line (0-based) as the phone's swipe does. */
export function shiftLine(view: EditorView, index: number, outdent: boolean) {
  const edit = shiftListEdit(view.state.doc.toString(), index, outdent);
  if (!edit) return false;
  applyEdit(view, edit);
  return true;
}

function noteKeys(onEscape: () => void) {
  const indent = (outdent: boolean) => (view: EditorView) => {
    const r = view.state.selection.main;
    const edit = indentEdit(view.state.doc.toString(), r.from, r.to, outdent);
    if (edit) applyEdit(view, edit);
    return true;
  };
  return keymap.of([
    { key: 'Tab', run: indent(false), shift: indent(true) },
    {
      key: 'Enter',
      run: view => {
        const r = view.state.selection.main;
        if (!r.empty || view.state.selection.ranges.length > 1) return false;
        const edit = listEnterEdit(view.state.doc.toString(), r.head);
        if (!edit) return false;
        applyEdit(view, edit);
        return true;
      },
    },
    {
      key: 'Escape',
      run: () => {
        onEscape();
        return true;
      },
    },
  ]);
}

export type LiveOptions = {
  doc: string;
  placeholder?: string;
  ariaLabel: string;
  hideSources?: boolean;
  onChange: (text: string) => void;
  onSelect?: (head: number) => void;
  onEscape: () => void;
};

export function liveExtensions(o: LiveOptions): Extension[] {
  return [
    history(),
    noteKeys(o.onEscape),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    new LanguageSupport(markdownLanguage),
    livePreview(!!o.hideSources),
    findField,
    flashField,
    EditorView.lineWrapping,
    EditorState.tabSize.of(4),
    placeholderExt(o.placeholder ?? ''),
    EditorView.contentAttributes.of({ 'aria-label': o.ariaLabel, spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences' }),
    EditorView.updateListener.of(u => {
      if (u.docChanged && !u.transactions.every(t => t.annotation(External))) {
        o.onChange(u.state.doc.toString());
        u.view.dom.dispatchEvent(new CustomEvent('huh:cm-change', { bubbles: true }));
      } else if (u.docChanged) u.view.dom.dispatchEvent(new CustomEvent('huh:cm-change', { bubbles: true }));
      if (u.selectionSet) o.onSelect?.(u.state.selection.main.head);
    }),
    // Ctrl/⌘ + click opens a link.
    EditorView.domEventHandlers({
      click(e) {
        const a = (e.target as HTMLElement).closest?.('[data-href]') as HTMLElement | null;
        if (!a || !(e.metaKey || e.ctrlKey)) return false;
        const href = a.dataset.href!;
        if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener');
        return true;
      },
    }),
  ];
}

/** Replace the document with `text`, touching only the part that differs (keeps the caret and undo sane). */
export function syncDoc(view: EditorView, text: string) {
  const cur = view.state.doc.toString();
  if (cur === text) return;
  let start = 0;
  const max = Math.min(cur.length, text.length);
  while (start < max && cur.charCodeAt(start) === text.charCodeAt(start)) start++;
  let endCur = cur.length;
  let endNew = text.length;
  while (endCur > start && endNew > start && cur.charCodeAt(endCur - 1) === text.charCodeAt(endNew - 1)) {
    endCur--;
    endNew--;
  }
  view.dispatch({ changes: { from: start, to: endCur, insert: text.slice(start, endNew) }, annotations: [External.of(true), Transaction.addToHistory.of(false)] });
}

/** The CodeMirror view inside `root`, if one is shown. */
export function liveViewIn(root: Element | null): EditorView | null {
  const dom = root?.querySelector<HTMLElement>('.cm-editor');
  if (!dom || (dom.offsetParent === null && !dom.getClientRects().length)) return null;
  return EditorView.findFromDOM(dom);
}

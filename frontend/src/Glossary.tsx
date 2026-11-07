import { KeyboardEvent, ClipboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { BookA, Plus, X } from 'lucide-react';
import { errorText, GlossaryEntry } from './api';
import { Modal, Spinner, useToast } from './ui';

/** Splits one pasted line like “QBR: quarterly business review” into a term and its meaning. */
export function parseGlossaryLine(line: string): GlossaryEntry | null {
  const text = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
  if (!text) return null;
  const m = text.match(/^(.+?)\s*(?:\t|\s[—–-]\s|:|=)\s*(.*)$/);
  return m ? { term: m[1].trim(), meaning: m[2].trim() } : { term: text, meaning: '' };
}

/** Entries without blank rows, trimmed; what the server would store. */
export function cleanGlossary(entries: GlossaryEntry[]): GlossaryEntry[] {
  return entries.map(e => ({ term: e.term.trim(), meaning: e.meaning.trim() })).filter(e => e.term);
}

/** The terms the AI sees for a meeting: all notes, then folder, then meeting; later ones replace same-named earlier ones. */
export function mergeGlossaries(...layers: (GlossaryEntry[] | undefined | null)[]): GlossaryEntry[] {
  const merged = new Map<string, GlossaryEntry>();
  for (const layer of layers)
    for (const e of layer || []) {
      const key = e.term.trim().toLocaleLowerCase();
      merged.delete(key);
      merged.set(key, e);
    }
  return [...merged.values()];
}

const same = (a: GlossaryEntry[], b: GlossaryEntry[]) => JSON.stringify(cleanGlossary(a)) === JSON.stringify(cleanGlossary(b));

/** Rows of term + meaning. Enter adds a row; pasting several lines into a term adds one row per line. */
export function GlossaryEditor({ value, onChange, autoFocus }: { value: GlossaryEntry[]; onChange: (v: GlossaryEntry[]) => void; autoFocus?: boolean }) {
  const list = useRef<HTMLDivElement>(null);
  const focusRow = useRef<number | null>(null);
  const rows = value.length ? value : [{ term: '', meaning: '' }];

  useEffect(() => {
    if (focusRow.current === null) return;
    list.current?.querySelectorAll<HTMLInputElement>('input[data-term]')[focusRow.current]?.focus();
    focusRow.current = null;
  });

  const set = (i: number, patch: Partial<GlossaryEntry>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = (at = rows.length) => {
    focusRow.current = at;
    onChange([...rows.slice(0, at), { term: '', meaning: '' }, ...rows.slice(at)]);
  };
  const remove = (i: number) => {
    const next = rows.filter((_, j) => j !== i);
    focusRow.current = Math.max(0, Math.min(i, next.length - 1));
    onChange(next);
  };

  function onKey(e: KeyboardEvent<HTMLInputElement>, i: number) {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      add(i + 1);
    } else if (e.key === 'Backspace' && !rows[i].term && !rows[i].meaning && rows.length > 1 && (e.target as HTMLInputElement).dataset.term !== undefined) {
      e.preventDefault();
      remove(i);
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>, i: number) {
    const text = e.clipboardData.getData('text');
    if (!text.includes('\n')) return;
    e.preventDefault();
    const parsed = text.split(/\r?\n/).map(parseGlossaryLine).filter((x): x is GlossaryEntry => !!x);
    const keep = rows[i].term || rows[i].meaning ? [rows[i]] : [];
    focusRow.current = i + keep.length + parsed.length - 1;
    onChange([...rows.slice(0, i), ...keep, ...parsed, ...rows.slice(i + 1)]);
  }

  return (
    <div className="glossary-editor" ref={list}>
      <div className="glossary-row glossary-labels" aria-hidden>
        <span>Term</span>
        <span>What the AI should know</span>
        <span />
      </div>
      {rows.map((r, i) => (
        <div className="glossary-row" key={i}>
          <input
            data-term=""
            aria-label={`Term ${i + 1}`}
            placeholder={i === 0 ? 'e.g. QBR' : 'Term'}
            value={r.term}
            maxLength={200}
            autoFocus={autoFocus && i === 0}
            onChange={e => set(i, { term: e.target.value })}
            onKeyDown={e => onKey(e, i)}
            onPaste={e => onPaste(e, i)}
          />
          <input
            aria-label={`Meaning of ${r.term || `term ${i + 1}`}`}
            placeholder={i === 0 ? 'Quarterly business review, often said “Q-B-R”' : 'Meaning, spelling, or how it sounds'}
            value={r.meaning}
            maxLength={2000}
            onChange={e => set(i, { meaning: e.target.value })}
            onKeyDown={e => onKey(e, i)}
          />
          <button type="button" className="icon-button" aria-label={`Remove ${r.term || `term ${i + 1}`}`} title="Remove" onClick={() => remove(i)} disabled={rows.length === 1 && !r.term && !r.meaning}>
            <X size={15} />
          </button>
        </div>
      ))}
      <div className="glossary-foot">
        <button type="button" className="ghost sm" onClick={() => add()}>
          <Plus size={15} /> Add term
        </button>
        <span className="hint">Tip: paste a list, one per line, like “QBR: quarterly business review”.</span>
      </div>
    </div>
  );
}

export type GlossaryLayer = { label: string; entries: GlossaryEntry[]; onEdit?: () => void };

/** Terms that also apply, read-only, from broader levels (all notes, folder). */
function Inherited({ layers, own }: { layers: GlossaryLayer[]; own: GlossaryEntry[] }) {
  const mine = new Set(cleanGlossary(own).map(e => e.term.toLocaleLowerCase()));
  const shown = layers.filter(l => l.entries.length);
  if (!shown.length) return null;
  return (
    <div className="glossary-inherited">
      <h3>Also used here</h3>
      {shown.map(l => (
        <div key={l.label} className="glossary-layer">
          <div className="glossary-layer-head">
            <strong>{l.label}</strong>
            <span className="muted">
              {l.entries.length} term{l.entries.length === 1 ? '' : 's'}
            </span>
            {l.onEdit && (
              <button type="button" className="link small" onClick={l.onEdit}>
                Edit
              </button>
            )}
          </div>
          <ul className="glossary-chips">
            {l.entries.map(e => {
              const replaced = mine.has(e.term.toLocaleLowerCase());
              return (
                <li key={e.term} className={replaced ? 'replaced' : undefined} title={replaced ? 'Replaced by the entry above' : e.meaning || undefined}>
                  {e.term}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function GlossaryDialog({
  open,
  onClose,
  title,
  description,
  entries,
  inherited = [],
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  entries: GlossaryEntry[];
  inherited?: GlossaryLayer[];
  onSave: (entries: GlossaryEntry[]) => Promise<void>;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<GlossaryEntry[]>(entries);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setDraft(entries.length ? entries : []);
    // Only reset when the dialog opens, not when the list refreshes underneath it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const dirty = !same(draft, entries);

  async function save() {
    setSaving(true);
    try {
      await onSave(cleanGlossary(draft));
      onClose();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <span className="glossary-title">
          <BookA size={18} /> {title}
        </span>
      }
      description={description}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving && <Spinner size={14} />} Save glossary
          </button>
        </>
      }
    >
      <div className="stack">
        <GlossaryEditor value={draft} onChange={setDraft} autoFocus />
        <Inherited layers={inherited} own={draft} />
      </div>
    </Modal>
  );
}

/** Inline editor with Save / Discard, for the Settings page. */
export function GlossaryPanel({ entries, onSave }: { entries: GlossaryEntry[]; onSave: (entries: GlossaryEntry[]) => Promise<unknown> }) {
  const [draft, setDraft] = useState(entries);
  useEffect(() => setDraft(entries), [entries]);
  const dirty = useMemo(() => !same(draft, entries), [draft, entries]);
  return (
    <div className="stack">
      <GlossaryEditor value={draft} onChange={setDraft} />
      {dirty && (
        <div className="row">
          <button type="button" className="primary sm" onClick={() => void onSave(cleanGlossary(draft)).catch(() => {})}>
            Save glossary
          </button>
          <button type="button" className="ghost sm" onClick={() => setDraft(entries)}>
            Discard
          </button>
        </div>
      )}
    </div>
  );
}

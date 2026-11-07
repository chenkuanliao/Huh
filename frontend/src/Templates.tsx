import { useEffect, useMemo, useState } from 'react';
import Markdown from './Markdown';
import { handleEditorKeys } from './textkeys';
import { FileText, Pencil, Plus, Sparkles, Star, Trash2 } from 'lucide-react';
import { api, errorText, send, Template, TemplateKind } from './api';
import { Badge, ConfirmDialog, cx, Field, Segmented, Spinner, Switch, useToast } from './ui';

type Draft = { id?: string; name: string; instructions: string; structure: string; is_default?: boolean };
const blank = (): Draft => ({ name: '', instructions: '', structure: '' });

export default function Templates({ templates, reload }: { templates: Template[]; reload: () => Promise<void> }) {
  const toast = useToast();
  const [kind, setKind] = useState<TemplateKind>('notes');
  const list = useMemo(() => templates.filter(t => t.kind === kind), [templates, kind]);
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(blank());
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [preview, setPreview] = useState(false);

  const selected = selectedId && selectedId !== 'new' ? templates.find(t => t.id === selectedId) : undefined;
  const original: Draft = selected ? { id: selected.id, name: selected.name, instructions: selected.instructions, structure: selected.structure, is_default: selected.is_default } : blank();
  const dirty = selectedId !== null && (draft.name !== original.name || draft.instructions !== original.instructions || draft.structure !== original.structure || !!draft.is_default !== !!original.is_default);

  // Select the first template of the current kind by default.
  useEffect(() => {
    if (selectedId === 'new') return;
    if (!selectedId || !templates.some(t => t.id === selectedId && t.kind === kind)) {
      const first = list[0];
      setSelectedId(first?.id ?? null);
      setDraft(first ? { ...first } : blank());
    }
  }, [kind, list, templates]); // eslint-disable-line react-hooks/exhaustive-deps

  function guard(action: () => void) {
    if (dirty) setPending(() => action);
    else action();
  }
  function open(t: Template) {
    guard(() => {
      setSelectedId(t.id);
      setDraft({ ...t });
      setPreview(false);
    });
  }
  function create() {
    guard(() => {
      setSelectedId('new');
      setDraft(kind === 'notes' ? { name: '', instructions: '', structure: '## Agenda\n- \n\n## Notes\n- \n\n## Next steps\n- [ ] ' } : { name: '', instructions: '', structure: '## Summary\n## Decisions\n## Action items' });
      setPreview(false);
    });
  }

  async function saveDraft() {
    if (!draft.name.trim()) {
      toast('Give the template a name.', 'error');
      return;
    }
    setBusy(true);
    try {
      const body = { name: draft.name.trim(), instructions: draft.instructions, structure: draft.structure, ...(kind === 'ai' ? { is_default: !!draft.is_default } : {}) };
      const saved =
        selectedId === 'new'
          ? await send<Template>('/templates', { ...body, kind })
          : await send<Template>(`/templates/${selectedId}`, body, 'PATCH');
      await reload();
      setSelectedId(saved.id);
      setDraft({ ...saved });
      toast('Template saved.', 'success');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selected) return;
    setBusy(true);
    try {
      await api(`/templates/${selected.id}`, { method: 'DELETE' });
      setConfirmDelete(false);
      setSelectedId(null);
      await reload();
      toast(`Deleted “${selected.name}”.`);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-lg">
      <section className="panel" data-setting="tpl-kinds">
        <div className="panel-head">
          <div>
            <h2>Templates</h2>
            <p className="muted">Two kinds, for two jobs.</p>
          </div>
        </div>
        <div className="kind-cards">
          <button type="button" className={cx('kind-card', kind === 'notes' && 'on')} aria-pressed={kind === 'notes'} onClick={() => guard(() => { setKind('notes'); setSelectedId(null); })}>
            <FileText size={20} />
            <span>
              <strong>Note templates</strong>
              <small>An outline that drops into <em>your</em> notes when a meeting starts, so you can fill it in as you go.</small>
            </span>
          </button>
          <button type="button" className={cx('kind-card', kind === 'ai' && 'on')} aria-pressed={kind === 'ai'} onClick={() => guard(() => { setKind('ai'); setSelectedId(null); })}>
            <Sparkles size={20} />
            <span>
              <strong>AI templates</strong>
              <small>Tells the AI how to structure the notes it writes from your notes and the transcript.</small>
            </span>
          </button>
        </div>
      </section>

      <section className="panel template-manager" data-setting="tpl-manage">
        <aside className="template-list" aria-label={kind === 'notes' ? 'Note templates' : 'AI templates'}>
          <button type="button" className="ghost new-template" onClick={create}>
            <Plus size={16} /> New {kind === 'notes' ? 'note' : 'AI'} template
          </button>
          {list.map(t => (
            <button key={t.id} type="button" className={cx('template-item', selectedId === t.id && 'on')} onClick={() => open(t)}>
              <span className="truncate">{t.name}</span>
              {t.is_default && (
                <Badge tone="accent">
                  <Star size={11} /> Default
                </Badge>
              )}
            </button>
          ))}
          {selectedId === 'new' && <div className="template-item on">New template</div>}
          {!list.length && selectedId !== 'new' && <p className="hint">No {kind === 'notes' ? 'note' : 'AI'} templates yet.</p>}
        </aside>

        <div className="template-editor">
          {selectedId === null ? (
            <div className="empty-mini">
              <p className="muted">Pick a template on the left, or create a new one.</p>
            </div>
          ) : (
            <div className="stack">
              <Field label="Name">
                <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} aria-label="Template name" placeholder={kind === 'notes' ? 'e.g. Weekly lab meeting' : 'e.g. Decisions first'} maxLength={200} />
              </Field>
              {kind === 'notes' ? (
                <Field label="Outline" hint="Markdown. This text is inserted into your notes exactly as written.">
                  <div className="editor-frame">
                    <div className="editor-frame-bar">
                      <Segmented
                        size="sm"
                        ariaLabel="Outline view"
                        value={preview ? 'preview' : 'write'}
                        onChange={v => setPreview(v === 'preview')}
                        options={[
                          { value: 'write', label: 'Write' },
                          { value: 'preview', label: 'Preview' },
                        ]}
                      />
                    </div>
                    {preview ? (
                      <Markdown className="frame-preview" text={draft.structure} empty="Empty outline" />
                    ) : (
                      <textarea className="mono" rows={12} value={draft.structure} onChange={e => setDraft({ ...draft, structure: e.target.value })} aria-label="Template outline" onKeyDown={handleEditorKeys} />
                    )}
                  </div>
                </Field>
              ) : (
                <>
                  <Field label="What should the AI focus on?" hint="Plain language. For example: “Lead with decisions. Keep numbers exactly as spoken.”">
                    <textarea rows={4} value={draft.instructions} onChange={e => setDraft({ ...draft, instructions: e.target.value })} aria-label="AI instructions" />
                  </Field>
                  <Field label="Sections to write" hint="The headings the AI should produce, in order (Markdown).">
                    <textarea className="mono" rows={7} value={draft.structure} onChange={e => setDraft({ ...draft, structure: e.target.value })} aria-label="AI sections" onKeyDown={handleEditorKeys} />
                  </Field>
                  <Switch
                    checked={!!draft.is_default}
                    disabled={!!original.is_default}
                    onChange={v => setDraft({ ...draft, is_default: v })}
                    label="Default AI template"
                    description={original.is_default ? 'Used whenever a meeting doesn’t pick a template. Make another template the default to change this.' : 'Use this when a meeting doesn’t pick a template.'}
                  />
                </>
              )}
              <div className="row editor-actions">
                <button type="button" className="primary" disabled={busy || (!dirty && selectedId !== 'new')} onClick={() => void saveDraft()}>
                  {busy && <Spinner size={15} />} {selectedId === 'new' ? 'Create template' : 'Save changes'}
                </button>
                {dirty && selectedId !== 'new' && (
                  <button type="button" className="ghost" onClick={() => setDraft(original)}>
                    Discard
                  </button>
                )}
                <span className="spacer" />
                {selected && (
                  <button type="button" className="ghost danger-text" disabled={busy || !!selected.is_default} title={selected.is_default ? 'Choose another default first' : undefined} onClick={() => setConfirmDelete(true)}>
                    <Trash2 size={15} /> Delete
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        tone="default"
        icon={<Pencil size={20} />}
        title="Discard your changes?"
        description="Your edits to this template haven’t been saved yet."
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        onConfirm={() => {
          const action = pending;
          setPending(null);
          setDraft(original);
          action?.();
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        icon={<Trash2 size={20} />}
        title={<>Delete “{selected?.name}”?</>}
        description={kind === 'ai' ? 'Meetings that use it will switch to your default AI template.' : 'Notes you already made from it are not affected.'}
        confirmLabel="Delete template"
        busy={busy}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

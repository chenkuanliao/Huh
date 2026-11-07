import { useMemo, useState } from 'react';
import { AudioLines, Ellipsis, FileAudio, ListTodo, Mic, Palette, Plus, Search, Sparkles } from 'lucide-react';
import { Folder, Meeting } from './api';
import { collectTodos, duration, MeetingRow, relativeDay, TodoPanel, useDashData } from './Dashboard';
import { FolderTile, folderVars } from './folders';
import { Menu, MenuItem, Segmented, Spinner } from './ui';

type Sort = 'recent' | 'oldest' | 'name';

export default function FolderPage({
  folder: f,
  meetings,
  onOpen,
  onReveal,
  onNew,
  onImport,
  onCustomize,
  actions,
  reloadMeetings,
  creating,
}: {
  folder: Folder;
  /** Active (not archived) meetings in this folder. */
  meetings: Meeting[];
  onOpen: (id: string) => void;
  onReveal: (id: string, field: 'notes' | 'enhanced_notes', line: number, lineText: string) => void;
  onNew: () => void;
  onImport: () => void;
  onCustomize: () => void;
  actions: MenuItem[];
  reloadMeetings: () => Promise<void>;
  creating: boolean;
}) {
  const data = useDashData();
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort>('recent');

  const seconds = meetings.reduce((n, m) => n + (data?.meetings[m.id]?.recorded_seconds || 0), 0);
  const ai = meetings.reduce((n, m) => n + (data?.meetings[m.id]?.generations || 0), 0);
  const todos = useMemo(() => collectTodos(meetings).length, [meetings]);
  const latest = meetings.reduce<string | null>((x, m) => (!x || m.updated_at > x ? m.updated_at : x), null);

  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const out = meetings.filter(m => !q || `${m.title} ${m.notes} ${m.enhanced_notes}`.toLowerCase().includes(q));
    if (sort === 'name') out.sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base', numeric: true }));
    else out.sort((a, b) => (sort === 'recent' ? b.updated_at.localeCompare(a.updated_at) : a.created_at.localeCompare(b.created_at)));
    return out;
  }, [meetings, filter, sort]);

  return (
    <div className="dashboard folder-page" style={folderVars(f)}>
      <header className="folder-hero">
        <button type="button" className="folder-hero-tile" onClick={onCustomize} title="Change colour and icon" aria-label="Change colour and icon">
          <FolderTile folder={f} size={64} />
          <span className="folder-hero-edit" aria-hidden>
            <Palette size={13} />
          </span>
        </button>
        <div className="folder-hero-text">
          <h1 className="truncate">{f.name}</h1>
          <p className="folder-hero-meta">
            <span>
              <Mic size={14} /> {meetings.length} meeting{meetings.length === 1 ? '' : 's'}
            </span>
            {seconds > 0 && (
              <span>
                <AudioLines size={14} /> {duration(seconds)} recorded
              </span>
            )}
            {ai > 0 && (
              <span>
                <Sparkles size={14} /> {ai} AI note{ai === 1 ? '' : 's'}
              </span>
            )}
            {todos > 0 && (
              <span>
                <ListTodo size={14} /> {todos} open to-do{todos === 1 ? '' : 's'}
              </span>
            )}
            {latest && <span className="muted">Updated {relativeDay(latest).toLowerCase()}</span>}
          </p>
        </div>
        <div className="dash-actions">
          <button type="button" className="ghost-bordered" onClick={onCustomize}>
            <Palette size={16} /> Customize
          </button>
          <button type="button" className="ghost-bordered" onClick={onImport} disabled={creating}>
            <FileAudio size={16} /> Import
          </button>
          <button type="button" className="primary folder-primary" onClick={onNew} disabled={creating}>
            {creating ? <Spinner size={15} /> : <Plus size={17} />} New meeting here
          </button>
          <Menu
            label={`Actions for folder ${f.name}`}
            items={actions}
            trigger={p => (
              <button type="button" className="icon-button ghost-bordered square" aria-label={`More actions for folder ${f.name}`} {...p}>
                <Ellipsis size={17} />
              </button>
            )}
          />
        </div>
      </header>

      <div className="dash-grid">
        <section className="panel">
          <div className="panel-head folder-list-head">
            <div>
              <h2>Meetings</h2>
              <p className="muted">Archived meetings live in the Archive, not here.</p>
            </div>
            {meetings.length > 1 && (
              <Segmented<Sort>
                ariaLabel="Sort meetings"
                size="sm"
                value={sort}
                onChange={setSort}
                options={[
                  { value: 'recent', label: 'Recent' },
                  { value: 'oldest', label: 'Oldest' },
                  { value: 'name', label: 'A–Z' },
                ]}
              />
            )}
          </div>
          {meetings.length > 4 && (
            <label className="folder-filter">
              <Search size={15} />
              <input aria-label="Filter meetings in this folder" placeholder={`Filter ${meetings.length} meetings…`} value={filter} onChange={e => setFilter(e.target.value)} />
            </label>
          )}
          {meetings.length === 0 ? (
            <div className="empty-mini folder-empty-state">
              <FolderTile folder={f} size={48} />
              <strong>Nothing in {f.name} yet</strong>
              <p className="muted">Start a meeting here, or drag meetings onto this folder in the sidebar.</p>
              <button type="button" className="primary sm folder-primary" onClick={onNew} disabled={creating}>
                <Plus size={15} /> New meeting here
              </button>
            </div>
          ) : list.length === 0 ? (
            <p className="hint">No meetings match “{filter}”.</p>
          ) : (
            <ul className="mrows">
              {list.map(m => (
                <MeetingRow key={m.id} meeting={m} stats={data?.meetings[m.id]} folder={f} hideFolder onOpen={onOpen} />
              ))}
            </ul>
          )}
        </section>
        <TodoPanel meetings={meetings} onReveal={onReveal} reloadMeetings={reloadMeetings} description={`Open checkboxes from meetings in ${f.name}. Tick to complete.`} />
      </div>
    </div>
  );
}

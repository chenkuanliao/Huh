import { describe, expect, it } from 'vitest';
import type { Folder, Meeting } from './api';
import { filterTodos, groupTodos, parseView } from './todoView';

const folder = (id: string, name: string): Folder => ({ id, name, color: null, icon: null, created_at: '' });
const meeting = (id: string, folder_id: string | null): Meeting =>
  ({ id, title: id.toUpperCase(), folder_id, notes: '', enhanced_notes: '', notes_revision: 0, enhanced_revision: 0 }) as Meeting;

const folders = [folder('a', 'Alpha'), folder('b', 'Beta')];
const ma = meeting('m1', 'a'), mb = meeting('m2', 'b'), mn = meeting('m3', null);
const todos = [ma, ma, mb, mn].map((m, i) => ({ meeting: m, key: String(i) }));
const known = { folders: new Set(['a', 'b', '']), meetings: new Set(['m1', 'm2', 'm3']) };
const view = (v: Partial<ReturnType<typeof parseView>>) => ({ ...parseView(null), ...v });

describe('to-do view', () => {
  it('shows everything when nothing is picked, or only stale ids are', () => {
    expect(filterTodos(todos, view({}), known).todos).toHaveLength(4);
    const stale = filterTodos(todos, view({ folders: ['gone'], meetings: ['gone'] }), known);
    expect(stale.active).toBe(false);
    expect(stale.todos).toHaveLength(4);
  });

  it('matches any picked folder or meeting', () => {
    expect(filterTodos(todos, view({ folders: ['a'] }), known).todos.map(t => t.key)).toEqual(['0', '1']);
    expect(filterTodos(todos, view({ folders: ['b'], meetings: ['m3'] }), known).todos.map(t => t.key)).toEqual(['2', '3']);
    expect(filterTodos(todos, view({ folders: [''] }), known).todos.map(t => t.key)).toEqual(['3']);
  });

  it('groups by folder in folder order with No folder last, and by meeting', () => {
    expect(groupTodos(todos, 'folder', folders).map(g => [g.label, g.todos.length])).toEqual([['Alpha', 2], ['Beta', 1], ['No folder', 1]]);
    expect(groupTodos(todos, 'meeting', folders).map(g => [g.label, g.todos.length])).toEqual([['M1', 2], ['M2', 1], ['M3', 1]]);
  });

  it('reads back bad saved data as the default view', () => {
    expect(parseView('nope')).toEqual(parseView(null));
    expect(parseView('{"group":"weird","folders":[1,"a"]}')).toMatchObject({ group: 'none', folders: ['a'] });
  });
});

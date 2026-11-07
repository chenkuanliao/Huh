import { describe, expect, it } from 'vitest';
import { Matchable, parseQuery, rank, scoreToken } from './commands';

const items: Matchable[] = [
  { id: 'new', kind: 'action', title: 'New meeting', keywords: ['create', 'start'] },
  { id: 'new-folder', kind: 'action', title: 'New folder', keywords: ['create'] },
  { id: 'settings', kind: 'action', title: 'Open settings', keywords: ['preferences'] },
  { id: 'f-design', kind: 'folder', title: 'Design', keywords: ['folder'] },
  { id: 'm-design', kind: 'meeting', title: 'Design review with Sam', keywords: ['Design'] },
  { id: 'm-standup', kind: 'meeting', title: 'Weekly standup', keywords: [] },
  { id: 'm-old', kind: 'meeting', title: 'Design kickoff', archived: true },
  { id: 's-ai', kind: 'setting', title: 'AI notes', keywords: ['settings', 'model', 'provider'] },
];
const ids = (q: string) => rank(items, q).map(r => r.item.id);

describe('command palette matching', () => {
  it('ranks exact and prefix matches above looser ones', () => {
    expect(scoreToken('design', 'design')).toBeGreaterThan(scoreToken('design', 'design review'));
    expect(scoreToken('rev', 'design review')).toBeGreaterThan(scoreToken('vie', 'design review'));
  });

  it('puts the folder you typed first, its meetings next, archived last', () => {
    expect(ids('design')).toEqual(['f-design', 'm-design', 'm-old']);
  });

  it('finds actions by name and by synonym', () => {
    expect(ids('new meeting')[0]).toBe('new');
    expect(ids('create')).toEqual(expect.arrayContaining(['new', 'new-folder']));
    expect(ids('preferences')).toContain('settings');
  });

  it('matches every word of a multi-word query in any order', () => {
    expect(ids('sam design')[0]).toBe('m-design');
    expect(ids('sam standup')).toEqual([]);
  });

  it('tolerates skipped letters', () => {
    expect(ids('nw mtg')[0]).toBe('new');
    expect(ids('wkly')).toContain('m-standup');
  });

  it('finds settings pages by what they control', () => {
    expect(ids('model')).toEqual(['s-ai']);
  });

  it('limits to actions with the > prefix', () => {
    expect(parseQuery('> new')).toEqual({ only: 'action', text: 'new' });
    expect(ids('>design')).toEqual([]);
    expect(ids('> new').sort()).toEqual(['new', 'new-folder']);
  });

  it('returns nothing for gibberish', () => {
    expect(ids('zzqx')).toEqual([]);
  });
});

describe('title beats keyword', () => {
  it('prefers a title prefix over an exact keyword', () => {
    const list: Matchable[] = [
      { id: 'history', kind: 'action', title: 'Show version history', keywords: ['restore'], boost: 20 },
      { id: 'unarchive', kind: 'action', title: 'Restore this meeting from the archive', boost: 20 },
    ];
    expect(rank(list, 'restore')[0].item.id).toBe('unarchive');
  });
});

describe('context boost', () => {
  it('lifts real matches for the page you are on, not loose ones', () => {
    const list: Matchable[] = [
      { id: 'settings', kind: 'setting', title: 'Transcription' },
      { id: 'show', kind: 'action', title: 'Show transcript', boost: 20 },
      { id: 'import', kind: 'action', title: 'Import a recording into this meeting', boost: 20 },
    ];
    expect(rank(list, 'transcript').map(r => r.item.id)).toEqual(['show', 'settings']);
    expect(rank(list, 'tr').map(r => r.item.id)).toEqual(['show', 'settings']);
  });
});

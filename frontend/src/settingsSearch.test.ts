import { describe, expect, it } from 'vitest';
import { searchSettings } from './settingsSearch';

const top = (q: string) => searchSettings(q).results[0]?.entry.id;

describe('searchSettings', () => {
  it('finds settings by their title', () => {
    expect(top('back')).toBe('notes-back');
    expect(top('speech model')).toBe('stt-model');
  });

  it('finds settings by words that are not on the page', () => {
    expect(top('gpu')).toBe('stt-advanced');
    expect(top('hotkeys')).toBe('notes-keys');
    expect(top('system prompt')).toBe('ai-instructions');
    expect(top('繁體')).toBe('stt-traditional');
    expect(top('password')).toBe('ai-connect');
  });

  it('matches word starts and ignores case', () => {
    expect(top('KEYB')).toBe('notes-keys');
  });

  it('falls back to related settings when nothing matches every word', () => {
    const r = searchSettings('chinese zebra');
    expect(r.partial).toBe(true);
    expect(r.results.length).toBeGreaterThan(0);
  });

  it('returns nothing for an empty query or nonsense', () => {
    expect(searchSettings('   ').results).toEqual([]);
    expect(searchSettings('xqzv').results).toEqual([]);
  });
});

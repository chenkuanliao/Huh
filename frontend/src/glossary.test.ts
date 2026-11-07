import { describe, expect, it } from 'vitest';
import { cleanGlossary, mergeGlossaries, parseGlossaryLine } from './Glossary';

describe('glossary', () => {
  it('splits pasted lines into term and meaning', () => {
    expect(parseGlossaryLine('QBR: quarterly business review')).toEqual({ term: 'QBR', meaning: 'quarterly business review' });
    expect(parseGlossaryLine('- K-Lab — our lab, said “cay lab”')).toEqual({ term: 'K-Lab', meaning: 'our lab, said “cay lab”' });
    expect(parseGlossaryLine('2. Huh = the notebook app')).toEqual({ term: 'Huh', meaning: 'the notebook app' });
    expect(parseGlossaryLine('Chen-Kuan\tPI')).toEqual({ term: 'Chen-Kuan', meaning: 'PI' });
    expect(parseGlossaryLine('Kubernetes')).toEqual({ term: 'Kubernetes', meaning: '' });
    expect(parseGlossaryLine('   ')).toBeNull();
  });

  it('drops blank rows and lets narrower levels replace broader ones', () => {
    expect(cleanGlossary([{ term: ' a ', meaning: ' b ' }, { term: '', meaning: '' }])).toEqual([{ term: 'a', meaning: 'b' }]);
    const merged = mergeGlossaries([{ term: 'Huh', meaning: 'app' }, { term: 'QBR', meaning: 'review' }], undefined, [{ term: 'huh', meaning: 'fork' }]);
    expect(merged).toEqual([
      { term: 'QBR', meaning: 'review' },
      { term: 'huh', meaning: 'fork' },
    ]);
  });
});

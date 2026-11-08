import { describe, expect, it } from 'vitest';
import { blankEmptyItems } from './textkeys';

describe('blankEmptyItems', () => {
  it('blanks list items with nothing written, keeping line numbers', () => {
    const md = '- [ ] buy milk\n- [ ] \n- \n1. \n* [x]\ntext';
    expect(blankEmptyItems(md)).toBe('- [ ] buy milk\n\n\n\n\ntext');
  });
  it('keeps items with text and leaves code fences alone', () => {
    const md = '- a\n```\n- \n```\n  - [ ] nested';
    expect(blankEmptyItems(md)).toBe(md);
  });
});

import { indentEdit, listEnterEdit, shiftListEdit } from './textkeys';

describe('list edits', () => {
  it('continues bullets and checkboxes on Enter', () => {
    expect(listEnterEdit('- a', 3)).toMatchObject({ from: 3, insert: '\n- ' });
    expect(listEnterEdit('  - [x] done', 12)).toMatchObject({ insert: '\n  - [ ] ' });
    expect(listEnterEdit('3. c', 4)).toMatchObject({ insert: '\n4. ' });
    expect(listEnterEdit('plain', 5)).toBeNull();
  });
  it('ends or outdents an empty item', () => {
    expect(listEnterEdit('- a\n- ', 6)).toMatchObject({ from: 4, to: 6, insert: '' });
    expect(listEnterEdit('- a\n    - ', 10)).toMatchObject({ from: 4, insert: '- ' });
  });
  it('indents list lines and inserts a tab elsewhere', () => {
    expect(indentEdit('- a', 3, 3, false)).toMatchObject({ from: 0, to: 3, insert: '    - a', anchor: 7 });
    expect(indentEdit('text', 2, 2, false)).toMatchObject({ insert: '\t' });
    expect(indentEdit('    - a', 7, 7, true)).toMatchObject({ insert: '- a', anchor: 3 });
    expect(indentEdit('- a', 3, 3, true)).toBeNull();
  });
  it('nests a swiped line only under a list item', () => {
    expect(shiftListEdit('- a\n- b', 1, false)).toMatchObject({ from: 4, insert: '    - b' });
    expect(shiftListEdit('- a', 0, false)).toBeNull();
    expect(shiftListEdit('text\n- b', 1, false)).toBeNull();
  });
});

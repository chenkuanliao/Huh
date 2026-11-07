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

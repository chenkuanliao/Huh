import { describe, expect, it } from 'vitest';
import { activeIndex, moveEntry, noticeText, setProviderModel } from './aiOrder';

describe('AI order', () => {
  const order = [
    { provider: 'chatgpt', model: 'gpt-a' },
    { provider: 'nvidia', model: 'n-b' },
    { provider: 'openai', model: '' },
  ];

  it('uses the first entry that is connected and has a model', () => {
    expect(activeIndex(order, () => true)).toBe(0);
    expect(activeIndex(order, p => p !== 'chatgpt')).toBe(1);
    expect(activeIndex(order, p => p === 'openai')).toBe(-1);
    // Unknown connection state (still loading) does not skip the entry.
    expect(activeIndex(order, () => undefined)).toBe(0);
  });

  it('moves entries and clamps the target', () => {
    expect(moveEntry([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveEntry([1, 2, 3], 2, -5)).toEqual([3, 1, 2]);
    const same = [1, 2];
    expect(moveEntry(same, 1, 1)).toBe(same);
  });

  it('sets a provider model without duplicating entries', () => {
    expect(setProviderModel(order, 'openai', 'gpt-x')?.[2]).toEqual({ provider: 'openai', model: 'gpt-x' });
    expect(setProviderModel(order, 'google', 'g')).toBeNull();
    const dup = [{ provider: 'nvidia', model: 'a' }, { provider: 'nvidia', model: 'b' }];
    expect(setProviderModel(dup, 'nvidia', 'b')).toEqual([{ provider: 'nvidia', model: 'b' }]);
  });

  it('describes switches and the case where nothing works', () => {
    const base = { at: '', from: null, to: null, from_label: null, to_label: null };
    expect(noticeText({ ...base, from_label: 'ChatGPT · gpt-a', reason: 'is out of usage or rate-limited', to_label: 'NVIDIA NIM · n-b' }, 'Standup')).toBe(
      'ChatGPT · gpt-a is out of usage or rate-limited — switching to NVIDIA NIM · n-b for “Standup”.',
    );
    expect(noticeText({ ...base, from_label: 'x', reason: 'failed' })).toBeNull();
    expect(noticeText({ ...base, reason: 'all models failed', exhausted: true, final: true })).toContain('Check Settings');
  });
});

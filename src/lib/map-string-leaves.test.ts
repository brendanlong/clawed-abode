import { describe, it, expect } from 'vitest';
import { mapStringLeaves } from './map-string-leaves';

const upper = async (s: string) => s.toUpperCase();

describe('mapStringLeaves', () => {
  it('maps a bare string', async () => {
    expect(await mapStringLeaves('abc', upper)).toBe('ABC');
  });

  it('maps nested string leaves, keeping keys, structure and non-string scalars', async () => {
    const value = { key: 'a', list: ['b', { inner: 'c', n: 1, ok: true, none: null }] };
    expect(await mapStringLeaves(value, upper)).toEqual({
      key: 'A',
      list: ['B', { inner: 'C', n: 1, ok: true, none: null }],
    });
  });
});

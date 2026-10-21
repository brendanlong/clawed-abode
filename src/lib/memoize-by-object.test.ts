import { describe, it, expect, vi } from 'vitest';
import { memoizeByObject } from './memoize-by-object';

describe('memoizeByObject', () => {
  it('computes once per object and returns the same result object', () => {
    const compute = vi.fn((key: { n: number }) => ({ doubled: key.n * 2 }));
    const memoized = memoizeByObject(compute);
    const key = { n: 2 };

    const first = memoized(key);
    expect(first).toEqual({ doubled: 4 });
    expect(memoized(key)).toBe(first);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('keys by identity, not by value', () => {
    const compute = vi.fn((key: { n: number }) => ({ doubled: key.n * 2 }));
    const memoized = memoizeByObject(compute);

    expect(memoized({ n: 2 })).not.toBe(memoized({ n: 2 }));
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('caches an undefined result too', () => {
    const compute = vi.fn((_key: object): undefined => undefined);
    const memoized = memoizeByObject(compute);
    const key = {};

    memoized(key);
    memoized(key);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('passes further arguments through to the first computation', () => {
    const memoized = memoizeByObject((key: { n: number }, label: string) => `${label}:${key.n}`);
    expect(memoized({ n: 1 }, 'a')).toBe('a:1');
  });
});

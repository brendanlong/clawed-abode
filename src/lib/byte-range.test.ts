import { describe, it, expect } from 'vitest';
import { parseByteRange } from './byte-range';

describe('parseByteRange', () => {
  it('serves the whole body without a usable header', () => {
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange('bytes=-', 100)).toBeNull();
    expect(parseByteRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseByteRange('items=0-1', 100)).toBeNull();
    expect(parseByteRange('bytes=5-2', 100)).toBeNull();
  });

  it('parses closed, open-ended, and suffix ranges', () => {
    expect(parseByteRange('bytes=0-1', 100)).toEqual({ start: 0, end: 1 });
    expect(parseByteRange('bytes=10-', 100)).toEqual({ start: 10, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
  });

  it('clamps ranges that run past the end', () => {
    expect(parseByteRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });

  it('rejects ranges that start past the end', () => {
    expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', 100)).toBe('unsatisfiable');
  });
});

import { describe, expect, it } from 'vitest';
import { createOwnedBytesCounter, formatBytes } from './disk-usage';

function count(lines: string[]): number {
  const counter = createOwnedBytesCounter();
  for (const line of lines) counter.add(line);
  return counter.bytes;
}

describe('createOwnedBytesCounter', () => {
  it('counts files with a single link', () => {
    expect(count(['f 1 1 8', 'f 2 1 16'])).toBe(24 * 512);
  });

  it('counts directories even though their link count is above one', () => {
    expect(count(['d 1 5 8'])).toBe(8 * 512);
  });

  it('skips a hardlinked file whose other links are outside the tree', () => {
    expect(count(['f 1 2 8', 'f 2 1 8'])).toBe(8 * 512);
  });

  it('counts a hardlinked file once when all its links are inside the tree', () => {
    expect(count(['f 1 3 8', 'f 1 3 8', 'f 1 3 8'])).toBe(8 * 512);
  });

  it('ignores lines it cannot parse', () => {
    expect(count(['', 'garbage', 'f 1 1 8'])).toBe(8 * 512);
  });
});

describe('formatBytes', () => {
  it('picks a unit that keeps the number readable', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(formatBytes(250 * 1024 ** 2)).toBe('250 MB');
  });
});

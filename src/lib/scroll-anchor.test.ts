import { describe, expect, it } from 'vitest';
import { firstVisibleRowIndex, scrollTopKeepingAnchor } from './scroll-anchor';

describe('firstVisibleRowIndex', () => {
  // Rows 100px tall, the first starting at 20 (the sentinel and loader above it).
  const bottoms = Array.from({ length: 50 }, (_, i) => 20 + (i + 1) * 100);
  const bottomAt = (i: number) => bottoms[i] ?? Infinity;

  it('finds the row the view top cuts through', () => {
    expect(firstVisibleRowIndex(bottoms.length, bottomAt, 1234)).toBe(12);
  });

  it('skips a row that ends exactly at the view top', () => {
    expect(firstVisibleRowIndex(bottoms.length, bottomAt, 1220)).toBe(12);
  });

  it('is the first row at the very top', () => {
    expect(firstVisibleRowIndex(bottoms.length, bottomAt, 0)).toBe(0);
  });

  it('is -1 when every row is above the view or there are none', () => {
    expect(firstVisibleRowIndex(bottoms.length, bottomAt, 99999)).toBe(-1);
    expect(firstVisibleRowIndex(0, bottomAt, 0)).toBe(-1);
  });

  it('measures only a logarithmic number of rows', () => {
    const measured = new Set<number>();
    firstVisibleRowIndex(
      1000,
      (i) => {
        measured.add(i);
        return (i + 1) * 100;
      },
      54321
    );
    expect(measured.size).toBeLessThanOrEqual(11);
  });
});

describe('scrollTopKeepingAnchor', () => {
  it('scrolls down by the height prepended above the anchor', () => {
    // At the very top, a 2000px page lands above the row the user was reading.
    expect(scrollTopKeepingAnchor(0, 120, 2120)).toBe(2000);
  });

  it('keeps the offset when the user was already scrolled into the content', () => {
    expect(scrollTopKeepingAnchor(350, -40, 1460)).toBe(1850);
  });

  it('leaves the position alone when the anchor did not move', () => {
    // E.g. the browser's own scroll anchoring already compensated.
    expect(scrollTopKeepingAnchor(1850, 64, 64)).toBe(1850);
  });

  it('scrolls up when content above the anchor shrank', () => {
    expect(scrollTopKeepingAnchor(500, 200, 152)).toBe(452);
  });
});

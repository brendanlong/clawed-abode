import { describe, expect, it } from 'vitest';
import { scrollTopKeepingAnchor } from './scroll-anchor';

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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { render, screen } from '@testing-library/react';
import { KeepVisibleRowInPlace } from './KeepVisibleRowInPlace';

interface Row {
  id: string;
  height: number;
}

/**
 * A scroller below a banner, both sized through `data-height` so the fake
 * layout (below) reads the DOM as it is at each measurement: before a commit,
 * the old rows; after it, the new ones.
 */
function Harness({
  rows,
  anchorKey,
  bannerHeight = 0,
}: {
  rows: Row[];
  anchorKey: string;
  bannerHeight?: number;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div data-banner data-height={bannerHeight} />
      <div ref={scrollerRef} data-testid="scroller">
        <div data-sentinel data-height={4} />
        <KeepVisibleRowInPlace scrollerRef={scrollerRef} anchorKey={anchorKey} />
        {rows.map((row) => (
          <div key={row.id} data-message-id={row.id} data-height={row.height} />
        ))}
      </div>
    </div>
  );
}

const PAGE_TOP = 50;
const heightOf = (element: Element) => Number(element.getAttribute('data-height') ?? 0);

/** Minimal block layout: the banner, then the scroller; its children stack, shifted by `scrollTop`. */
function topOf(element: Element, scrollTop: number): number {
  const banner = document.querySelector('[data-banner]');
  const scrollerTop = PAGE_TOP + (banner ? heightOf(banner) : 0);
  if (element.getAttribute('data-testid') === 'scroller') return scrollerTop;
  if (element === banner) return PAGE_TOP;
  let top = scrollerTop - scrollTop;
  for (
    let sibling = element.previousElementSibling;
    sibling;
    sibling = sibling.previousElementSibling
  ) {
    top += heightOf(sibling);
  }
  return top;
}

let scrollTop = 0;

beforeEach(() => {
  scrollTop = 0;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const top = topOf(this, scrollTop);
    const height = this.getAttribute('data-testid') === 'scroller' ? 800 : heightOf(this);
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 400,
      bottom: top + height,
      width: 400,
      height,
      toJSON: () => ({}),
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mount(rows: Row[], anchorKey: string) {
  const view = render(<Harness rows={rows} anchorKey={anchorKey} />);
  Object.defineProperty(screen.getByTestId('scroller'), 'scrollTop', {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  return view;
}

const rows = (...specs: [string, number][]): Row[] => specs.map(([id, height]) => ({ id, height }));
const page = rows(['a', 100], ['b', 100], ['c', 100], ['d', 100], ['e', 100]);
const olderPage = rows(['x', 300], ['y', 200]);

describe('KeepVisibleRowInPlace', () => {
  it('leaves the scroll position alone when the anchor key is unchanged', () => {
    const { rerender } = mount(page, 'a');
    scrollTop = 250;
    rerender(<Harness rows={[...olderPage, ...page]} anchorKey="a" />);
    expect(scrollTop).toBe(250);
  });

  it('leaves the scroll position alone when the row in view unmounted', () => {
    const { rerender } = mount(page, 'a');
    scrollTop = 250;
    rerender(<Harness rows={olderPage} anchorKey="x" />);
    expect(scrollTop).toBe(250);
  });

  it('keeps the row at the very top in place when a page lands at scrollTop 0', () => {
    const { rerender } = mount(page, 'a');
    rerender(<Harness rows={[...olderPage, ...page]} anchorKey="x" />);
    expect(scrollTop).toBe(500);
  });

  it('follows the row in view, counting height that changed below the first row', () => {
    const { rerender } = mount(page, 'a');
    // The view top (250) cuts through c, which spans 204-304 below the sentinel, a and b.
    scrollTop = 250;
    // The page lands, and in the same commit b grows by 300 (e.g. a plan card fills in).
    const grown = page.map((row) => (row.id === 'b' ? { ...row, height: 400 } : row));
    rerender(<Harness rows={[...olderPage, ...grown]} anchorKey="x" />);
    expect(scrollTop).toBe(250 + 500 + 300);
  });

  it('ignores the scroller itself moving on the page in the same commit', () => {
    const { rerender } = mount(page, 'a');
    scrollTop = 250;
    // A banner above the scroller appears as the page lands.
    rerender(<Harness rows={[...olderPage, ...page]} anchorKey="x" bannerHeight={40} />);
    expect(scrollTop).toBe(750);
  });
});

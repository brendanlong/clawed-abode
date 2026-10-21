import { Component, type RefObject } from 'react';
import { firstVisibleRowIndex, scrollTopKeepingAnchor } from '@/lib/scroll-anchor';

/** The transcript's top-level rows (messages and relocated subagent boxes). */
const TOP_ROW_SELECTOR = ':scope > [data-message-id], :scope > [data-subagent-box]';

interface KeepVisibleRowInPlaceProps {
  scrollerRef: RefObject<HTMLElement | null>;
  /**
   * Changes whenever a commit may add or remove rows above the view — the first
   * row's key and whether there are older pages to load.
   */
  anchorKey: string;
}

interface Snapshot {
  anchor: Element;
  top: number;
}

/** An element's top edge, relative to the scroller's (so nothing outside it leaks in). */
function offsetInScroller(element: Element, scroller: HTMLElement): number {
  return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

/**
 * Keeps the user looking at the same messages when an older page is prepended:
 * measures the topmost row in view just before the commit and scrolls by
 * however far it moved right after, before the browser paints. Anchoring on the
 * row in view (not the first loaded row) also absorbs height the page changes
 * further down, e.g. a relocated subagent box or a plan card filling in.
 *
 * CSS scroll anchoring can't be relied on for this: Safari doesn't implement it,
 * and at `scrollTop` 0 (where a fast scroll back sits when the page lands) there
 * is nothing above the view to compensate with, so the rows were pushed out of
 * view, the top sentinel stayed visible, and pages loaded in a cascade.
 *
 * A class component because `getSnapshotBeforeUpdate` is React's only hook
 * into the DOM as it was before a commit. It renders nothing; place it inside
 * the list that re-renders when the rows change.
 */
export class KeepVisibleRowInPlace extends Component<KeepVisibleRowInPlaceProps> {
  getSnapshotBeforeUpdate(prevProps: KeepVisibleRowInPlaceProps): Snapshot | null {
    const scroller = this.props.scrollerRef.current;
    if (prevProps.anchorKey === this.props.anchorKey || !scroller) return null;
    const rows = scroller.querySelectorAll(TOP_ROW_SELECTOR);
    const viewTop = scroller.getBoundingClientRect().top;
    const index = firstVisibleRowIndex(
      rows.length,
      (i) => rows[i]?.getBoundingClientRect().bottom ?? Infinity,
      viewTop
    );
    const anchor = rows[index];
    return anchor ? { anchor, top: offsetInScroller(anchor, scroller) } : null;
  }

  componentDidUpdate(
    _prevProps: KeepVisibleRowInPlaceProps,
    _prevState: unknown,
    snapshot: Snapshot | null
  ) {
    const scroller = this.props.scrollerRef.current;
    if (!snapshot || !scroller || !snapshot.anchor.isConnected) return;
    scroller.scrollTop = scrollTopKeepingAnchor(
      scroller.scrollTop,
      snapshot.top,
      offsetInScroller(snapshot.anchor, scroller)
    );
  }

  render() {
    return null;
  }
}

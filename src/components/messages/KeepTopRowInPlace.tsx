import { Component, type RefObject } from 'react';
import { scrollTopKeepingAnchor } from '@/lib/scroll-anchor';

/** The transcript's top-level rows (messages and relocated subagent boxes). */
const TOP_ROW_SELECTOR = ':scope > [data-message-id], :scope > [data-subagent-box]';

interface KeepTopRowInPlaceProps {
  scrollerRef: RefObject<HTMLElement | null>;
  /**
   * Changes whenever content may have been added or removed above the topmost
   * row — the first row's key and whether there are older pages to load.
   */
  topKey: string;
}

interface Snapshot {
  anchor: Element;
  top: number;
}

/**
 * Keeps the user looking at the same messages when an older page is prepended:
 * measures the topmost row just before the commit and scrolls by however far it
 * moved right after, before the browser paints.
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
export class KeepTopRowInPlace extends Component<KeepTopRowInPlaceProps> {
  getSnapshotBeforeUpdate(prevProps: KeepTopRowInPlaceProps): Snapshot | null {
    if (prevProps.topKey === this.props.topKey) return null;
    const anchor = this.props.scrollerRef.current?.querySelector(TOP_ROW_SELECTOR);
    return anchor ? { anchor, top: anchor.getBoundingClientRect().top } : null;
  }

  componentDidUpdate(
    _prevProps: KeepTopRowInPlaceProps,
    _prevState: unknown,
    snapshot: Snapshot | null
  ) {
    const scroller = this.props.scrollerRef.current;
    if (!snapshot || !scroller || !snapshot.anchor.isConnected) return;
    scroller.scrollTop = scrollTopKeepingAnchor(
      scroller.scrollTop,
      snapshot.top,
      snapshot.anchor.getBoundingClientRect().top
    );
  }

  render() {
    return null;
  }
}

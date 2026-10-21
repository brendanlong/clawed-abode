/**
 * Index of the first row whose bottom is below `viewTop` — the topmost row at
 * least partly in view — or -1 when none is. Rows are in top-to-bottom order,
 * so this is a binary search: only O(log n) rows are measured.
 */
export function firstVisibleRowIndex(
  rowCount: number,
  rowBottom: (index: number) => number,
  viewTop: number
): number {
  let low = 0;
  let high = rowCount;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rowBottom(mid) > viewTop) high = mid;
    else low = mid + 1;
  }
  return low < rowCount ? low : -1;
}

/**
 * Where to scroll so an anchor element sits where it did before a commit moved
 * it: shift by exactly as much as the anchor moved. When the browser's own
 * scroll anchoring already compensated, the anchor didn't move and neither does
 * the scroll position, so the two never add up.
 *
 * `anchorTopBefore`/`anchorTopAfter` are the anchor's offsets from the
 * scroller's top edge just before the commit and just after it, with
 * `scrollTop` read at the second measurement.
 */
export function scrollTopKeepingAnchor(
  scrollTop: number,
  anchorTopBefore: number,
  anchorTopAfter: number
): number {
  return scrollTop + (anchorTopAfter - anchorTopBefore);
}

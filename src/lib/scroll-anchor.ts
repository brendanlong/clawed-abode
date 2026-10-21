/**
 * Where to scroll so an anchor element sits where it did before a commit moved
 * it: shift by exactly as much as the anchor moved. When the browser's own
 * scroll anchoring already compensated, the anchor didn't move and neither does
 * the scroll position, so the two never add up.
 *
 * `anchorTopBefore`/`anchorTopAfter` are the anchor's viewport tops
 * (`getBoundingClientRect().top`) just before the commit and just after it,
 * with `scrollTop` read at the second measurement.
 */
export function scrollTopKeepingAnchor(
  scrollTop: number,
  anchorTopBefore: number,
  anchorTopAfter: number
): number {
  return scrollTop + (anchorTopAfter - anchorTopBefore);
}

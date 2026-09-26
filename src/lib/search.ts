/** Whether `haystack` contains every whitespace-separated term of `query`, case-insensitively. */
export function matchesAllTerms(haystack: string, query: string): boolean {
  const lower = haystack.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => lower.includes(term));
}

export interface CappedMatches<T> {
  /** At most `limit` items, in the input order. */
  matches: T[];
  /** How many items matched before the cap. */
  total: number;
}

/**
 * The first `limit` of `ordered`, so pickers over huge lists stay responsive.
 * An item satisfying `isPinned` (the current selection) that falls past the cap
 * takes the first slot, so the picker can still show it as selected.
 */
export function capMatches<T>(
  ordered: readonly T[],
  limit: number,
  isPinned: (item: T) => boolean = () => false
): CappedMatches<T> {
  const pinned = ordered.slice(limit).find(isPinned);
  const matches =
    pinned === undefined ? ordered.slice(0, limit) : [pinned, ...ordered.slice(0, limit - 1)];
  return { matches, total: ordered.length };
}

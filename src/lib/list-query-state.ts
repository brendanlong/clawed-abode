/**
 * Which message a list-backed query should render.
 *
 * Every selector in the new-session flow renders a list from a tRPC query, and
 * each one used to collapse "the query failed" into "the list is empty" — a
 * GitHub token missing `Contents: Read` reported private repos as empty rather
 * than inaccessible. Centralizing the choice keeps the two cases distinct
 * everywhere.
 *
 * `error` wins only when there is nothing to show: TanStack Query keeps the
 * previous data when a *refetch* fails, and replacing a usable list with an
 * error message would take away a selection the user could still make.
 */
export type ListQueryState = 'loading' | 'error' | 'empty' | 'ready';

export function resolveListQueryState({
  isLoading,
  hasError,
  itemCount,
}: {
  isLoading: boolean;
  hasError: boolean;
  itemCount: number;
}): ListQueryState {
  if (isLoading) return 'loading';
  if (itemCount > 0) return 'ready';
  return hasError ? 'error' : 'empty';
}

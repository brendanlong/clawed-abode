import type { QueryClient } from '@tanstack/react-query';

/** Marks a query as one to refetch when a session SSE stream errors (events may have been missed). */
export const STREAM_ERROR_RESYNC_META = { resyncOnStreamError: true } as const;

/**
 * Options for queries that are seeded once and then kept current by an SSE
 * stream. `staleTime: Infinity` keeps a remount from clobbering the live value
 * with a stale read, so the focus/reconnect refetch uses `'always'`, which
 * bypasses staleness. That covers the stream having died while the tab was
 * hidden or offline. Explicit `refetch`/`invalidate` calls ignore `staleTime`,
 * so the stream-driven refreshes still work.
 */
export const LIVE_QUERY_OPTIONS = {
  staleTime: Infinity,
  refetchOnWindowFocus: 'always',
  refetchOnReconnect: 'always',
  meta: STREAM_ERROR_RESYNC_META,
} as const;

/** Refetch every mounted query tagged with {@link STREAM_ERROR_RESYNC_META}. */
export function resyncLiveQueries(queryClient: QueryClient): Promise<void> {
  return queryClient.refetchQueries({
    type: 'active',
    predicate: (query) => query.meta?.resyncOnStreamError === true,
  });
}

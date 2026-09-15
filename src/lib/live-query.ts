import type { QueryClient } from '@tanstack/react-query';

/** Marks a query as one to refetch when a session SSE stream errors (events may have been missed). */
export const STREAM_ERROR_RESYNC_META = { resyncOnStreamError: true } as const;

/**
 * Options for queries holding latest-value state that an SSE stream writes into
 * with `setQueryData`. The stream is never replayed for these (see
 * `sse.onSessionEvents`), so a refetch is the only thing that recovers state the
 * client missed — and the stream's subscription lives in the same component as
 * the queries, so while they're unmounted nothing is maintaining the cache at all.
 *
 * Every entry point therefore refetches unconditionally: mount (the session page
 * remounts on client-side navigation, which fires no `visibilitychange`), tab
 * focus, network reconnect, and stream error. `staleTime` is deliberately unset —
 * with all three refetch triggers on `'always'` it would have no effect, and
 * trusting an unmaintained cache is what leaves a stale "Claude is working"
 * indicator on screen.
 */
export const LIVE_QUERY_OPTIONS = {
  refetchOnMount: 'always',
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

/**
 * Options for the session-list queries, which the session-list SSE stream keeps
 * current by triggering refetches. That stream carries signals, not state, and is
 * never replayed, so a refetch is the only thing that recovers what the client
 * missed — and while the list is unmounted nothing is maintaining its cache.
 *
 * Every entry point therefore refetches unconditionally: mount (client-side
 * navigation fires no `visibilitychange`), tab focus, and network reconnect
 * (stream errors are handled by `SessionListContainer`). `staleTime` is
 * deliberately unset — with all three triggers on `'always'` it would have no
 * effect, and trusting an unmaintained cache is what leaves a stale badge on
 * screen.
 */
export const LIVE_QUERY_OPTIONS = {
  refetchOnMount: 'always',
  refetchOnWindowFocus: 'always',
  refetchOnReconnect: 'always',
} as const;

'use client';

import { trpc } from '@/lib/trpc';
import { useRefetchOnReconnect } from './useRefetchOnReconnect';

/**
 * Subscribes to the global session-list SSE stream so the home page updates live
 * when any session changes (created, started, finished, archived) or Claude's
 * turn state flips between running and waiting — including changes driven from
 * another tab or by background work.
 *
 * The list is small, so on each event we simply refetch rather than surgically
 * patching the cache. We also refetch on tab-visibility / network reconnect as a
 * resync fallback if the stream was dropped.
 */
export function useSessionListStream(refetch: () => void) {
  useRefetchOnReconnect(refetch);

  trpc.sse.onSessionListEvents.useSubscription(undefined, {
    onData: () => refetch(),
    onError: (err) => {
      console.error('Session list stream SSE error:', err);
      refetch();
    },
  });
}

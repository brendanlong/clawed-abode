'use client';

import { useSessionListEvent } from '@/lib/session-list-stream-context';
import { useRefetchOnReconnect } from './useRefetchOnReconnect';

/**
 * Keeps the home page live: refetch on any session-list stream event (a session
 * changed, or Claude's turn/background state flipped, in any tab), on a stream
 * error (events may have been missed), and on tab-visibility / network reconnect.
 * Refetching beats patching the cache: a page is one query and the event may
 * reorder the list.
 */
export function useSessionListStream(refetch: () => void) {
  useRefetchOnReconnect(refetch);
  useSessionListEvent(refetch, refetch);
}

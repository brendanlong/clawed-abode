'use client';

import { useCallback } from 'react';
import { trpc } from '@/lib/trpc';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers';

export type Session = inferRouterOutputs<AppRouter>['sessions']['list']['sessions'][number];

export interface PagedSessions {
  sessions: Session[];
  isLoading: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  fetchMore: () => void;
}

export interface UseSessionListOptions {
  /** Omit for the active (non-archived) list. */
  status?: 'archived';
  enabled?: boolean;
}

/**
 * One keyset-paginated session list (active or archived). Pages are flattened
 * for rendering; `refetch` refreshes every loaded page (the list stream calls it
 * on any session event).
 */
export function useSessionList({
  status,
  enabled = true,
}: UseSessionListOptions = {}): PagedSessions & { refetch: () => void } {
  const query = trpc.sessions.list.useInfiniteQuery(
    { status },
    { getNextPageParam: (lastPage) => lastPage.nextCursor, enabled }
  );
  const { fetchNextPage, refetch } = query;

  return {
    sessions: query.data?.pages.flatMap((page) => page.sessions) ?? [],
    // isPending (not isLoading) so a list that was disabled until now reads as loading, not empty.
    isLoading: query.isPending,
    hasMore: query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    fetchMore: useCallback(() => void fetchNextPage(), [fetchNextPage]),
    refetch: useCallback(() => void refetch(), [refetch]),
  };
}

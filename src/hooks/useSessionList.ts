'use client';

import { useCallback } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers';

export type Session = inferRouterOutputs<AppRouter>['sessions']['list']['sessions'][number];

export interface PagedSessions {
  sessions: Session[];
  isLoading: boolean;
  /** Showing the previous search's results while this one loads. */
  isStale: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  /** The last next-page load failed. */
  loadFailed: boolean;
  fetchMore: () => void;
}

export interface UseSessionListOptions {
  /** Omit for the active (non-archived) list. */
  status?: 'archived';
  search?: string;
  enabled?: boolean;
}

/**
 * One keyset-paginated session list (active or archived). Pages are flattened
 * for rendering; `refetch` refreshes every loaded page (the list stream calls it
 * on any session event).
 */
export function useSessionList({
  status,
  search,
  enabled = true,
}: UseSessionListOptions = {}): PagedSessions & { refetch: () => void } {
  const query = trpc.sessions.list.useInfiniteQuery(
    { status, search },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      enabled,
      // Keep showing the previous results while a new search loads, instead of a spinner.
      placeholderData: keepPreviousData,
      // The session-list SSE stream only signals refetches and is never replayed,
      // and nothing maintains this cache while the list is unmounted, so every
      // entry point refetches unconditionally (client-side navigation fires no
      // visibilitychange; stream errors are handled by SessionListContainer).
      // No staleTime: with all three on 'always' it would have no effect.
      refetchOnMount: 'always',
      refetchOnWindowFocus: 'always',
      refetchOnReconnect: 'always',
    }
  );
  const { fetchNextPage, refetch } = query;

  return {
    sessions: query.data?.pages.flatMap((page) => page.sessions) ?? [],
    // isPending (not isLoading) so a list that was disabled until now reads as loading, not empty.
    isLoading: query.isPending,
    isStale: query.isPlaceholderData,
    hasMore: query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    loadFailed: query.isFetchNextPageError,
    fetchMore: useCallback(() => void fetchNextPage(), [fetchNextPage]),
    refetch: useCallback(() => void refetch(), [refetch]),
  };
}

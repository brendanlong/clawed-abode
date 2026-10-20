import { useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import { HISTORY_PAGE_SIZE } from '@/lib/message-cache';
import type { DisplayMessage } from '@/components/messages/types';

/**
 * The `getHistory` cache key. Shared with `useSessionStream`, which writes the
 * newest page and live messages into this exact cache — a differing input would
 * land them in one nobody reads.
 */
export function historyQueryInput(sessionId: string) {
  return { sessionId, limit: HISTORY_PAGE_SIZE };
}

/**
 * Hook for reading message history with infinite-scroll pagination.
 *
 * The newest page and every live message come from the session stream
 * (`useSessionStream`), which writes them directly into this query's cache; the
 * query itself only ever fetches older pages, when the user scrolls up.
 */
export function useSessionMessages(sessionId: string) {
  const {
    data: historyData,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = trpc.claude.getHistory.useInfiniteQuery(historyQueryInput(sessionId), {
    // Never fetch the first page: the stream's snapshot seeds it. fetchNextPage
    // still runs on demand.
    enabled: false,
    // Limit stored pages to prevent memory growth
    // With HISTORY_PAGE_SIZE messages per page, this keeps up to 10000 messages in memory
    maxPages: 500,
    // For loading OLDER messages (user scrolls up)
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasMore) return undefined;
      // Find the oldest sequence across ALL pages (not just lastPage, which might be empty)
      let oldestSequence: number | undefined;
      for (const page of allPages) {
        for (const msg of page.messages) {
          if (oldestSequence === undefined || msg.sequence < oldestSequence) {
            oldestSequence = msg.sequence;
          }
        }
      }
      return oldestSequence;
    },
  });

  // Flatten the pages into chronological order. pages[0] is the newest (it is
  // also where the SSE stream inserts live messages, by sequence); each later
  // page is an older backward fetch. Each page's messages are already chronological.
  const messages = useMemo(() => {
    if (!historyData?.pages) return [];
    const result: DisplayMessage[] = [];
    for (let i = historyData.pages.length - 1; i >= 0; i--) {
      for (const msg of historyData.pages[i].messages) {
        result.push(msg);
      }
    }
    return result;
  }, [historyData]);

  return {
    messages,
    // Until the stream's first snapshot lands.
    isLoading: historyData === undefined,
    isFetchingMore: isFetchingNextPage,
    hasMore: hasNextPage ?? false,
    fetchMore: fetchNextPage,
  };
}

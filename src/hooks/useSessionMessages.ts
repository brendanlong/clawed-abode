import { useMemo } from 'react';
import { trpc } from '@/lib/trpc';

interface Message {
  id: string;
  type: string;
  content: unknown;
  sequence: number;
}

const MESSAGE_PAGE_SIZE = 20;

/**
 * Hook for reading message history with infinite-scroll pagination and token usage.
 *
 * Live messages are delivered by the single SSE stream in `useSessionStream`, which
 * writes them directly into this query's cache. This hook is read-only over that
 * cache plus backward pagination.
 */
export function useSessionMessages(sessionId: string) {
  // Bidirectional infinite query for message history
  // - fetchNextPage: loads older messages (backward) when user scrolls up
  // - New messages arrive via SSE (useSessionStream) and are added to the cache
  const {
    data: historyData,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = trpc.claude.getHistory.useInfiniteQuery(
    { sessionId, limit: MESSAGE_PAGE_SIZE },
    {
      // Limit stored pages to prevent memory growth
      // With MESSAGE_PAGE_SIZE messages per page, this keeps up to 10000 messages in memory
      maxPages: 500,
      // Message data is immutable - never refetch automatically
      staleTime: Infinity,
      initialCursor: {
        direction: 'backward',
        sequence: undefined,
      },
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
        return { sequence: oldestSequence, direction: 'backward' as const };
      },
    }
  );

  // Fetch token usage stats (computed server-side from all messages).
  // Refetched by useSessionStream when complete messages arrive.
  const { data: tokenUsageData } = trpc.claude.getTokenUsage.useQuery(
    { sessionId },
    {
      refetchOnWindowFocus: false,
    }
  );

  // Flatten bidirectional pages into chronological order
  // Pages array structure:
  // - pages[0] = newest (from fetchPreviousPage, or initial if no previous fetched)
  // - pages[n-1] = oldest (from fetchNextPage)
  // Each page's messages are already in chronological order
  const messages = useMemo(() => {
    if (!historyData?.pages) return [];

    const result: Message[] = [];
    // Reverse pages to get oldest-first, then flatten
    for (const page of [...historyData.pages].reverse()) {
      for (const msg of page.messages) {
        result.push({
          id: msg.id,
          type: msg.type,
          content: msg.content,
          sequence: msg.sequence,
        });
      }
    }
    return result;
  }, [historyData]);

  return {
    messages,
    isLoading,
    isFetchingMore: isFetchingNextPage,
    hasMore: hasNextPage ?? false,
    fetchMore: fetchNextPage,
    tokenUsage: tokenUsageData,
  };
}

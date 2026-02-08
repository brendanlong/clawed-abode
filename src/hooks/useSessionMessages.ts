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
 * Hook for managing message state: history pagination, SSE updates for new messages, and token usage.
 */
export function useSessionMessages(sessionId: string) {
  const utils = trpc.useUtils();

  // Bidirectional infinite query for message history
  // - fetchNextPage: loads older messages (backward) when user scrolls up
  // - New messages arrive via SSE and are added directly to the cache
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

  // Fetch token usage stats (computed server-side from all messages)
  const { data: tokenUsageData, refetch: refetchTokenUsage } = trpc.claude.getTokenUsage.useQuery(
    { sessionId },
    {
      // Refetch less frequently since it's just for display
      refetchOnWindowFocus: false,
    }
  );

  // Compute newest sequence from cache for SSE catch-up cursor
  const newestSequence = useMemo(() => {
    if (!historyData?.pages) return undefined;
    let newest: number | undefined;
    for (const page of historyData.pages) {
      for (const msg of page.messages) {
        if (newest === undefined || msg.sequence > newest) {
          newest = msg.sequence;
        }
      }
    }
    return newest;
  }, [historyData]);

  // Subscribe to new messages via SSE - update cache directly
  // Pass cursor to catch up on missed messages when connecting/reconnecting
  // Handles both complete messages (persisted) and partial messages (transient streaming updates)
  trpc.sse.onNewMessage.useSubscription(
    { sessionId, afterSequence: newestSequence },
    {
      onData: (trackedData) => {
        const newMessage = trackedData.data.message;
        const isPartial = newMessage.id.startsWith('partial-');

        // Add message directly to the infinite query cache
        utils.claude.getHistory.setInfiniteData({ sessionId, limit: MESSAGE_PAGE_SIZE }, (old) => {
          if (!old) {
            // No existing data - create initial page
            return {
              pages: [{ messages: [newMessage], hasMore: false }],
              pageParams: [{ direction: 'backward' as const, sequence: undefined }],
            };
          }

          if (isPartial) {
            // Partial message: replace existing partial or add new one
            const newPages = old.pages.map((page, pageIndex) => {
              if (pageIndex !== 0) return page;
              // Replace existing partial, or append if none exists
              const hasExistingPartial = page.messages.some((m) => m.id.startsWith('partial-'));
              if (hasExistingPartial) {
                return {
                  ...page,
                  messages: page.messages.map((m) =>
                    m.id.startsWith('partial-') ? newMessage : m
                  ),
                };
              }
              return { ...page, messages: [...page.messages, newMessage] };
            });
            return { ...old, pages: newPages };
          }

          // Complete message: remove any partial messages and add the new one
          // Check for deduplication first
          for (const page of old.pages) {
            if (page.messages.some((m) => m.id === newMessage.id)) {
              return old; // Already have this message
            }
          }

          const newPages = [...old.pages];
          // Remove partial messages from the first page (they're replaced by complete messages)
          const firstPageMessages = newPages[0].messages.filter(
            (m) => !m.id.startsWith('partial-')
          );
          newPages[0] = {
            ...newPages[0],
            messages: [...firstPageMessages, newMessage],
          };

          return { ...old, pages: newPages };
        });

        // Refetch token usage only for complete messages (partials don't affect totals)
        if (!isPartial) {
          refetchTokenUsage();
        }
      },
      onError: (err) => {
        console.error('Message SSE error:', err);
      },
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

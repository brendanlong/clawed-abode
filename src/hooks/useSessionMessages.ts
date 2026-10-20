import { useCallback } from 'react';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { trpc } from '@/lib/trpc';
import {
  HISTORY_PAGE_SIZE,
  olderPageCursor,
  prependOlderPage,
  type TranscriptCache,
} from '@/lib/message-cache';
import type { AppRouter } from '@/server/routers';

type HistoryMessage = inferRouterOutputs<AppRouter>['claude']['getHistory']['messages'][number];

/** A session's cached transcript, as the stream and older-page loads write it. */
export type SessionTranscript = TranscriptCache<HistoryMessage>;

/**
 * Cache key of a session's {@link SessionTranscript}. Shared with
 * `useSessionStream`, which writes the newest page and live messages into it.
 */
export const sessionTranscriptKey = (sessionId: string) =>
  ['sessionTranscript', sessionId] as const;

/**
 * A session's transcript, with backward pagination.
 *
 * The newest page and every live message come from the session stream
 * (`useSessionStream`); this hook only loads older pages, when the user scrolls
 * up. Each one is prepended onto the cache as it is when the page lands (see
 * `prependOlderPage`), so a live write during the load is kept. A mutation runs
 * the load because it is an imperative one-off whose result is merged into
 * another cache entry, not a cache entry of its own.
 */
export function useSessionMessages(sessionId: string) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const transcript = useQuery<SessionTranscript>({
    queryKey: sessionTranscriptKey(sessionId),
    queryFn: skipToken,
  }).data;

  const {
    mutate: loadOlder,
    isPending: isFetchingMore,
    isError: loadFailed,
  } = useMutation({
    mutationFn: async (cursor: number) => ({
      cursor,
      page: await utils.client.claude.getHistory.query({
        sessionId,
        cursor,
        limit: HISTORY_PAGE_SIZE,
      }),
    }),
    onSuccess: ({ cursor, page }) => {
      queryClient.setQueryData<SessionTranscript>(sessionTranscriptKey(sessionId), (old) =>
        prependOlderPage(old, cursor, page)
      );
    },
  });

  const cursor = olderPageCursor(transcript);
  const fetchMore = useCallback(() => {
    if (cursor !== undefined && !isFetchingMore) loadOlder(cursor);
  }, [cursor, isFetchingMore, loadOlder]);

  return {
    messages: transcript?.messages ?? [],
    // Until the stream's first snapshot lands.
    isLoading: transcript === undefined,
    isFetchingMore,
    /** The last older-page load failed (retried when the user next scrolls up). */
    loadFailed,
    hasMore: cursor !== undefined,
    fetchMore,
  };
}

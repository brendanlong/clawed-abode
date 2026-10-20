'use client';

import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';
import {
  applyHistorySnapshot,
  mergeMessageIntoCache,
  removeMessageFromCache,
  isPartialMessageId,
} from '@/lib/message-cache';
import { applySessionStateEvent, type SessionStreamState } from '@/lib/session-stream-state';
import { affectsTokenUsage } from '@/lib/token-estimation';
import { historyQueryInput } from '@/hooks/useSessionMessages';

/**
 * Cache key of a session's {@link SessionStreamState}. Only the stream writes it;
 * readers use {@link useSessionStreamState}.
 */
const sessionStreamStateKey = (sessionId: string) => ['sessionStream', sessionId] as const;

/**
 * The session row and latest-value state the session's stream maintains.
 * Undefined until the stream's first snapshot (or what an earlier mount left).
 */
export function useSessionStreamState(sessionId: string): SessionStreamState | undefined {
  return useQuery<SessionStreamState>({
    queryKey: sessionStreamStateKey(sessionId),
    queryFn: skipToken,
  }).data;
}

/**
 * Single multiplexed SSE subscription for a session: one `EventSource`, fanning
 * each event out to the relevant React Query cache. It is the only source of the
 * session row, its live state, and the newest transcript page — every (re)connect
 * opens with a snapshot of all three, so nothing needs refetching around it (see
 * `sse.onSessionEvents`).
 *
 * Returns the subscription status for a UI indicator. `error` is terminal (tRPC
 * reconnects on its own from anything transient): the server rejected the
 * session, e.g. it doesn't exist.
 */
export function useSessionStream(sessionId: string) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();

  const subscription = trpc.sse.onSessionEvents.useSubscription(
    { sessionId },
    {
      onData: ({ data: event }) => {
        const setHistory = utils.claude.getHistory.setInfiniteData;
        switch (event.kind) {
          case 'message':
            setHistory(historyQueryInput(sessionId), (old) =>
              mergeMessageIntoCache(old, event.message)
            );
            if (
              !isPartialMessageId(event.message.id) &&
              affectsTokenUsage(event.message.type, event.message.content)
            ) {
              void utils.claude.getTokenUsage.refetch({ sessionId });
            }
            // Readings move per API call, but a turn's end is often enough.
            if (event.message.type === 'result') {
              void utils.rateLimit.getSessionUsage.invalidate({ sessionId });
            }
            return;
          case 'message_removed':
            setHistory(historyQueryInput(sessionId), (old) =>
              removeMessageFromCache(old, event.messageId)
            );
            return;
          case 'snapshot':
            setHistory(historyQueryInput(sessionId), (old) =>
              applyHistorySnapshot(old, event.history)
            );
            // Messages may have arrived while disconnected.
            void utils.claude.getTokenUsage.invalidate({ sessionId });
            break;
        }
        queryClient.setQueryData<SessionStreamState>(sessionStreamStateKey(sessionId), (old) =>
          applySessionStateEvent(old, event)
        );
      },
    }
  );

  return { status: subscription.status };
}

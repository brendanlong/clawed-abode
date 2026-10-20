'use client';

import { useEffect, useRef, useState } from 'react';
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
 * Returning to the tab (or coming back online) reconnects from scratch, so every
 * return gets a fresh snapshot — which also re-arms the server's poll of the
 * session's PR. A half-open connection would otherwise go unnoticed until tRPC's
 * inactivity timeout, and a connection the `EventSource` gave up on (e.g. after an
 * HTTP 503) would never come back.
 *
 * Returns the subscription status for a UI indicator, whether the server said the
 * session doesn't exist, and `reconnect` for a manual retry after a terminal error.
 */
export function useSessionStream(sessionId: string) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  // Starts true: the first connection is quiet too (see `quiet` below). The
  // session page remounts per session id (it is keyed by it), so each session's
  // first connection gets this.
  const [quietReconnect, setQuietReconnect] = useState(true);

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

  // The first connection and a reconnect we start from a healthy stream aren't
  // news: hide their connecting phase, but not a failure (a connecting state
  // carrying an error, or a terminal error).
  const { reset, status, error } = subscription;
  const quiet = quietReconnect && status === 'connecting' && !error;
  // Adjust state during render (React's supported pattern): once that connection
  // settles either way, later connecting phases are tRPC's own and show.
  if (quietReconnect && !quiet) setQuietReconnect(false);
  const displayedStatus = quiet ? 'pending' : status;
  const notFound = error?.data?.code === 'NOT_FOUND';

  // What the tab-return handler needs to know about the stream right now.
  const current = useRef({ healthy: false, notFound: false });
  useEffect(() => {
    current.current = { healthy: displayedStatus === 'pending', notFound };
  });

  useEffect(() => {
    const reconnect = () => {
      // The session is gone; a reset would only flicker the page to the spinner.
      if (current.current.notFound) return;
      // During an outage the banner is already up and must stay up.
      if (current.current.healthy) setQuietReconnect(true);
      reset();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') reconnect();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', reconnect);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', reconnect);
    };
  }, [reset]);

  return {
    /** For display: a quiet (re)connect reads as connected. */
    status: displayedStatus,
    notFound,
    reconnect: reset,
  };
}

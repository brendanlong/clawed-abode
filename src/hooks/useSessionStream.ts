'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';
import { resyncLiveQueries } from '@/lib/live-query';
import {
  mergeMessageIntoCache,
  removeMessageFromCache,
  isPartialMessageId,
} from '@/lib/message-cache';
import { assertNeverFallback } from '@/lib/claude-messages';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers';

type SessionGetOutput = inferRouterOutputs<AppRouter>['sessions']['get'];
type LiveState = inferRouterOutputs<AppRouter>['claude']['getLiveState'];

const MESSAGE_PAGE_SIZE = 20;

interface CachedMessage {
  id: string;
  sessionId: string;
  sequence: number;
  type: string;
  content: unknown;
  createdAt: Date;
}

interface UseSessionStreamOptions {
  /** True once the initial `getHistory` load has completed. */
  historyLoaded: boolean;
  /** Newest message sequence in the cache at the time history first loaded. */
  newestSequence: number | undefined;
}

/**
 * Single multiplexed SSE subscription for a session: one `EventSource`, fanning
 * each event kind out to the relevant React Query cache.
 *
 * Catch-up: the subscription is gated until history has loaded, then started with
 * a one-time `afterSequence` anchor (the client's newest cached sequence, frozen in
 * a ref so it never changes — feeding it reactively would tear the stream down each
 * turn). That closes the gap between the `getHistory` snapshot and the stream
 * attaching. Subsequent reconnects use tRPC's native `lastEventId` resume instead.
 *
 * On a connection error, or a server `resync` (its event buffer overflowed), we
 * refetch every mounted live query (resyncLiveQueries). Returns the subscription connection status
 * for a UI indicator.
 */
export function useSessionStream(sessionId: string, options: UseSessionStreamOptions) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();

  // Freeze the catch-up anchor the first time history is loaded so the subscription
  // input stays stable across the rest of the session (feeding the live newest
  // sequence reactively would tear the stream down every turn).
  const [anchor, setAnchor] = useState<{ captured: boolean; afterSequence: number | undefined }>({
    captured: false,
    afterSequence: undefined,
  });
  // Capture the anchor once, during render (React's supported "adjust state from a
  // prior render" pattern). The guard makes it fire at most once, so no loop.
  if (!anchor.captured && options.historyLoaded) {
    setAnchor({ captured: true, afterSequence: options.newestSequence });
  }

  // Patch one field of the live-state cache. Before the initial fetch lands
  // there's nothing to patch; that fetch returns current values anyway.
  const patchLiveState = (patch: Partial<LiveState>) =>
    utils.claude.getLiveState.setData({ sessionId }, (old) => (old ? { ...old, ...patch } : old));

  const subscription = trpc.sse.onSessionEvents.useSubscription(
    { sessionId, afterSequence: anchor.afterSequence },
    {
      enabled: anchor.captured,
      onData: (tracked) => {
        const event = tracked.data;
        switch (event.kind) {
          case 'message': {
            utils.claude.getHistory.setInfiniteData(
              { sessionId, limit: MESSAGE_PAGE_SIZE },
              (old) => mergeMessageIntoCache(old, event.message as CachedMessage)
            );
            // Complete (persisted) messages affect token totals; partials do not.
            if (!isPartialMessageId(event.message.id)) {
              void utils.claude.getTokenUsage.refetch({ sessionId });
            }
            break;
          }
          case 'running': {
            patchLiveState({ running: event.running });
            break;
          }
          case 'commands': {
            patchLiveState({ commands: event.commands });
            break;
          }
          case 'session': {
            utils.sessions.get.setData(
              { sessionId },
              { session: event.session as SessionGetOutput['session'] }
            );
            break;
          }
          case 'retry': {
            patchLiveState({ retry: event.retry });
            break;
          }
          case 'background': {
            patchLiveState({ backgroundTasks: event.tasks });
            break;
          }
          case 'message_removed': {
            utils.claude.getHistory.setInfiniteData(
              { sessionId, limit: MESSAGE_PAGE_SIZE },
              (old) => removeMessageFromCache(old, event.messageId)
            );
            break;
          }
          case 'pending': {
            patchLiveState({ pendingMessageIds: event.messageIds });
            break;
          }
          case 'queued': {
            patchLiveState({ queuedMessageIds: event.messageIds });
            break;
          }
          case 'rate_limit': {
            patchLiveState({ rateLimitHold: event.hold });
            break;
          }
          case 'resync': {
            void resyncLiveQueries(queryClient);
            break;
          }
          default:
            // Compile-time guard: a new SessionStreamEvent kind must be handled here.
            assertNeverFallback(event, undefined);
        }
      },
      onError: (err) => {
        console.error('Session stream SSE error:', err);
        // The stream will auto-reconnect; refetch so the UI is correct meanwhile.
        void resyncLiveQueries(queryClient);
      },
    }
  );

  return { status: subscription.status };
}

'use client';

import { useCallback, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { mergeMessageIntoCache, isPartialMessageId } from '@/lib/message-cache';
import { assertNeverFallback } from '@/lib/claude-messages';
import type { PullRequestInfo } from './usePullRequestStatus';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers';

type SessionGetOutput = inferRouterOutputs<AppRouter>['sessions']['get'];

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
 * Single multiplexed SSE subscription for a session. Replaces the previous five
 * per-channel subscriptions: it opens one `EventSource` and fans each event kind
 * out to the relevant React Query cache.
 *
 * Catch-up: the subscription is gated until history has loaded, then started with
 * a one-time `afterSequence` anchor (the client's newest cached sequence, frozen in
 * a ref so it never changes — feeding it reactively would tear the stream down each
 * turn). That closes the gap between the `getHistory` snapshot and the stream
 * attaching. Subsequent reconnects use tRPC's native `lastEventId` resume instead.
 *
 * On a connection error we refetch the session queries as a belt-and-suspenders
 * resync. Returns the subscription connection status for a UI indicator.
 */
export function useSessionStream(sessionId: string, options: UseSessionStreamOptions) {
  const utils = trpc.useUtils();

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

  const resync = useCallback(() => {
    void utils.claude.isRunning.refetch({ sessionId });
    void utils.claude.getCommands.refetch({ sessionId });
    void utils.sessions.get.refetch({ sessionId });
    void utils.claude.getTokenUsage.refetch({ sessionId });
    void utils.claude.getRetryState.refetch({ sessionId });
    void utils.claude.getBackgroundTasks.refetch({ sessionId });
  }, [utils, sessionId]);

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
            utils.claude.isRunning.setData({ sessionId }, { running: event.running });
            // When Claude stops, new slash commands may have been discovered.
            if (!event.running) {
              void utils.claude.getCommands.refetch({ sessionId });
            }
            break;
          }
          case 'commands': {
            utils.claude.getCommands.setData({ sessionId }, { commands: event.commands });
            break;
          }
          case 'pr': {
            utils.github.getSessionPrStatus.setData(
              { sessionId },
              { pullRequest: event.pullRequest as PullRequestInfo | null }
            );
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
            utils.claude.getRetryState.setData({ sessionId }, { retry: event.retry });
            break;
          }
          case 'background': {
            utils.claude.getBackgroundTasks.setData({ sessionId }, { tasks: event.tasks });
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
        resync();
      },
    }
  );

  return { status: subscription.status };
}

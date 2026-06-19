'use client';

import { useCallback } from 'react';
import { trpc } from '@/lib/trpc';
import { mergeMessageIntoCache } from '@/lib/message-cache';
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

/**
 * Single multiplexed SSE subscription for a session. Replaces the previous five
 * per-channel subscriptions: it opens one `EventSource` and fans each event kind
 * out to the relevant React Query cache.
 *
 * The subscription input is stable (`{ sessionId }`) — catch-up after a reconnect
 * is handled by tRPC's native `lastEventId` resume, not by a reactive cursor. On a
 * connection error we additionally refetch the session queries as a belt-and-
 * suspenders resync.
 *
 * Returns the subscription connection status for a UI indicator.
 */
export function useSessionStream(sessionId: string) {
  const utils = trpc.useUtils();

  const resync = useCallback(() => {
    void utils.claude.isRunning.refetch({ sessionId });
    void utils.claude.getCommands.refetch({ sessionId });
    void utils.sessions.get.refetch({ sessionId });
    void utils.claude.getTokenUsage.refetch({ sessionId });
  }, [utils, sessionId]);

  const subscription = trpc.sse.onSessionEvents.useSubscription(
    { sessionId },
    {
      onData: (tracked) => {
        const event = tracked.data;
        switch (event.kind) {
          case 'message': {
            utils.claude.getHistory.setInfiniteData(
              { sessionId, limit: MESSAGE_PAGE_SIZE },
              (old) => mergeMessageIntoCache(old, event.message as CachedMessage)
            );
            // Complete (persisted) messages affect token totals; partials do not.
            if (!event.message.id.startsWith('partial-')) {
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

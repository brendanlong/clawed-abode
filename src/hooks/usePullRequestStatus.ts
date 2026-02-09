'use client';

import { trpc } from '@/lib/trpc';

export type PrState = 'open' | 'closed' | 'merged';

export interface PullRequestInfo {
  number: number;
  title: string;
  state: PrState;
  draft: boolean;
  url: string;
  author: string;
  updatedAt: string;
}

export interface UsePullRequestStatusResult {
  pullRequest: PullRequestInfo | null | undefined;
  isLoading: boolean;
}

/**
 * Hook to fetch and subscribe to PR status for a session.
 *
 * Uses the session's persisted `currentBranch` to look up PRs, so it works
 * even when the container is stopped.
 *
 * - Fetches initial PR status via tRPC query (cached 5 min)
 * - Subscribes to SSE updates so PR status updates in real-time when Claude finishes a turn
 *
 * @param sessionId - Session ID for query and SSE subscription
 * @param enabled - Whether to fetch (false for archived sessions)
 * @returns PR info, null if no PR, undefined if loading/disabled
 */
export function usePullRequestStatus(
  sessionId: string,
  enabled: boolean = true
): UsePullRequestStatusResult {
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.github.getSessionPrStatus.useQuery(
    { sessionId },
    {
      enabled,
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    }
  );

  // Subscribe to real-time PR updates via SSE
  trpc.sse.onPrUpdate.useSubscription(
    { sessionId },
    {
      enabled,
      onData: (trackedData) => {
        const event = trackedData.data;
        utils.github.getSessionPrStatus.setData(
          { sessionId },
          { pullRequest: event.pullRequest as PullRequestInfo | null }
        );
      },
    }
  );

  return {
    pullRequest: data?.pullRequest as PullRequestInfo | null | undefined,
    isLoading,
  };
}

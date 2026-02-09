'use client';

import { trpc } from '@/lib/trpc';
import { extractRepoFullName } from '@/lib/utils';

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
 * Hook to fetch and subscribe to PR status for a session's branch.
 *
 * - Fetches initial PR status via tRPC query (cached 5 min)
 * - Subscribes to SSE updates so PR status updates in real-time when Claude finishes a turn
 *
 * @param sessionId - Session ID for SSE subscription
 * @param repoUrl - Full GitHub repo URL (e.g. "https://github.com/owner/repo.git")
 * @param branch - Branch name
 * @param enabled - Whether to fetch (false for archived sessions)
 * @returns PR info, null if no PR, undefined if loading/disabled
 */
export function usePullRequestStatus(
  sessionId: string,
  repoUrl: string,
  branch: string,
  enabled: boolean = true
): UsePullRequestStatusResult {
  const repoFullName = extractRepoFullName(repoUrl);
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.github.getPullRequestForBranch.useQuery(
    { repoFullName, branch },
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
        utils.github.getPullRequestForBranch.setData(
          { repoFullName, branch },
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

'use client';

import { skipToken } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { useMessageListContext } from '@/components/messages/MessageListContext';

/** TanStack's default retry count, kept for transient failures. */
const MAX_RETRIES = 3;

/** A missing result won't appear on retry, so only other failures are retried. */
export function shouldRetryToolResult(failureCount: number, error: unknown): boolean {
  if (error instanceof TRPCClientError && error.data?.code === 'NOT_FOUND') return false;
  return failureCount < MAX_RETRIES;
}

/**
 * Full tool-result bodies never change, so a fetched one stays fresh for good
 * and is kept a while after its card collapses, for re-expanding and copying.
 */
export const TOOL_RESULT_QUERY_OPTIONS = {
  staleTime: Infinity,
  gcTime: 30 * 60_000,
  retry: shouldRetryToolResult,
} as const;

/**
 * Fetch the full text of a result the server sent only as a summary
 * (`claude.getToolResult`). Mount it only while the card is expanded;
 * concurrent fetches share one HTTP request through the batch link.
 */
export function useToolResultText(messageId: string, toolUseId: string | undefined) {
  const sessionId = useMessageListContext()?.sessionId;
  return trpc.claude.getToolResult.useQuery(
    sessionId && toolUseId ? { sessionId, messageId, toolUseId } : skipToken,
    TOOL_RESULT_QUERY_OPTIONS
  );
}

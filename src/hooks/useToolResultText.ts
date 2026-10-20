'use client';

import { skipToken } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';
import { useMessageListContext } from '@/components/messages/MessageListContext';

/**
 * Full tool-result bodies never change, so a fetched one stays fresh for good
 * and is kept a while after its card collapses, for re-expanding and copying.
 */
export const TOOL_RESULT_QUERY_OPTIONS = { staleTime: Infinity, gcTime: 30 * 60_000 } as const;

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

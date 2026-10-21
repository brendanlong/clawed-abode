'use client';

import { useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { MessageBubble } from './messages/MessageBubble';
import { NestedTranscript } from './messages/NestedTranscript';
import { TaskDisplay } from './messages/TaskDisplay';
import type { MessageContent, DisplayMessage } from './messages/types';
import { KeepVisibleRowInPlace } from './messages/KeepVisibleRowInPlace';
import { MessageListProvider } from './messages/MessageListContext';
import { Clock, PauseCircle } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { ContextUsageIndicator } from '@/components/ContextUsageIndicator';
import { SubscriptionUsageIndicator } from '@/components/SubscriptionUsageIndicator';
import type { TokenUsageStats } from '@/lib/token-estimation';
import type { SessionSubscriptionUsage } from '@/lib/usage';
import { useTranscriptScroll } from '@/hooks/useTranscriptScroll';
import { TOOL_RESULT_QUERY_OPTIONS } from '@/hooks/useToolResultText';
import { trpc } from '@/lib/trpc';
import {
  isToolCallOnlyMessage,
  isOwnPromptMessage,
  buildTranscriptLayout,
  transcriptRowKey,
  getLatestTodoWriteId,
  getPlanContentByToolUseId,
} from './messages/messageHelpers';

type Message = DisplayMessage;

interface MessageListProps {
  sessionId: string;
  messages: Message[];
  isLoading: boolean;
  hasMore: boolean;
  /** The last older-page load failed: retry only once the user scrolls back up. */
  loadFailed: boolean;
  onLoadMore: () => void;
  tokenUsage?: TokenUsageStats | null;
  subscriptionUsage?: SessionSubscriptionUsage | null;
  onAnswerQuestion?: (toolUseId: string, answers: Record<string, string>) => void;
  onRespondToPlan?: (toolUseId: string, approve: boolean, feedback?: string) => void;
  /**
   * Ids of user messages already handed to the SDK that the agent hasn't read
   * yet — rendered with a "Sending…" marker so a message that lands mid-tool
   * isn't mistaken for one Claude has already ignored.
   */
  pendingMessageIds?: string[];
  /**
   * Ids of user messages parked by a rate-limit pause — never handed to the SDK
   * at all, so they get their own marker rather than "Sending…".
   */
  queuedMessageIds?: string[];
  /**
   * Whether the session's query is live. Gates pinning a still-running subagent's
   * box to the bottom (a subagent whose result was lost to a dead query would
   * otherwise pin forever). See `computeSubagentPlacements` in messageHelpers.
   */
  isSessionRunning?: boolean;
}

export function MessageList({
  sessionId,
  messages,
  isLoading,
  hasMore,
  loadFailed,
  onLoadMore,
  tokenUsage,
  subscriptionUsage,
  onAnswerQuestion,
  onRespondToPlan,
  pendingMessageIds = [],
  queuedMessageIds = [],
  isSessionRunning = false,
}: MessageListProps) {
  const { containerRef, scrollerRef, topSentinelRef, bottomRef } = useTranscriptScroll({
    messages,
    hasMore,
    isLoading,
    loadFailed,
    onLoadMore,
  });

  const {
    resultMap,
    subagentMessagesByToolUseId,
    rows,
    pinnedSubagents,
    relocatedSubagentIds,
    retractedMessagesByFallbackId,
  } = useMemo(
    () => buildTranscriptLayout(messages, isSessionRunning),
    [messages, isSessionRunning]
  );

  const firstRowKey = rows[0] ? transcriptRowKey(rows[0]) : null;

  const latestTodoWriteId = useMemo(() => getLatestTodoWriteId(messages), [messages]);

  // Reconstruct plan content per ExitPlanMode call (keyed by tool_use id)
  const planContentByToolUseId = useMemo(() => getPlanContentByToolUseId(messages), [messages]);

  // Render a subagent Task's nested transcript. Lives here (not in TaskDisplay)
  // so the recursive MessageBubble import stays out of the tool-display modules.
  const renderSubagentTranscript = useCallback(
    (toolUseId: string) => {
      const children = subagentMessagesByToolUseId.get(toolUseId);
      if (!children || children.length === 0) return null;
      return (
        <div>
          <div className="text-muted-foreground mb-1">Subagent activity:</div>
          <NestedTranscript messages={children} toolResults={resultMap} />
        </div>
      );
    },
    [subagentMessagesByToolUseId, resultMap]
  );

  const renderRetractedMessages = useCallback(
    (fallbackMessageId: string) => {
      const retracted = retractedMessagesByFallbackId.get(fallbackMessageId);
      if (!retracted) return null;
      return <NestedTranscript messages={retracted} toolResults={resultMap} />;
    },
    [retractedMessagesByFallbackId, resultMap]
  );

  // Shares the expanded cards' query cache, so copying what was already opened is free.
  const utils = trpc.useUtils();
  const loadToolResultText = useCallback(
    async (messageId: string, toolUseId: string) => {
      const input = { sessionId, messageId, toolUseId };
      return (await utils.claude.getToolResult.fetch(input, TOOL_RESULT_QUERY_OPTIONS)).text;
    },
    [utils, sessionId]
  );

  const pendingIds = useMemo(() => new Set(pendingMessageIds), [pendingMessageIds]);
  const queuedIds = useMemo(() => new Set(queuedMessageIds), [queuedMessageIds]);

  const actions = useMemo(
    () => ({ sessionId, loadToolResultText, onAnswerQuestion, onRespondToPlan }),
    [sessionId, loadToolResultText, onAnswerQuestion, onRespondToPlan]
  );
  const transcript = useMemo(
    () => ({
      latestTodoWriteId,
      planContentByToolUseId,
      renderSubagentTranscript,
      renderRetractedMessages,
      relocatedSubagentIds,
    }),
    [
      latestTodoWriteId,
      planContentByToolUseId,
      renderSubagentTranscript,
      renderRetractedMessages,
      relocatedSubagentIds,
    ]
  );

  return (
    <div className="relative flex-1 min-h-0">
      {/* Bottom padding keeps the floating usage indicators off the newest message. */}
      <div ref={containerRef} className="h-full overflow-y-auto p-4 pb-16 sm:pb-12">
        {/* Loads older pages when it nears the view. */}
        <div ref={topSentinelRef} className="h-1" />

        {/* Keeps the view on the same messages when an older page lands. */}
        <KeepVisibleRowInPlace scrollerRef={scrollerRef} anchorKey={`${firstRowKey}:${hasMore}`} />

        {/* Loading slot for older pages, reserved for as long as there are any so
            only the spinner inside toggles: mounting the slot per fetch would push
            the rows down at scrollTop 0 and hide the spinner as soon as it showed.
            You only see the gap scrolled to the top of what's loaded, which is
            when the next fetch fills it. */}
        {hasMore && (
          <div data-older-messages-loader className="flex h-12 items-center justify-center">
            {isLoading && <Spinner size="sm" />}
          </div>
        )}

        {rows.length === 0 && !isLoading && (
          <div className="text-center text-muted-foreground py-12">
            No messages yet. Start a conversation with Claude!
          </div>
        )}

        <MessageListProvider actions={actions} transcript={transcript}>
          {rows.map((row, index) => {
            if (row.kind === 'taskbox') {
              // A relocated finished subagent box, at its finish position.
              const prev = rows[index - 1];
              const spacingClass = index === 0 ? '' : prev?.kind === 'taskbox' ? 'mt-1' : 'mt-4';
              return (
                <div
                  key={transcriptRowKey(row)}
                  data-subagent-box={row.toolUseId}
                  className={cn('flex justify-start', spacingClass)}
                >
                  <TaskDisplay tool={row.tool} isPendingOverride={false} />
                </div>
              );
            }

            const message = row.message;
            const isUserMessage = isOwnPromptMessage(message);

            // Spacing: full gap between messages, but tight when two consecutive
            // tool-call-only messages sit back-to-back (issue #312). The first
            // message gets no top margin (the container padding handles it).
            const prev = rows[index - 1];
            const backToBackToolCalls =
              prev?.kind === 'message' &&
              isToolCallOnlyMessage(prev.message.content as MessageContent) &&
              isToolCallOnlyMessage(message.content as MessageContent);
            const spacingClass = index === 0 ? '' : backToBackToolCalls ? 'mt-1' : 'mt-4';

            return (
              <div
                key={transcriptRowKey(row)}
                data-message-id={message.id}
                className={cn(
                  'flex flex-col',
                  isUserMessage ? 'items-end' : 'items-start',
                  spacingClass
                )}
              >
                <MessageBubble
                  message={{
                    id: message.id,
                    type: message.type,
                    content: message.content,
                    createdAt: message.createdAt,
                  }}
                  toolResults={resultMap}
                />
                {pendingIds.has(message.id) && (
                  <span className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    Sending…
                  </span>
                )}
                {queuedIds.has(message.id) && (
                  <span className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <PauseCircle className="h-3 w-3" />
                    Queued — waiting for the usage limit to reset
                  </span>
                )}
              </div>
            );
          })}

          {/* Running subagents pinned at the bottom: their live boxes stay next to
              the newest main-agent messages instead of collapsed at the spawn
              point far above. They settle to their finish position once done. */}
          {pinnedSubagents.length > 0 && (
            <div className="mt-4 border-t border-dashed pt-3" data-pinned-subagents>
              <div className="text-muted-foreground text-xs mb-2">
                Running subagent{pinnedSubagents.length > 1 ? 's' : ''}
              </div>
              <div className="space-y-2">
                {pinnedSubagents.map(({ toolUseId, tool }) => (
                  <div key={`pinned-${toolUseId}`} className="flex justify-start">
                    <TaskDisplay tool={tool} isPendingOverride />
                  </div>
                ))}
              </div>
            </div>
          )}
        </MessageListProvider>

        <div ref={bottomRef} />
      </div>

      <div className="absolute bottom-3 right-3 flex flex-col items-end gap-1 sm:flex-row sm:items-center">
        <SubscriptionUsageIndicator usage={subscriptionUsage} className="shadow-xs" />
        <ContextUsageIndicator stats={tokenUsage} className="shadow-xs" />
      </div>
    </div>
  );
}

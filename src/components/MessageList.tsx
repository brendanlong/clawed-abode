'use client';

import { useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { MessageBubble } from './messages/MessageBubble';
import { SubagentTranscript } from './messages/SubagentTranscript';
import { TaskDisplay } from './messages/TaskDisplay';
import type { MessageContent, DisplayMessage } from './messages/types';
import { MessageListProvider } from './messages/MessageListContext';
import { Clock, PauseCircle } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { ContextUsageIndicator } from '@/components/ContextUsageIndicator';
import type { TokenUsageStats } from '@/lib/token-estimation';
import { useTranscriptScroll } from '@/hooks/useTranscriptScroll';
import {
  isToolCallOnlyMessage,
  isOwnPromptMessage,
  buildTranscriptLayout,
  getLatestTodoWriteId,
  getPlanContentByToolUseId,
} from './messages/messageHelpers';

type Message = DisplayMessage;

interface MessageListProps {
  messages: Message[];
  isLoading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  tokenUsage?: TokenUsageStats | null;
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
  messages,
  isLoading,
  hasMore,
  onLoadMore,
  tokenUsage,
  onAnswerQuestion,
  onRespondToPlan,
  pendingMessageIds = [],
  queuedMessageIds = [],
  isSessionRunning = false,
}: MessageListProps) {
  const { containerRef, topSentinelRef, bottomRef } = useTranscriptScroll({
    messages,
    hasMore,
    isLoading,
    onLoadMore,
  });

  const {
    resultMap,
    pairedMessageIds,
    subagentMessagesByToolUseId,
    rows,
    pinnedSubagents,
    relocatedSubagentIds,
  } = useMemo(
    () => buildTranscriptLayout(messages, isSessionRunning),
    [messages, isSessionRunning]
  );

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
        <SubagentTranscript
          messages={children}
          toolResults={resultMap}
          pairedMessageIds={pairedMessageIds}
        />
      );
    },
    [subagentMessagesByToolUseId, resultMap, pairedMessageIds]
  );

  const pendingIds = useMemo(() => new Set(pendingMessageIds), [pendingMessageIds]);
  const queuedIds = useMemo(() => new Set(queuedMessageIds), [queuedMessageIds]);

  const contextValue = useMemo(
    () => ({
      latestTodoWriteId,
      onAnswerQuestion,
      onRespondToPlan,
      planContentByToolUseId,
      renderSubagentTranscript,
      relocatedSubagentIds,
    }),
    [
      latestTodoWriteId,
      onAnswerQuestion,
      onRespondToPlan,
      planContentByToolUseId,
      renderSubagentTranscript,
      relocatedSubagentIds,
    ]
  );

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={containerRef} className="h-full overflow-y-auto p-4">
        {/* Sentinel for triggering infinite scroll - placed before messages */}
        {/* overflow-anchor:none prevents browser from anchoring to these elements */}
        {/* so when new messages load above, the view stays on current messages */}
        <div ref={topSentinelRef} className="h-1" style={{ overflowAnchor: 'none' }} />

        {/* Loading slot for older pages. The slot is reserved for as long as there
            are older pages to fetch, and only the spinner inside it toggles — the
            height above the messages must never change while paginating. Scrolling
            back at speed pins the container at scrollTop 0, where scroll anchoring
            has nothing to compensate with, so mounting and unmounting this block
            moved the whole transcript by its own height ~12 times a second.
            The gap is therefore permanent above the topmost loaded message, which
            costs nothing: you only see it scrolled to the top of what's loaded,
            and that is the moment the next fetch fills it. */}
        {hasMore && (
          <div
            data-older-messages-loader
            className="flex h-12 items-center justify-center"
            style={{ overflowAnchor: 'none' }}
          >
            {isLoading && <Spinner size="sm" />}
          </div>
        )}

        {rows.length === 0 && !isLoading && (
          <div
            className="text-center text-muted-foreground py-12"
            style={{ overflowAnchor: 'none' }}
          >
            No messages yet. Start a conversation with Claude!
          </div>
        )}

        <MessageListProvider value={contextValue}>
          {rows.map((row, index) => {
            if (row.kind === 'taskbox') {
              // A relocated finished subagent box, at its finish position.
              const prev = rows[index - 1];
              const spacingClass = index === 0 ? '' : prev?.kind === 'taskbox' ? 'mt-1' : 'mt-4';
              return (
                <div
                  key={`taskbox-${row.toolUseId}`}
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
                key={message.id}
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

        <div ref={bottomRef} style={{ overflowAnchor: 'none' }} />
      </div>

      {/* Context usage indicator - positioned in bottom right */}
      <ContextUsageIndicator stats={tokenUsage} className="absolute bottom-3 right-3 shadow-xs" />
    </div>
  );
}

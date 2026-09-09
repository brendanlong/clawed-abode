'use client';

import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { MessageBubble } from './messages/MessageBubble';
import { SubagentTranscript } from './messages/SubagentTranscript';
import { TaskDisplay } from './messages/TaskDisplay';
import type { ToolCall, MessageContent, DisplayMessage } from './messages/types';
import { MessageListProvider } from './messages/MessageListContext';
import { Clock, PauseCircle } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { ContextUsageIndicator } from '@/components/ContextUsageIndicator';
import type { TokenUsageStats } from '@/lib/token-estimation';
import { useNotification } from '@/hooks/useNotification';
import { useVoicePlaybackContext } from '@/hooks/useVoicePlayback';
import {
  isToolCallOnlyMessage,
  isToolResultMessage,
  isVisibleTranscriptMessage,
  getParentToolUseId,
  groupSubagentMessages,
  computeSubagentPlacements,
  buildToolCallFromBlock,
  buildToolResultMap,
  collectSubagentLifecycles,
  getLatestTodoWriteId,
  getPendingAskUserQuestions,
  getPlanContentByToolUseId,
} from './messages/messageHelpers';

type Message = DisplayMessage;

interface MessageListProps {
  messages: Message[];
  isLoading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  tokenUsage?: TokenUsageStats | null;
  onSendResponse?: (response: string) => void;
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
   * otherwise pin forever). See {@link computeSubagentPlacements}.
   */
  isSessionRunning?: boolean;
}

export function MessageList({
  messages,
  isLoading,
  hasMore,
  onLoadMore,
  tokenUsage,
  onSendResponse,
  onAnswerQuestion,
  onRespondToPlan,
  pendingMessageIds = [],
  queuedMessageIds = [],
  isSessionRunning = false,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const hasInitialScrolled = useRef(false);

  // Voice playback state for playback-aware scrolling
  const { isPlaying: voiceIsPlaying, currentMessageId: voiceCurrentMessageId } =
    useVoicePlaybackContext();

  // Track which TodoWrite components have been manually toggled by the user
  const [manuallyToggledTodoIds, setManuallyToggledTodoIds] = useState<Set<string>>(new Set());

  // Track which AskUserQuestion IDs we've already notified about (using ref to avoid re-renders)
  const notifiedQuestionIdsRef = useRef<Set<string>>(new Set());

  // Notification hook for browser notifications
  const { showNotification } = useNotification();

  // Manual IntersectionObserver to detect when sentinel enters viewport
  // Uses the scroll container as root so rootMargin works relative to the container
  useEffect(() => {
    const container = containerRef.current;
    const sentinel = topSentinelRef.current;
    if (!container || !sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && hasMore && !isLoading && hasInitialScrolled.current) {
          onLoadMore();
        }
      },
      {
        root: container,
        rootMargin: '100% 0px 0px 0px',
        threshold: 0,
      }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoading, onLoadMore]);

  // Build the tool result map and determine which messages to hide
  const { resultMap, pairedMessageIds, resultSequenceByToolUseId } = useMemo(
    () => buildToolResultMap(messages),
    [messages]
  );

  // Group subagent messages (parent_tool_use_id set) by their Task's tool_use id
  // so they render nested inside that Task instead of cluttering the top level.
  const subagentMessagesByToolUseId = useMemo(() => groupSubagentMessages(messages), [messages]);

  // Index top-level subagent lifecycles (and their call blocks) so their boxes can
  // be relocated out of the spawn point (running → pinned; finished → finish point).
  const { lifecycles, agentBlockById } = useMemo(
    () =>
      collectSubagentLifecycles(messages, subagentMessagesByToolUseId, resultSequenceByToolUseId),
    [messages, subagentMessagesByToolUseId, resultSequenceByToolUseId]
  );

  const latestTodoWriteId = useMemo(() => getLatestTodoWriteId(messages), [messages]);

  // Reconstruct plan content per ExitPlanMode call (keyed by tool_use id)
  const planContentByToolUseId = useMemo(() => getPlanContentByToolUseId(messages), [messages]);

  // Find pending AskUserQuestion tool calls
  const pendingQuestions = useMemo(
    () => getPendingAskUserQuestions(messages, resultMap),
    [messages, resultMap]
  );

  // Show browser notification for new pending AskUserQuestions (only when tab is not visible)
  useEffect(() => {
    for (const question of pendingQuestions) {
      if (!notifiedQuestionIdsRef.current.has(question.id)) {
        // Mark as notified (mutating ref doesn't cause re-render)
        notifiedQuestionIdsRef.current.add(question.id);

        // Only show notification if the page is not visible (user is on different tab/window minimized)
        if (document.hidden) {
          showNotification(`Claude: ${question.header}`, {
            body: question.question,
            tag: `ask-user-question-${question.id}`, // Prevents duplicate notifications
            requireInteraction: true, // Keep notification visible until user interacts
          });
        }
      }
    }
  }, [pendingQuestions, showNotification]);

  // Callback for when a TodoWrite is manually toggled
  const handleTodoManualToggle = useCallback((toolId: string) => {
    setManuallyToggledTodoIds((prev) => new Set([...prev, toolId]));
  }, []);

  // Filter the top-level transcript down to what should render as its own row:
  // the shared transcript-visibility predicate, plus the top-level-only rule that
  // subagent messages render nested inside their Task rather than here.
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (msg) =>
          getParentToolUseId(msg.content) === null &&
          isVisibleTranscriptMessage(msg, pairedMessageIds)
      ),
    [messages, pairedMessageIds]
  );

  // Decide which subagent boxes to relocate, and where. Interleaving is measured
  // against the top-level rows that actually render (visibleMessages), so a plain
  // foreground wait (subagent with no rows between spawn and finish) stays inline.
  const placements = useMemo(
    () =>
      computeSubagentPlacements(
        lifecycles,
        visibleMessages.map((m) => m.sequence),
        isSessionRunning
      ),
    [lifecycles, visibleMessages, isSessionRunning]
  );

  // Merge the top-level message rows with relocated finished-subagent boxes,
  // ordered by sequence so each box lands at its finish position. Running boxes
  // are rendered separately, pinned at the bottom.
  const renderRows = useMemo(() => {
    type RenderRow =
      | { kind: 'message'; sequence: number; message: Message }
      | { kind: 'taskbox'; sequence: number; toolUseId: string; tool: ToolCall };
    const rows: RenderRow[] = visibleMessages.map((message) => ({
      kind: 'message',
      sequence: message.sequence,
      message,
    }));
    for (const { toolUseId, atSequence } of placements.finished) {
      const block = agentBlockById.get(toolUseId);
      if (!block) continue;
      rows.push({
        kind: 'taskbox',
        sequence: atSequence,
        toolUseId,
        tool: buildToolCallFromBlock(block, resultMap),
      });
    }
    rows.sort((a, b) => a.sequence - b.sequence);
    return rows;
  }, [visibleMessages, placements.finished, agentBlockById, resultMap]);

  const scrollToBottom = useCallback(() => {
    // Always use instant scroll to avoid race conditions with smooth animation.
    // Smooth scroll can cause auto-scroll to break: if messages arrive faster than
    // the animation completes, the IntersectionObserver sees the sentinel as
    // not-intersecting mid-animation, isAtBottomRef becomes false, and subsequent
    // messages don't trigger auto-scroll.
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, []);

  // Initial scroll to bottom
  useEffect(() => {
    if (!hasInitialScrolled.current && messages.length > 0) {
      hasInitialScrolled.current = true;
      // Use requestAnimationFrame to ensure DOM has rendered
      requestAnimationFrame(() => {
        scrollToBottom();
      });
    }
  }, [messages, scrollToBottom]);

  // Auto-scroll to bottom when new messages arrive, if user was at bottom.
  // Suppressed when voice playback is actively reading a specific message —
  // in that case, playback-tracking scroll (below) handles positioning instead.
  useEffect(() => {
    const voiceIsTrackingMessage = voiceIsPlaying && voiceCurrentMessageId;
    if (hasInitialScrolled.current && isAtBottomRef.current && !voiceIsTrackingMessage) {
      scrollToBottom();
    }
  }, [messages, scrollToBottom, voiceIsPlaying, voiceCurrentMessageId]);

  // Track if user is at bottom using IntersectionObserver (for auto-scroll on new messages)
  // This is more reliable than scroll-position math because layout changes (textarea resize,
  // tool call expansion) change scrollHeight without firing scroll events.
  useEffect(() => {
    const container = containerRef.current;
    const bottom = bottomRef.current;
    if (!container || !bottom) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) {
          isAtBottomRef.current = entry.isIntersecting;
        }
      },
      {
        root: container,
        rootMargin: '0px 0px 150px 0px',
        threshold: 0,
      }
    );

    observer.observe(bottom);
    return () => observer.disconnect();
  }, []);

  // Re-scroll to bottom when the scroll container shrinks (e.g., VoiceControlPanel
  // appearing/disappearing changes the flex layout). Without this, the container
  // shrinks, the bottom sentinel exits the viewport, isAtBottomRef becomes false,
  // and auto-scroll stops working even though the user was at the bottom.
  //
  // We can't rely on isAtBottomRef here because the IntersectionObserver may have
  // already set it to false by the time the ResizeObserver fires. Instead, we track
  // the previous container height and compute whether the user was at the bottom
  // before the resize by comparing the distance-from-bottom to the height lost.
  const prevContainerHeightRef = useRef(0);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    prevContainerHeightRef.current = container.clientHeight;

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;

      const newHeight = entry.contentRect.height;
      const prevHeight = prevContainerHeightRef.current;
      prevContainerHeightRef.current = newHeight;

      // Only act when the container shrinks (e.g., taller input panel appeared)
      if (prevHeight > 0 && newHeight < prevHeight) {
        const heightLost = prevHeight - newHeight;
        const { scrollTop, scrollHeight, clientHeight } = container;
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

        // If distance from bottom ≈ the height lost, the user was at the bottom
        // before the resize. Re-scroll to bottom to maintain their position.
        if (distanceFromBottom <= heightLost + 50) {
          scrollToBottom();
        }
      }
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [scrollToBottom]);

  // Playback-tracking scroll: when voice playback advances to a new message,
  // scroll to keep that message visible (centered in view).
  // Only triggers when voiceCurrentMessageId changes (not on play/pause toggles).
  const prevVoiceMessageIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prevId = prevVoiceMessageIdRef.current;
    prevVoiceMessageIdRef.current = voiceCurrentMessageId;

    // Only scroll when the message ID changes to a new truthy value while playing.
    // Don't scroll on pause/resume (same ID) or when playback stops (null ID).
    if (!voiceIsPlaying || !voiceCurrentMessageId || voiceCurrentMessageId === prevId) return;

    const messageEl = containerRef.current?.querySelector(
      `[data-message-id="${voiceCurrentMessageId}"]`
    );
    // Instant scroll to avoid race conditions (same reason as scrollToBottom).
    messageEl?.scrollIntoView({ behavior: 'instant', block: 'center' });
  }, [voiceIsPlaying, voiceCurrentMessageId]);

  // When playback stops, transition back to normal auto-scroll behavior.
  // If the user is near the bottom, do a final scroll to bottom.
  const prevVoiceIsPlayingRef = useRef(false);
  useEffect(() => {
    const wasPlaying = prevVoiceIsPlayingRef.current;
    prevVoiceIsPlayingRef.current = voiceIsPlaying;

    // Playback just stopped: if the user is near the bottom, snap back to normal auto-scroll
    if (wasPlaying && !voiceIsPlaying && isAtBottomRef.current) {
      scrollToBottom();
    }
  }, [voiceIsPlaying, scrollToBottom]);

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
      manuallyToggledTodoIds,
      onTodoManualToggle: handleTodoManualToggle,
      onSendResponse,
      onAnswerQuestion,
      onRespondToPlan,
      planContentByToolUseId,
      renderSubagentTranscript,
      relocatedSubagentIds: placements.relocatedIds,
    }),
    [
      latestTodoWriteId,
      manuallyToggledTodoIds,
      handleTodoManualToggle,
      onSendResponse,
      onAnswerQuestion,
      onRespondToPlan,
      planContentByToolUseId,
      renderSubagentTranscript,
      placements.relocatedIds,
    ]
  );

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={containerRef} className="h-full overflow-y-auto p-4">
        {/* Sentinel for triggering infinite scroll - placed before messages */}
        {/* overflow-anchor:none prevents browser from anchoring to these elements */}
        {/* so when new messages load above, the view stays on current messages */}
        <div ref={topSentinelRef} className="h-1" style={{ overflowAnchor: 'none' }} />

        {hasMore && isLoading && (
          <div className="text-center py-2 mb-4" style={{ overflowAnchor: 'none' }}>
            <Spinner size="sm" className="mx-auto" />
          </div>
        )}

        {visibleMessages.length === 0 && !isLoading && (
          <div
            className="text-center text-muted-foreground py-12"
            style={{ overflowAnchor: 'none' }}
          >
            No messages yet. Start a conversation with Claude!
          </div>
        )}

        <MessageListProvider value={contextValue}>
          {renderRows.map((row, index) => {
            if (row.kind === 'taskbox') {
              // A relocated finished subagent box, at its finish position.
              const prev = renderRows[index - 1];
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
            // Only right-align actual user messages, not tool results
            const isUserMessage =
              message.type === 'user' && !isToolResultMessage(message.content as MessageContent);

            // Spacing: full gap between messages, but tight when two consecutive
            // tool-call-only messages sit back-to-back (issue #312). The first
            // message gets no top margin (the container padding handles it).
            const prev = renderRows[index - 1];
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
          {placements.running.length > 0 && (
            <div className="mt-4 border-t border-dashed pt-3" data-pinned-subagents>
              <div className="text-muted-foreground text-xs mb-2">
                Running subagent{placements.running.length > 1 ? 's' : ''}
              </div>
              <div className="space-y-2">
                {placements.running.map((toolUseId) => {
                  const block = agentBlockById.get(toolUseId);
                  if (!block) return null;
                  return (
                    <div key={`pinned-${toolUseId}`} className="flex justify-start">
                      <TaskDisplay
                        tool={buildToolCallFromBlock(block, resultMap)}
                        isPendingOverride
                      />
                    </div>
                  );
                })}
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

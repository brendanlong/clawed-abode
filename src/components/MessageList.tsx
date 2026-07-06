'use client';

import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { MessageBubble } from './messages/MessageBubble';
import { SubagentTranscript } from './messages/SubagentTranscript';
import type { ToolResultMap, ContentBlock, MessageContent, DisplayMessage } from './messages/types';
import { MessageListProvider } from './messages/MessageListContext';
import { Spinner } from '@/components/ui/spinner';
import { ContextUsageIndicator } from '@/components/ContextUsageIndicator';
import { QueuedMessageList } from '@/components/QueuedMessageList';
import type { QueuedMessage } from '@/lib/queued-message';
import type { TokenUsageStats } from '@/lib/token-estimation';
import { useNotification } from '@/hooks/useNotification';
import { useVoicePlaybackContext } from '@/hooks/useVoicePlayback';
import { isPlanFile, reconstructPlansByToolUseId, type PlanEvent } from './messages/plan-utils';
import {
  isToolCallOnlyMessage,
  isToolResultMessage,
  isVisibleTranscriptMessage,
  getParentToolUseId,
  groupSubagentMessages,
} from './messages/messageHelpers';

type Message = DisplayMessage;

// Extract tool_use IDs from an assistant message
function getToolUseIds(message: Message): string[] {
  const content = message.content as MessageContent | undefined;
  const blocks = content?.message?.content;
  if (!Array.isArray(blocks)) return [];
  return blocks.filter((b) => b.type === 'tool_use' && b.id).map((b) => b.id!);
}

// Extract tool_result blocks from a tool result message
function getToolResultBlocks(message: Message): ContentBlock[] {
  const content = message.content as MessageContent | undefined;
  const blocks = content?.message?.content;
  if (!Array.isArray(blocks)) return [];
  return blocks.filter((b) => b.type === 'tool_result');
}

// Build a map of tool_use_id -> tool_result content, and track which messages are fully paired
function buildToolResultMap(messages: Message[]): {
  resultMap: ToolResultMap;
  pairedMessageIds: Set<string>;
} {
  const resultMap: ToolResultMap = new Map();
  const pairedMessageIds = new Set<string>();

  // First pass: collect all tool_use IDs from assistant messages
  const toolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.type === 'assistant') {
      for (const id of getToolUseIds(msg)) {
        toolUseIds.add(id);
      }
    }
  }

  // Second pass: map tool results to their tool_use IDs
  for (const msg of messages) {
    if (msg.type === 'user' && isToolResultMessage(msg.content as MessageContent)) {
      const resultBlocks = getToolResultBlocks(msg);
      let allPaired = true;

      for (const block of resultBlocks) {
        if (block.tool_use_id && toolUseIds.has(block.tool_use_id)) {
          resultMap.set(block.tool_use_id, {
            content: typeof block.content === 'string' ? block.content : undefined,
            is_error: block.is_error,
          });
        } else {
          // This result doesn't have a matching tool_use
          allPaired = false;
        }
      }

      // Only mark message as paired if ALL its results were paired
      if (allPaired && resultBlocks.length > 0) {
        pairedMessageIds.add(msg.id);
      }
    }
  }

  return { resultMap, pairedMessageIds };
}

// Extract TodoWrite tool call IDs from messages, ordered by sequence
function getTodoWriteIds(messages: Message[]): string[] {
  const ids: string[] = [];
  // Sort by sequence to ensure correct ordering
  const sortedMessages = [...messages].sort((a, b) => a.sequence - b.sequence);
  for (const msg of sortedMessages) {
    if (msg.type === 'assistant') {
      const content = msg.content as MessageContent | undefined;
      const blocks = content?.message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.name === 'TodoWrite' && block.id) {
            ids.push(block.id);
          }
        }
      }
    }
  }
  return ids;
}

interface AskUserQuestionInfo {
  id: string;
  header: string;
  question: string;
}

// Extract pending AskUserQuestion tool calls (those without a result yet)
function getPendingAskUserQuestions(
  messages: Message[],
  resultMap: ToolResultMap
): AskUserQuestionInfo[] {
  const pending: AskUserQuestionInfo[] = [];
  const sortedMessages = [...messages].sort((a, b) => a.sequence - b.sequence);

  for (const msg of sortedMessages) {
    if (msg.type === 'assistant') {
      const content = msg.content as MessageContent | undefined;
      const blocks = content?.message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (
            block.type === 'tool_use' &&
            block.name === 'AskUserQuestion' &&
            block.id &&
            !resultMap.has(block.id) // No result yet = pending
          ) {
            const input = block.input as
              | {
                  questions?: Array<{ header?: string; question?: string }>;
                }
              | undefined;
            const firstQuestion = input?.questions?.[0];
            pending.push({
              id: block.id,
              header: firstQuestion?.header || 'Question',
              question: firstQuestion?.question || 'Claude needs your input',
            });
          }
        }
      }
    }
  }
  return pending;
}

/**
 * Extract plan Write/Edit tool calls and ExitPlanMode calls from the messages,
 * then reconstruct the plan content for each ExitPlanMode (keyed by its tool_use
 * id). Handles multiple plans per session — see {@link reconstructPlansByToolUseId}.
 */
function getPlanContentByToolUseId(messages: Message[]): Map<string, string> {
  const events: PlanEvent[] = [];

  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    const content = msg.content as MessageContent | undefined;
    const blocks = content?.message?.content;
    if (!Array.isArray(blocks)) continue;

    for (const block of blocks) {
      if (block.type !== 'tool_use') continue;

      if (block.name === 'ExitPlanMode' && block.id) {
        events.push({ kind: 'exit', sequence: msg.sequence, toolUseId: block.id });
        continue;
      }

      if (!block.input) continue;
      const input = block.input as Record<string, unknown>;
      const filePath = input.file_path as string | undefined;
      if (!filePath || !isPlanFile(filePath)) continue;

      if (block.name === 'Write') {
        events.push({
          kind: 'write',
          sequence: msg.sequence,
          filePath,
          content: (input.content as string) ?? '',
        });
      } else if (block.name === 'Edit') {
        events.push({
          kind: 'edit',
          sequence: msg.sequence,
          filePath,
          oldString: (input.old_string as string) ?? '',
          newString: (input.new_string as string) ?? '',
        });
      }
    }
  }

  return reconstructPlansByToolUseId(events);
}

// Total cost is now provided by tokenUsage.totalCostUsd from the server-side
// estimateTokenUsage function, which uses the authoritative total_cost_usd
// from result messages per Anthropic's cost tracking docs.

interface MessageListProps {
  messages: Message[];
  isLoading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  tokenUsage?: TokenUsageStats | null;
  onSendResponse?: (response: string) => void;
  onAnswerQuestion?: (toolUseId: string, answers: Record<string, string>) => void;
  onRespondToPlan?: (toolUseId: string, approve: boolean, feedback?: string) => void;
  /** Server-owned queued messages, pinned below the transcript (async "btw mode"). */
  queuedMessages?: QueuedMessage[];
  onCancelQueued?: (id: string) => void;
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
  queuedMessages = [],
  onCancelQueued,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const hasInitialScrolled = useRef(false);

  // Voice playback state for playback-aware scrolling
  const { isPlaying: voiceIsPlaying, currentMessageId: voiceCurrentMessageId } =
    useVoicePlaybackContext();

  // Whether the user has manually scrolled away from the currently-playing message.
  // Reset each time playback advances to a new message (giving user a fresh chance to follow).
  const userScrolledAwayFromPlaybackRef = useRef(false);

  // Flag to distinguish programmatic scrolls (our scrollIntoView) from user-initiated scrolls.
  // Set to true before scrollIntoView, cleared after a short timeout.
  const programmaticScrollRef = useRef(false);

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
  const { resultMap, pairedMessageIds } = useMemo(() => buildToolResultMap(messages), [messages]);

  // Group subagent messages (parent_tool_use_id set) by their Task's tool_use id
  // so they render nested inside that Task instead of cluttering the top level.
  const subagentMessagesByToolUseId = useMemo(() => groupSubagentMessages(messages), [messages]);

  // Find the latest TodoWrite ID (last one by sequence)
  const latestTodoWriteId = useMemo(() => {
    const todoIds = getTodoWriteIds(messages);
    return todoIds.length > 0 ? todoIds[todoIds.length - 1] : null;
  }, [messages]);

  // Total cost comes from tokenUsage (server-computed from authoritative result messages)

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
    // queuedMessages.length so queuing a message scrolls it into view too.
  }, [messages, queuedMessages.length, scrollToBottom, voiceIsPlaying, voiceCurrentMessageId]);

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

    // New message started playing — reset the "user scrolled away" flag
    // so user gets a fresh chance to follow along.
    userScrolledAwayFromPlaybackRef.current = false;

    const container = containerRef.current;
    if (!container) return;

    const messageEl = container.querySelector(`[data-message-id="${voiceCurrentMessageId}"]`);
    if (!messageEl) return;

    // Mark this scroll as programmatic so the scroll listener ignores it.
    // Use instant scroll to avoid race conditions (same reason as scrollToBottom).
    programmaticScrollRef.current = true;
    messageEl.scrollIntoView({ behavior: 'instant', block: 'center' });
    programmaticScrollRef.current = false;
  }, [voiceIsPlaying, voiceCurrentMessageId]);

  // Detect user-initiated scrolls during playback.
  // If the user scrolls while voice is playing, set userScrolledAwayFromPlaybackRef
  // so we stop chasing the playing message (don't fight the user).
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !voiceIsPlaying) return;

    const handleScroll = () => {
      if (programmaticScrollRef.current) return; // Ignore our own scrollIntoView
      userScrolledAwayFromPlaybackRef.current = true;
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [voiceIsPlaying]);

  // When playback stops, transition back to normal auto-scroll behavior.
  // If the user is near the bottom, do a final scroll to bottom.
  const prevVoiceIsPlayingRef = useRef(false);
  useEffect(() => {
    const wasPlaying = prevVoiceIsPlayingRef.current;
    prevVoiceIsPlayingRef.current = voiceIsPlaying;

    if (wasPlaying && !voiceIsPlaying) {
      // Playback just stopped — reset the flag
      userScrolledAwayFromPlaybackRef.current = false;

      // If user is near the bottom, snap to bottom for normal behavior
      if (isAtBottomRef.current) {
        scrollToBottom();
      }
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
          {visibleMessages.map((message, index) => {
            // Only right-align actual user messages, not tool results
            const isUserMessage =
              message.type === 'user' && !isToolResultMessage(message.content as MessageContent);

            // Spacing: full gap between messages, but tight when two consecutive
            // tool-call-only messages sit back-to-back (issue #312). The first
            // message gets no top margin (the container padding handles it).
            const prev = visibleMessages[index - 1];
            const backToBackToolCalls =
              prev !== undefined &&
              isToolCallOnlyMessage(prev.content as MessageContent) &&
              isToolCallOnlyMessage(message.content as MessageContent);
            const spacingClass = index === 0 ? '' : backToBackToolCalls ? 'mt-1' : 'mt-4';

            return (
              <div
                key={message.id}
                data-message-id={message.id}
                className={cn(
                  'flex',
                  isUserMessage ? 'justify-end' : 'justify-start',
                  spacingClass
                )}
              >
                <MessageBubble
                  message={{
                    id: message.id,
                    type: message.type,
                    content: message.content,
                  }}
                  toolResults={resultMap}
                />
              </div>
            );
          })}
        </MessageListProvider>

        {onCancelQueued && (
          <QueuedMessageList messages={queuedMessages} onCancel={onCancelQueued} />
        )}

        <div ref={bottomRef} style={{ overflowAnchor: 'none' }} />
      </div>

      {/* Context usage indicator - positioned in bottom right */}
      <ContextUsageIndicator
        stats={tokenUsage}
        totalCostUsd={tokenUsage?.totalCostUsd}
        className="absolute bottom-3 right-3 shadow-xs"
      />
    </div>
  );
}

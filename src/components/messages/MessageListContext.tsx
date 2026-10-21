'use client';

import { createContext, useContext, type ReactNode } from 'react';

/** What the message list offers its cards that stays the same while the transcript changes. */
export interface MessageListActions {
  /** The session whose transcript this is, for fetching elided tool-result bodies. */
  sessionId: string;
  /** Fetch (or read from cache) the full text of a result the server elided. */
  loadToolResultText: (messageId: string, toolUseId: string) => Promise<string>;
  /** Answer an AskUserQuestion tool call */
  onAnswerQuestion?: (toolUseId: string, answers: Record<string, string>) => void;
  /** Respond to an ExitPlanMode tool call (approve or request changes) */
  onRespondToPlan?: (toolUseId: string, approve: boolean, feedback?: string) => void;
}

/** What cards read about the rest of the transcript; a new value on every update. */
export interface MessageListTranscript {
  /** The tool ID of the latest TodoWrite call (by sequence), or null */
  latestTodoWriteId: string | null;
  /** Reconstructed plan content per ExitPlanMode call, keyed by its tool_use id */
  planContentByToolUseId: Map<string, string>;
  /**
   * Render the nested transcript of a subagent Task, keyed by the Task's
   * tool_use id, or null if that Task spawned no visible subagent messages.
   * Provided by MessageList so TaskDisplay can show grouped subagent work
   * without importing MessageBubble (which would create an import cycle).
   */
  renderSubagentTranscript: (toolUseId: string) => ReactNode;
  /**
   * Render the messages a refusal fallback retracted, keyed by the fallback
   * message's id, or null if none are loaded. A callback for the same
   * import-cycle reason as renderSubagentTranscript.
   */
  renderRetractedMessages: (fallbackMessageId: string) => ReactNode;
  /** Tool_use ids of subagents whose box MessageList renders somewhere else. */
  relocatedSubagentIds: Set<string>;
}

const MessageListActionsContext = createContext<MessageListActions | null>(null);
const MessageListTranscriptContext = createContext<MessageListTranscript | null>(null);

/**
 * Two contexts, because every component reading a context re-renders when its
 * value changes: the transcript one changes on every update, so only the cards
 * that show transcript-wide data read it, and message bubbles never do (see
 * `messageBubblePropsEqual`).
 */
export function MessageListProvider({
  children,
  actions,
  transcript,
}: {
  children: ReactNode;
  /** Keep referentially stable (memoize it). */
  actions: MessageListActions;
  transcript: MessageListTranscript;
}) {
  return (
    <MessageListActionsContext.Provider value={actions}>
      <MessageListTranscriptContext.Provider value={transcript}>
        {children}
      </MessageListTranscriptContext.Provider>
    </MessageListActionsContext.Provider>
  );
}

/** Stable across transcript updates. */
export function useMessageListActions(): MessageListActions | null {
  return useContext(MessageListActionsContext);
}

/** Re-renders the caller on every transcript update; read it only in the card that needs it. */
export function useMessageListTranscript(): MessageListTranscript | null {
  return useContext(MessageListTranscriptContext);
}

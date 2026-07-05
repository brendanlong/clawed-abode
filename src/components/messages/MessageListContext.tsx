'use client';

import { createContext, useContext, type ReactNode } from 'react';

interface MessageListContextValue {
  /** The tool ID of the latest TodoWrite call (by sequence), or null */
  latestTodoWriteId: string | null;
  /** Set of TodoWrite tool IDs that the user has manually toggled */
  manuallyToggledTodoIds: Set<string>;
  /** Callback when a TodoWrite is manually toggled by the user */
  onTodoManualToggle: (toolId: string) => void;
  /** Callback to send a response to Claude (for AskUserQuestion) */
  onSendResponse?: (response: string) => void;
  /** Answer an AskUserQuestion tool call (preferred over onSendResponse) */
  onAnswerQuestion?: (toolUseId: string, answers: Record<string, string>) => void;
  /** Respond to an ExitPlanMode tool call (approve or request changes) */
  onRespondToPlan?: (toolUseId: string, approve: boolean, feedback?: string) => void;
  /** Reconstructed plan content per ExitPlanMode call, keyed by its tool_use id */
  planContentByToolUseId: Map<string, string>;
  /**
   * Render the nested transcript of a subagent Task, keyed by the Task's
   * tool_use id, or null if that Task spawned no visible subagent messages.
   * Provided by MessageList so TaskDisplay can show grouped subagent work
   * without importing MessageBubble (which would create an import cycle).
   */
  renderSubagentTranscript: (toolUseId: string) => ReactNode;
}

const MessageListContext = createContext<MessageListContextValue | null>(null);

export function MessageListProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: MessageListContextValue;
}) {
  return <MessageListContext.Provider value={value}>{children}</MessageListContext.Provider>;
}

export function useMessageListContext(): MessageListContextValue | null {
  return useContext(MessageListContext);
}

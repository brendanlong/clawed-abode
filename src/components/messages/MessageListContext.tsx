'use client';

import { createContext, useContext } from 'react';

export interface SubagentMessage {
  id: string;
  type: 'assistant' | 'user' | 'system' | 'result';
  content: unknown;
  sequence: number;
}

interface MessageListContextValue {
  /** The tool ID of the latest TodoWrite call (by sequence), or null */
  latestTodoWriteId: string | null;
  /** Set of TodoWrite tool IDs that the user has manually toggled */
  manuallyToggledTodoIds: Set<string>;
  /** Callback when a TodoWrite is manually toggled by the user */
  onTodoManualToggle: (toolId: string) => void;
  /** Callback to send a response to Claude (for AskUserQuestion) */
  onSendResponse?: (response: string) => void;
  /** Callback to answer an AskUserQuestion via canUseTool (preferred over onSendResponse) */
  onAnswerQuestion?: (answers: Record<string, string>) => void;
  /** Whether Claude is currently running (disables AskUserQuestion interactions) */
  isClaudeRunning?: boolean;
  /** The latest plan content from Write/Edit of plan files, or null */
  latestPlanContent: string | null;
  /** Map of task tool_use_id -> subagent messages belonging to that task */
  subagentMessagesByTaskId: Map<string, SubagentMessage[]>;
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

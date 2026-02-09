'use client';

import { createContext, useContext } from 'react';

interface MessageListContextValue {
  /** The tool ID of the latest TodoWrite call (by sequence), or null */
  latestTodoWriteId: string | null;
  /** Set of TodoWrite tool IDs that the user has manually toggled */
  manuallyToggledTodoIds: Set<string>;
  /** Callback when a TodoWrite is manually toggled by the user */
  onTodoManualToggle: (toolId: string) => void;
  /** Callback to send a response to Claude (for AskUserQuestion) */
  onSendResponse?: (response: string) => void;
  /** Whether Claude is currently running (disables AskUserQuestion interactions) */
  isClaudeRunning?: boolean;
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

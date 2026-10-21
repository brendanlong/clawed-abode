import type { ReactNode } from 'react';
import {
  MessageListProvider,
  type MessageListActions,
  type MessageListTranscript,
} from '@/components/messages/MessageListContext';

/** A `MessageListProvider` with inert defaults, for rendering cards outside a `MessageList`. */
export function TestMessageListProvider({
  children,
  actions,
  transcript,
}: {
  children: ReactNode;
  actions?: Partial<MessageListActions>;
  transcript?: Partial<MessageListTranscript>;
}) {
  return (
    <MessageListProvider
      actions={{
        sessionId: 'session-1',
        loadToolResultText: () => Promise.reject(new Error('unexpected fetch')),
        ...actions,
      }}
      transcript={{
        latestTodoWriteId: null,
        planContentByToolUseId: new Map(),
        renderSubagentTranscript: () => null,
        renderRetractedMessages: () => null,
        relocatedSubagentIds: new Set(),
        ...transcript,
      }}
    >
      {children}
    </MessageListProvider>
  );
}

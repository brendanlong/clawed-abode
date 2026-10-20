'use client';

import { useMemo } from 'react';
import { MessageBubble } from './MessageBubble';
import { isOwnPromptMessage } from './messageHelpers';
import { isTranscriptRow } from '@/lib/transcript-display';
import type { DisplayMessage, ToolResultMap } from './types';

/**
 * A transcript rendered inside another message — a subagent's work under its
 * Task, or a retracted attempt under its refusal-fallback banner. Uses the same
 * classifier as the top-level list so tool results and hidden system messages
 * don't clutter it. Returns null when nothing is left to show,
 * so the parent never renders an empty section.
 */
export function NestedTranscript({
  messages,
  toolResults,
}: {
  messages: DisplayMessage[];
  /** Tool results map so nested tool calls render their output inline. */
  toolResults: ToolResultMap;
}) {
  const visibleMessages = useMemo(
    () => messages.filter((msg) => isTranscriptRow(msg.type, msg.content)),
    [messages]
  );

  if (visibleMessages.length === 0) return null;

  return (
    <div className="space-y-2 border-l-2 border-muted pl-3">
      {visibleMessages.map((message) => {
        const isUserMessage = isOwnPromptMessage(message);
        return (
          <div
            key={message.id}
            data-message-id={message.id}
            className={`flex ${isUserMessage ? 'justify-end' : 'justify-start'}`}
          >
            <MessageBubble
              message={{ id: message.id, type: message.type, content: message.content }}
              toolResults={toolResults}
            />
          </div>
        );
      })}
    </div>
  );
}

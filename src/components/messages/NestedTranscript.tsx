'use client';

import { useMemo } from 'react';
import { MessageBubble } from './MessageBubble';
import { isOwnPromptMessage, isVisibleTranscriptMessage } from './messageHelpers';
import type { DisplayMessage, ToolResultMap } from './types';

/**
 * A transcript rendered inside another message — a subagent's work under its
 * Task, or a retracted attempt under its refusal-fallback banner. Uses the same
 * visibility predicate as the top-level list so paired tool results and hidden
 * system messages don't clutter it. Returns null when nothing is left to show,
 * so the parent never renders an empty section.
 */
export function NestedTranscript({
  messages,
  toolResults,
  pairedMessageIds,
}: {
  messages: DisplayMessage[];
  /** Tool results map so nested tool calls render their output inline. */
  toolResults: ToolResultMap;
  /** Message ids whose tool_result blocks are all paired (shown inline instead). */
  pairedMessageIds: Set<string>;
}) {
  const visibleMessages = useMemo(
    () => messages.filter((msg) => isVisibleTranscriptMessage(msg, pairedMessageIds)),
    [messages, pairedMessageIds]
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

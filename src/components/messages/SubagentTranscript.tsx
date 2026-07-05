'use client';

import { useMemo } from 'react';
import { MessageBubble } from './MessageBubble';
import { isToolResultMessage, isVisibleTranscriptMessage } from './messageHelpers';
import type { DisplayMessage, MessageContent, ToolResultMap } from './types';

interface SubagentTranscriptProps {
  /** All messages spawned by a single Task (same parent_tool_use_id). */
  messages: DisplayMessage[];
  /** Tool results map so subagent tool calls render their output inline. */
  toolResults: ToolResultMap;
  /** Message ids whose tool_result blocks are all paired (shown inline instead). */
  pairedMessageIds: Set<string>;
}

/**
 * Renders the inner transcript of a subagent (Task) — its own assistant text,
 * tool calls, and results — nested inside the parent Task display. Uses the same
 * visibility predicate as the top-level list so paired tool results and hidden
 * system messages don't clutter the expanded view. Returns null (heading and all)
 * when nothing is left to show, so the parent never renders an empty section.
 */
export function SubagentTranscript({
  messages,
  toolResults,
  pairedMessageIds,
}: SubagentTranscriptProps) {
  const visibleMessages = useMemo(
    () =>
      [...messages]
        .sort((a, b) => a.sequence - b.sequence)
        .filter((msg) => isVisibleTranscriptMessage(msg, pairedMessageIds)),
    [messages, pairedMessageIds]
  );

  if (visibleMessages.length === 0) return null;

  return (
    <div>
      <div className="text-muted-foreground mb-1">Subagent activity:</div>
      <div className="space-y-2 border-l-2 border-muted pl-3">
        {visibleMessages.map((message) => {
          const isUserMessage =
            message.type === 'user' && !isToolResultMessage(message.content as MessageContent);
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
    </div>
  );
}

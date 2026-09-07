/**
 * Which assistant messages have text worth speaking aloud. Shared by the voice
 * panel's prev/next navigation and the auto-read queue; both parse messages
 * through `messageHelpers` so there is exactly one message parser on the client.
 */

import { isPartialMessageId } from '@/lib/message-cache';
import { extractTextContent, isToolResultMessage } from '@/components/messages/messageHelpers';
import type { DisplayMessage, MessageContent } from '@/components/messages/types';

/** An assistant message with meaningful text content, ready for TTS. */
export interface PlayableMessage {
  id: string;
  text: string;
}

function asContent(msg: DisplayMessage): MessageContent {
  return (msg.content ?? {}) as MessageContent;
}

/**
 * The concatenated text blocks of an assistant message, or null when there is
 * nothing to speak (tool-only, whitespace-only, or malformed content).
 */
export function extractAssistantText(msg: DisplayMessage): string | null {
  const text = extractTextContent(asContent(msg));
  return text && text.trim() ? text : null;
}

/** Every complete (non-partial) assistant message with speakable text, in order. */
export function getAssistantTextMessages(messages: DisplayMessage[]): PlayableMessage[] {
  const results: PlayableMessage[] = [];
  for (const msg of messages) {
    if (msg.type !== 'assistant' || isPartialMessageId(msg.id)) continue;
    const text = extractAssistantText(msg);
    if (text !== null) results.push({ id: msg.id, text });
  }
  return results;
}

/**
 * Speakable assistant messages from the current turn (after the last user-sent
 * prompt; tool results are also `user` messages but don't start a turn) that
 * haven't been queued yet. Called repeatedly while a turn streams so playback
 * starts as messages arrive rather than at turn end.
 */
export function getNewAutoReadMessages(
  messages: DisplayMessage[],
  queuedIds: ReadonlySet<string>
): PlayableMessage[] {
  let turnStartIndex = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'user' && !isToolResultMessage(asContent(msg))) {
      turnStartIndex = i + 1;
      break;
    }
  }
  return getAssistantTextMessages(messages.slice(turnStartIndex)).filter(
    (m) => !queuedIds.has(m.id)
  );
}

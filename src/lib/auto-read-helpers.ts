/**
 * Pure helper functions for auto-read voice feature.
 * Extracts the first and last assistant text messages from a turn
 * for sequential playback when Claude finishes responding.
 */

/** Minimal message shape needed for auto-read logic */
export interface AutoReadMessage {
  id: string;
  type: string;
  content: unknown;
  sequence: number;
}

/** A message identified as having meaningful text content for TTS */
export interface TextMessageForPlayback {
  id: string;
  text: string;
}

/**
 * Extract text content from an assistant message.
 * Returns the concatenated text blocks, or null if no meaningful text exists.
 *
 * Message structure: { content: { message: { content: [{ type: 'text', text: '...' }, ...] } } }
 */
export function extractAssistantText(msg: AutoReadMessage): string | null {
  const content = msg.content as Record<string, unknown> | undefined;
  const innerMsg = content?.message as Record<string, unknown> | undefined;
  const blocks = innerMsg?.content;
  if (!Array.isArray(blocks)) return null;

  const textParts = blocks
    .filter((b: Record<string, unknown>) => b.type === 'text' && typeof b.text === 'string')
    .map((b: Record<string, unknown>) => b.text as string);

  const fullText = textParts.join('\n');
  return fullText.trim() ? fullText : null;
}

/**
 * Given all messages in a session, find the messages from the current turn
 * (messages after the last user-sent prompt) and return the first and last
 * assistant messages that have meaningful text content.
 *
 * Filters out:
 * - Non-assistant messages
 * - Partial messages (id starts with "partial-")
 * - Messages with no text content (tool-use-only messages)
 *
 * Returns an array of 0, 1, or 2 TextMessageForPlayback items:
 * - [] if no text messages found
 * - [msg] if only one text message (or first === last)
 * - [first, last] if multiple text messages exist
 */
export function getAutoReadMessages(messages: AutoReadMessage[]): TextMessageForPlayback[] {
  // Find the last user-sent prompt to identify the turn boundary.
  // User-sent prompts have type 'user' but we need to skip tool_result messages
  // which also have type 'user'. Tool results have content.message.content
  // with blocks of type 'tool_result'.
  let turnStartIndex = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'user' && !isToolResultMessage(msg)) {
      turnStartIndex = i + 1;
      break;
    }
  }

  // Filter to assistant messages with meaningful text content from the current turn
  const textMessages: TextMessageForPlayback[] = [];
  for (let i = turnStartIndex; i < messages.length; i++) {
    const msg = messages[i];

    // Skip non-assistant messages
    if (msg.type !== 'assistant') continue;

    // Skip partial messages
    if (msg.id.startsWith('partial-')) continue;

    // Extract text and skip if no meaningful text
    const text = extractAssistantText(msg);
    if (text === null) continue;

    textMessages.push({ id: msg.id, text });
  }

  if (textMessages.length === 0) return [];
  if (textMessages.length === 1) return [textMessages[0]];

  // Return first and last (deduplicated if same)
  const first = textMessages[0];
  const last = textMessages[textMessages.length - 1];
  if (first.id === last.id) return [first];
  return [first, last];
}

/**
 * Check if a user-type message is a tool result (not a user-sent prompt).
 * Tool result messages have content blocks with type 'tool_result'.
 */
function isToolResultMessage(msg: AutoReadMessage): boolean {
  const content = msg.content as Record<string, unknown> | undefined;
  const innerMsg = content?.message as Record<string, unknown> | undefined;
  const blocks = innerMsg?.content;
  if (!Array.isArray(blocks)) return false;
  return blocks.some((b: Record<string, unknown>) => b.type === 'tool_result');
}

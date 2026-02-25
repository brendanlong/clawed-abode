/**
 * Pure helper functions for auto-read voice feature.
 * Finds new assistant text messages during a turn for streaming TTS playback,
 * so users hear responses as they arrive instead of waiting for turn completion.
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
 * Given all messages in a session, find new assistant text messages from the
 * current turn that haven't been queued for playback yet.
 *
 * Used during a turn (while Claude is running) to stream TTS as messages arrive,
 * rather than waiting for the entire turn to complete.
 *
 * @param messages All messages in the session
 * @param queuedIds Set of message IDs that have already been queued for playback
 * @returns Array of new TextMessageForPlayback items to enqueue
 */
export function getNewAutoReadMessages(
  messages: AutoReadMessage[],
  queuedIds: ReadonlySet<string>
): TextMessageForPlayback[] {
  // Find the last user-sent prompt to identify the turn boundary
  let turnStartIndex = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'user' && !isToolResultMessage(msg)) {
      turnStartIndex = i + 1;
      break;
    }
  }

  const newMessages: TextMessageForPlayback[] = [];
  for (let i = turnStartIndex; i < messages.length; i++) {
    const msg = messages[i];

    // Skip non-assistant messages
    if (msg.type !== 'assistant') continue;

    // Skip partial messages
    if (msg.id.startsWith('partial-')) continue;

    // Skip already-queued messages
    if (queuedIds.has(msg.id)) continue;

    // Extract text and skip if no meaningful text
    const text = extractAssistantText(msg);
    if (text === null) continue;

    newMessages.push({ id: msg.id, text });
  }

  return newMessages;
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

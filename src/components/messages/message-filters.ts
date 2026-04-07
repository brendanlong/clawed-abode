import type { MessageContent, ContentBlock } from './types';

interface Message {
  id: string;
  type: string;
  content: unknown;
  sequence: number;
}

/**
 * Get parent_tool_use_id from message content (identifies subagent messages).
 */
export function getParentToolUseId(message: Message): string | null {
  const content = message.content as MessageContent | undefined;
  const id = content?.parent_tool_use_id;
  return typeof id === 'string' ? id : null;
}

/**
 * Check if a message is a "noise" system message that should be hidden.
 * Hides init, compact_boundary, and hook_response (the response data is not useful on its own).
 * Keeps systemError, hook_started (pending hooks show loading), and unknown subtypes visible.
 */
export function isHiddenSystemMessage(message: Message): boolean {
  if (message.type !== 'system') return false;
  const content = message.content as MessageContent | undefined;
  const subtype = content?.subtype;
  return subtype === 'init' || subtype === 'compact_boundary' || subtype === 'hook_response';
}

/**
 * Check if an assistant message contains ONLY tool calls (no text).
 */
export function isToolOnlyAssistant(message: Message): boolean {
  if (message.type !== 'assistant') return false;
  const content = message.content as MessageContent | undefined;
  const blocks = content?.message?.content;
  if (!Array.isArray(blocks) || blocks.length === 0) return false;
  return blocks.every((b) => (b as ContentBlock).type === 'tool_use');
}

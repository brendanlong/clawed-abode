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
 * Get the tool_use_id from a task-related system message (task_started, task_progress).
 * These messages belong to a Task tool call and should be grouped with it rather than
 * displayed as standalone system messages.
 * Returns null for non-task system messages.
 */
export function getTaskToolUseId(message: Message): string | null {
  if (message.type !== 'system') return null;
  const content = message.content as MessageContent | undefined;
  const subtype = content?.subtype;
  if (subtype !== 'task_started' && subtype !== 'task_progress') return null;
  const toolUseId = content?.tool_use_id;
  return typeof toolUseId === 'string' ? toolUseId : null;
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

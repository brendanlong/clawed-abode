import { summarizeToolResult } from '@/lib/tool-result';
import type { ToolResult } from '@/components/messages/types';

/** A tool result whose body arrived inline, as the server sends results of up to 1 KB. */
export function inlineResult(text: string, is_error?: boolean): ToolResult {
  return { messageId: 'result-message', is_error, summary: summarizeToolResult(text), text };
}

/** A tool result whose body the server elided, leaving its summary. */
export function elidedResult(text: string, messageId = 'result-message'): ToolResult {
  return { messageId, summary: summarizeToolResult(text) };
}

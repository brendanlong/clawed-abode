import type { ContentBlock, MessageContent, ToolCall, ToolResultMap } from './types';
import { formatAsJson, buildToolMessages } from './types';

/**
 * Strip XML wrapper tags from Claude Code local command output.
 * Messages from slash commands like /context are wrapped in tags like
 * <local-command-stdout>...</local-command-stdout>.
 */
function stripXmlTags(text: string): string {
  return text.replace(/^<local-command-stdout>\n?/, '').replace(/\n?<\/local-command-stdout>$/, '');
}

export type MessageCategory =
  | 'assistant'
  | 'user'
  | 'userInterrupt'
  | 'toolResult'
  | 'system'
  | 'systemInit'
  | 'systemError'
  | 'systemCompactBoundary'
  | 'hookStarted'
  | 'hookResponse'
  | 'result';

export type RecognitionResult =
  | { recognized: true; category: MessageCategory }
  | { recognized: false };

/**
 * Extract text content from message content blocks.
 * For user/assistant messages, returns the raw markdown text.
 */
export function extractTextContent(content: MessageContent): string | null {
  // For assistant messages, extract text from content.message.content
  if (content.message?.content && Array.isArray(content.message.content)) {
    const textBlocks = content.message.content
      .filter(
        (block): block is ContentBlock => block.type === 'text' && typeof block.text === 'string'
      )
      .map((block) => block.text!);
    if (textBlocks.length > 0) {
      return textBlocks.join('\n');
    }
  }
  // For messages with string content in message.content (e.g., /context command output)
  if (typeof content.message?.content === 'string') {
    return stripXmlTags(content.message.content);
  }
  // For simple content strings
  if (typeof content.content === 'string') {
    return content.content;
  }
  return null;
}

/**
 * Check if a message is a tool result (comes as type "user" but contains tool_result content).
 */
export function isToolResultMessage(content: MessageContent): boolean {
  const innerContent = content.message?.content;
  if (Array.isArray(innerContent)) {
    return innerContent.some((block) => block.type === 'tool_result');
  }
  return false;
}

/**
 * Extract tool result blocks from a message.
 */
export function getToolResults(content: MessageContent): ContentBlock[] {
  const innerContent = content.message?.content;
  if (Array.isArray(innerContent)) {
    return innerContent.filter((block) => block.type === 'tool_result');
  }
  return [];
}

/**
 * Whether an assistant message has any content worth rendering. Filters out
 * fragments whose blocks would all render to nothing — e.g. a `thinking` block
 * with empty `thinking` text (just a continuity signature) and nothing else,
 * which would otherwise show as an empty assistant bubble.
 *
 * Keep the renderable cases in sync with `ContentRenderer.renderContentBlocks`.
 */
export function hasRenderableAssistantContent(content: MessageContent): boolean {
  const blocks = content?.message?.content;
  // Non-array content (e.g. a string) is handled by other display paths.
  if (!Array.isArray(blocks)) return true;
  return blocks.some((block) => {
    switch (block?.type) {
      case 'text':
        return typeof block.text === 'string' && block.text.trim().length > 0;
      case 'thinking':
        return typeof block.thinking === 'string' && block.thinking.trim().length > 0;
      case 'tool_use':
      case 'redacted_thinking':
        return true;
      default:
        return false;
    }
  });
}

/**
 * Check if a message can be recognized and displayed with our typed components.
 * Returns the message category if recognized, or { recognized: false } for unknown types.
 */
export function isRecognizedMessage(type: string, content: MessageContent): RecognitionResult {
  // Assistant messages must have a valid message.content array
  if (type === 'assistant') {
    if (!content.message || !Array.isArray(content.message.content)) {
      return { recognized: false };
    }
    return { recognized: true, category: 'assistant' };
  }

  // User messages that are tool results
  if (type === 'user' && isToolResultMessage(content)) {
    return { recognized: true, category: 'toolResult' };
  }

  // User interrupt messages
  if (type === 'user' && content.subtype === 'interrupt') {
    return { recognized: true, category: 'userInterrupt' };
  }

  // Regular user messages (prompts) must have text content
  if (type === 'user') {
    // User prompts typically have message.content with text blocks
    if (content.message?.content && Array.isArray(content.message.content)) {
      return { recognized: true, category: 'user' };
    }
    // Or message.content as a string (e.g., /context command output)
    if (typeof content.message?.content === 'string') {
      return { recognized: true, category: 'user' };
    }
    // Or simple content string
    if (typeof content.content === 'string') {
      return { recognized: true, category: 'user' };
    }
    return { recognized: false };
  }

  // System init messages
  if (type === 'system' && content.subtype === 'init') {
    if (content.model && content.session_id) {
      return { recognized: true, category: 'systemInit' };
    }
    return { recognized: false };
  }

  // System error messages
  if (type === 'system' && content.subtype === 'error') {
    if (Array.isArray(content.content)) {
      return { recognized: true, category: 'systemError' };
    }
    return { recognized: false };
  }

  // Compact boundary messages
  if (type === 'system' && content.subtype === 'compact_boundary') {
    return { recognized: true, category: 'systemCompactBoundary' };
  }

  // Hook started messages (pending hooks show loading state)
  if (type === 'system' && content.subtype === 'hook_started') {
    return { recognized: true, category: 'hookStarted' };
  }

  // Hook response messages
  if (type === 'system' && content.subtype === 'hook_response') {
    return { recognized: true, category: 'hookResponse' };
  }

  // Other system messages
  if (type === 'system') {
    return { recognized: true, category: 'system' };
  }

  // Result messages
  if (type === 'result') {
    if (content.subtype && typeof content.session_id === 'string') {
      return { recognized: true, category: 'result' };
    }
    return { recognized: false };
  }

  // Unknown type
  return { recognized: false };
}

/**
 * A concise, human-readable summary of a generic system message, used so these
 * messages render meaningful content instead of an empty "System" bubble.
 */
export interface SystemMessageSummary {
  /** Short label shown as a badge (e.g. "Retrying request"). */
  label: string;
  /** Optional detail line. Absent when the subtype carries no extra text. */
  body?: string;
  /** Drives styling — `warn` for retries/denials/errors. */
  level: 'info' | 'warn';
}

/** Turn a snake_case subtype into a Title Case label (fallback for unknowns). */
function humanizeSubtype(subtype: string | undefined): string {
  if (!subtype) return 'System';
  return subtype
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Pull a readable message out of an SDK error value (string or {message}). */
function extractErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  return undefined;
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Summarize a generic `system` message (any subtype not handled by a dedicated
 * display). Known subtypes get a tailored summary; unknown/future ones fall back
 * to a humanized label plus any string `content`, so a system message is never
 * rendered blank.
 */
export function summarizeSystemMessage(content: MessageContent): SystemMessageSummary {
  switch (content.subtype) {
    case 'notification': {
      const priority = content.priority;
      return {
        label: 'Notification',
        body: asString(content.text),
        level: priority === 'high' || priority === 'immediate' ? 'warn' : 'info',
      };
    }
    case 'permission_denied': {
      const tool = asString(content.tool_name) ?? 'tool';
      const message = asString(content.message);
      return {
        label: 'Permission denied',
        body: message ? `${tool}: ${message}` : tool,
        level: 'warn',
      };
    }
    case 'model_refusal_fallback': {
      const from = asString(content.original_model) ?? '?';
      const to = asString(content.fallback_model) ?? '?';
      const why = asString(content.api_refusal_explanation);
      return {
        label: 'Model switched after refusal',
        body: `${from} → ${to}${why ? ` — ${why}` : ''}`,
        level: 'warn',
      };
    }
    case 'plugin_install': {
      const name = asString(content.name);
      const status = asString(content.status) ?? 'unknown';
      const error = extractErrorMessage(content.error);
      return {
        label: name ? `Plugin: ${name}` : 'Plugin install',
        body: error ? `${status} — ${error}` : status,
        level: status === 'failed' ? 'warn' : 'info',
      };
    }
    case 'memory_recall': {
      const count = Array.isArray(content.memories) ? content.memories.length : 0;
      const mode = asString(content.mode) ?? 'select';
      return { label: 'Recalled memories', body: `${count} (${mode})`, level: 'info' };
    }
    case 'mirror_error':
      return { label: 'Mirror error', body: extractErrorMessage(content.error), level: 'warn' };
    case 'task_started': {
      const description = asString(content.description);
      const agent = asString(content.subagent_type);
      return {
        label: 'Subagent started',
        body: [agent, description].filter(Boolean).join(': ') || undefined,
        level: 'info',
      };
    }
    case 'task_notification': {
      const status = asString(content.status) ?? 'completed';
      return {
        label: `Subagent ${status}`,
        body: asString(content.summary),
        level: status === 'failed' ? 'warn' : 'info',
      };
    }
    case 'local_command_output':
      return {
        label: 'Command output',
        body: typeof content.content === 'string' ? stripXmlTags(content.content) : undefined,
        level: 'info',
      };
    default:
      return {
        // Fall back to the message `type` when there is no subtype, so top-level
        // types persisted as system (e.g. prompt_suggestion) get a real label.
        label: humanizeSubtype(content.subtype ?? asString(content.type)),
        body: asString(content.content),
        level: 'info',
      };
  }
}

/**
 * Build tool call objects with results for assistant messages.
 */
export function buildToolCalls(content: MessageContent, toolResults?: ToolResultMap): ToolCall[] {
  const messageContent = content.message?.content;
  if (!Array.isArray(messageContent)) return [];

  const toolUseBlocks = messageContent.filter(
    (block): block is ContentBlock => block.type === 'tool_use'
  );

  return toolUseBlocks.map((block) => {
    const result = block.id ? toolResults?.get(block.id) : undefined;
    return {
      name: block.name || 'Unknown',
      id: block.id,
      input: block.input,
      output: result?.content,
      is_error: result?.is_error,
    };
  });
}

/**
 * Get the text to copy for a message.
 */
export function getCopyText(
  content: MessageContent,
  category: MessageCategory | null,
  toolCalls: ToolCall[]
): string {
  if (category === 'user') {
    const text = extractTextContent(content);
    return text ?? formatAsJson(content);
  }
  if (category === 'assistant') {
    const text = extractTextContent(content);
    if (toolCalls.length > 0) {
      const parts: string[] = [];
      if (text) {
        parts.push(text);
      }
      for (const tool of toolCalls) {
        const toolMessages = buildToolMessages(tool);
        parts.push(formatAsJson(toolMessages));
      }
      return parts.join('\n\n');
    }
    return text ?? formatAsJson(content);
  }
  return formatAsJson(content);
}

/**
 * Get the display content for a message based on its category.
 * For assistant messages, content is in content.message.content.
 * For user/system messages, content is in content.content.
 */
export function getDisplayContent(
  content: MessageContent,
  category: MessageCategory | null
): unknown {
  if (category === 'assistant' && content.message?.content) {
    return content.message.content;
  }
  // For user messages with string content in message.content (e.g., /context command output)
  if (category === 'user' && typeof content.message?.content === 'string') {
    return stripXmlTags(content.message.content);
  }
  return content.content;
}

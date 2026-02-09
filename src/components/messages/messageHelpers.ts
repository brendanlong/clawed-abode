import type { ContentBlock, MessageContent, ToolCall, ToolResultMap } from './types';
import { formatAsJson, buildToolMessages } from './types';

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
  return content.content;
}
